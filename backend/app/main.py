from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import List, Optional, Literal

import numpy as np
import requests
from docx import Document
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from lxml import html as lxml_html
from pydantic import BaseModel
from pypdf import PdfReader
from dotenv import load_dotenv
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

try:
    from openai import OpenAI
except Exception:
    OpenAI = None

try:
    from anthropic import Anthropic
except Exception:
    Anthropic = None

try:
    from faster_whisper import WhisperModel
except Exception:
    WhisperModel = None

_LOCAL_WHISPER_MODEL = None
_LOCAL_WHISPER_LOCK = threading.Lock()

def local_whisper_available() -> bool:
    return WhisperModel is not None

def get_local_whisper_model():
    global _LOCAL_WHISPER_MODEL
    if WhisperModel is None:
        raise RuntimeError("Local Whisper is not installed")
    with _LOCAL_WHISPER_LOCK:
        if _LOCAL_WHISPER_MODEL is None:
            model_name = os.getenv("LOCAL_WHISPER_MODEL", "base.en")
            _LOCAL_WHISPER_MODEL = WhisperModel(model_name, device="cpu", compute_type="int8")
    return _LOCAL_WHISPER_MODEL

def transcribe_local(path: Path) -> str:
    model = get_local_whisper_model()
    segments, _info = model.transcribe(str(path), vad_filter=True, beam_size=1)
    return " ".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()

BASE_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BASE_DIR / "backend" / ".env")
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "copilot.db"
DEMO_DIR = BASE_DIR / "knowledge" / "demo"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

APP_VERSION = "4.3.0"
app = FastAPI(title="AI Call Copilot API", version=APP_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# When deployed somewhere reachable beyond localhost, BACKEND_ACCESS_TOKEN gates
# every request behind a shared app key so the (billed) LLM provider and the
# Confluence-sourced knowledge base aren't left open on the public internet.
# Unset (the local-dev default) means no gate, matching prior behavior.
BACKEND_ACCESS_TOKEN = os.getenv("BACKEND_ACCESS_TOKEN", "").strip()


@app.middleware("http")
async def require_access_token(request, call_next):
    if BACKEND_ACCESS_TOKEN and request.method != "OPTIONS" and request.url.path != "/health":
        if request.headers.get("x-callpilot-key", "") != BACKEND_ACCESS_TOKEN:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


# Confluence/web syncs can take minutes on a large space or docs site, which
# blows past hosting-platform proxy timeouts (e.g. Render's) if run inline on
# the request. Both run in a background thread instead; the sync endpoints
# return immediately and the status endpoints report SYNC_STATE for polling.
SYNC_STATE = {
    "confluence": {"running": False, "error": None},
    "web": {"running": False, "error": None},
}
SYNC_LOCK = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                path TEXT NOT NULL,
                source_type TEXT DEFAULT 'upload',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY(document_id) REFERENCES documents(id)
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                customer TEXT,
                call_type TEXT,
                context TEXT,
                transcript TEXT DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS confluence_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                base_url TEXT NOT NULL,
                email TEXT NOT NULL,
                api_token TEXT NOT NULL,
                space_key TEXT NOT NULL,
                space_name TEXT,
                last_synced_at DATETIME,
                last_synced_pages INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS web_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                label TEXT NOT NULL,
                sitemap_url TEXT NOT NULL,
                path_prefix TEXT NOT NULL,
                last_synced_at DATETIME,
                last_synced_pages INTEGER DEFAULT 0
            );
            """
        )
        # Lightweight migration for databases created by v0.1.
        columns = {r[1] for r in conn.execute("PRAGMA table_info(documents)").fetchall()}
        if "source_type" not in columns:
            conn.execute("ALTER TABLE documents ADD COLUMN source_type TEXT DEFAULT 'upload'")
        conn.commit()


init_db()


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        reader = PdfReader(str(path))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    if suffix == ".docx":
        doc = Document(str(path))
        return "\n".join(p.text for p in doc.paragraphs)
    if suffix in {".txt", ".md", ".markdown"}:
        return path.read_text(encoding="utf-8", errors="ignore")
    raise ValueError("Unsupported file type. Use PDF, DOCX, TXT, or Markdown.")


def chunk_text(text: str, max_chars: int = 1100, overlap: int = 160) -> List[str]:
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: List[str] = []
    current = ""
    for para in paragraphs:
        candidate = f"{current}\n\n{para}".strip()
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
        if len(para) <= max_chars:
            current = para
        else:
            start = 0
            while start < len(para):
                end = start + max_chars
                chunks.append(para[start:end])
                start = max(end - overlap, start + 1)
            current = ""
    if current:
        chunks.append(current)

    result: List[str] = []
    prev_tail = ""
    for chunk in chunks:
        merged = f"{prev_tail}\n{chunk}".strip() if prev_tail else chunk
        if len(merged.strip()) > 30:
            result.append(merged)
        prev_tail = chunk[-overlap:]
    return result


def index_file(path: Path, filename: str, source_type: str = "upload") -> dict:
    text = extract_text(path)
    chunks = chunk_text(text)
    if not chunks:
        raise ValueError("No readable text found in document")
    doc_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, path, source_type) VALUES (?, ?, ?, ?)",
            (doc_id, filename, str(path), source_type),
        )
        conn.executemany(
            "INSERT INTO chunks (id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)",
            [(str(uuid.uuid4()), doc_id, i, c) for i, c in enumerate(chunks)],
        )
        conn.commit()
    return {"id": doc_id, "filename": filename, "chunks": len(chunks), "source_type": source_type}


def get_confluence_config() -> Optional[dict]:
    with db() as conn:
        row = conn.execute("SELECT * FROM confluence_config WHERE id=1").fetchone()
    if row:
        return dict(row)
    base_url = os.getenv("CONFLUENCE_BASE_URL")
    email = os.getenv("CONFLUENCE_EMAIL")
    api_token = os.getenv("CONFLUENCE_API_TOKEN")
    space_key = os.getenv("CONFLUENCE_SPACE_KEY")
    if base_url and email and api_token and space_key:
        return {
            "base_url": base_url.rstrip("/"), "email": email, "api_token": api_token, "space_key": space_key,
            "space_name": None, "last_synced_at": None, "last_synced_pages": 0,
        }
    return None


def confluence_api_get(base_url: str, email: str, api_token: str, path: str, params: Optional[dict] = None) -> dict:
    if path.startswith("http"):
        url = path
    elif path.startswith("/wiki/api/v2"):
        url = f"{base_url.rstrip('/')}{path}"
    else:
        url = f"{base_url.rstrip('/')}/wiki/api/v2{path}"
    resp = requests.get(url, params=params, auth=(email, api_token), headers={"Accept": "application/json"}, timeout=20)
    if resp.status_code == 401:
        raise ValueError("Confluence rejected the email/API token (401 Unauthorized).")
    if resp.status_code == 403:
        raise ValueError("This Confluence account does not have access to that space (403 Forbidden).")
    if resp.status_code == 404:
        raise ValueError("Confluence space not found. Check the site URL and space key.")
    resp.raise_for_status()
    return resp.json()


def confluence_find_space(base_url: str, email: str, api_token: str, space_key: str) -> dict:
    data = confluence_api_get(base_url, email, api_token, "/spaces", {"keys": space_key, "limit": 1})
    results = data.get("results") or []
    if not results:
        raise ValueError(f"No space found with key '{space_key}'.")
    return results[0]


def confluence_fetch_pages(base_url: str, email: str, api_token: str, space_id: str) -> List[dict]:
    pages: List[dict] = []
    path = f"/spaces/{space_id}/pages"
    params: Optional[dict] = {"body-format": "storage", "limit": 100, "status": "current"}
    while True:
        data = confluence_api_get(base_url, email, api_token, path, params)
        pages.extend(data.get("results") or [])
        next_link = (data.get("_links") or {}).get("next")
        if not next_link:
            break
        path, params = next_link, None
    return pages


def html_to_text(raw_html: str) -> str:
    if not raw_html or not raw_html.strip():
        return ""
    try:
        text = lxml_html.fromstring(f"<div>{raw_html}</div>").text_content()
    except Exception:
        text = re.sub(r"<[^>]+>", " ", raw_html)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def index_confluence_page(page: dict, base_url: str, space_key: str) -> Optional[dict]:
    title = page.get("title") or "Untitled page"
    body = ((page.get("body") or {}).get("storage") or {}).get("value") or ""
    text = html_to_text(body)
    if not text:
        return None
    chunks = chunk_text(f"{title}\n\n{text}")
    if not chunks:
        return None
    webui = ((page.get("_links") or {}).get("webui")) or ""
    page_url = f"{base_url.rstrip('/')}/wiki{webui}" if webui and not webui.startswith("http") else (webui or base_url)
    doc_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, path, source_type) VALUES (?, ?, ?, ?)",
            (doc_id, f"[{space_key}] {title}", page_url, "confluence"),
        )
        conn.executemany(
            "INSERT INTO chunks (id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)",
            [(str(uuid.uuid4()), doc_id, i, c) for i, c in enumerate(chunks)],
        )
        conn.commit()
    return {"id": doc_id, "filename": title, "chunks": len(chunks)}


def clear_confluence_documents() -> None:
    with db() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM documents WHERE source_type='confluence'").fetchall()]
        for did in ids:
            conn.execute("DELETE FROM chunks WHERE document_id=?", (did,))
            conn.execute("DELETE FROM documents WHERE id=?", (did,))
        conn.commit()


WEB_USER_AGENT = "CallPilotBot/1.0 (+internal sales-engineering knowledge sync)"
MAX_WEB_PAGES = 600


def get_web_config() -> Optional[dict]:
    with db() as conn:
        row = conn.execute("SELECT * FROM web_config WHERE id=1").fetchone()
    if row:
        return dict(row)
    sitemap_url = os.getenv("WEB_SITEMAP_URL")
    path_prefix = os.getenv("WEB_PATH_PREFIX")
    if sitemap_url and path_prefix:
        return {
            "label": os.getenv("WEB_LABEL", "Docs"), "sitemap_url": sitemap_url, "path_prefix": path_prefix,
            "last_synced_at": None, "last_synced_pages": 0,
        }
    return None


def fetch_sitemap_urls(sitemap_url: str, path_prefix: str, timeout: int = 20) -> List[str]:
    resp = requests.get(sitemap_url, headers={"User-Agent": WEB_USER_AGENT}, timeout=timeout)
    resp.raise_for_status()
    locs = re.findall(r"<loc>\s*(.*?)\s*</loc>", resp.text)
    return [u for u in locs if path_prefix in u]


def fetch_web_page_text(url: str, timeout: int = 20) -> tuple[str, str]:
    resp = requests.get(url, headers={"User-Agent": WEB_USER_AGENT}, timeout=timeout)
    resp.raise_for_status()
    tree = lxml_html.fromstring(resp.content)
    # Grab the title before stripping noise — a doc's own <h1> is often
    # wrapped in a semantic <header> used for the title block, not site nav,
    # so stripping headers first would take the real title down with it.
    h1 = tree.xpath("//h1")
    title = h1[0].text_content().strip() if h1 else ""
    if not title:
        title_tag = tree.xpath("//title/text()")
        title = title_tag[0].strip() if title_tag else url
    for bad in tree.xpath(
        '//script | //style | //nav | //footer | //header '
        '| //*[contains(@class,"toc")] | //*[contains(@class,"sidebar")] | //*[contains(@class,"breadcrumb")]'
    ):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)
    candidates = (
        tree.xpath('//*[contains(@class,"theme-doc-markdown")]')
        or tree.xpath("//article")
        or tree.xpath("//main")
    )
    node = candidates[0] if candidates else tree
    text = node.text_content()
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return title, text.strip()


def index_web_page(url: str, label: str) -> Optional[dict]:
    try:
        title, text = fetch_web_page_text(url)
    except Exception:
        return None
    if not text or len(text) < 40:
        return None
    chunks = chunk_text(f"{title}\n\n{text}")
    if not chunks:
        return None
    doc_id = str(uuid.uuid4())
    with db() as conn:
        conn.execute(
            "INSERT INTO documents (id, filename, path, source_type) VALUES (?, ?, ?, ?)",
            (doc_id, f"[{label}] {title}", url, "web"),
        )
        conn.executemany(
            "INSERT INTO chunks (id, document_id, chunk_index, content) VALUES (?, ?, ?, ?)",
            [(str(uuid.uuid4()), doc_id, i, c) for i, c in enumerate(chunks)],
        )
        conn.commit()
    return {"id": doc_id, "filename": title, "chunks": len(chunks)}


def clear_web_documents() -> None:
    with db() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM documents WHERE source_type='web'").fetchall()]
        for did in ids:
            conn.execute("DELETE FROM chunks WHERE document_id=?", (did,))
            conn.execute("DELETE FROM documents WHERE id=?", (did,))
        conn.commit()


def seed_demo_data(force: bool = False) -> int:
    if not DEMO_DIR.exists():
        return 0
    with db() as conn:
        existing = conn.execute("SELECT COUNT(*) AS c FROM documents WHERE source_type='demo'").fetchone()["c"]
        other = conn.execute("SELECT COUNT(*) AS c FROM documents WHERE source_type!='demo'").fetchone()["c"]
    # Once real content exists (an upload, or a connected Confluence sync), stop
    # auto-seeding the fictional Nimbus demo docs on every startup. `force=True`
    # (the sidebar's "Reset demo data" button) still works either way.
    if not force and (existing or other):
        return 0
    if force:
        with db() as conn:
            ids = [r["id"] for r in conn.execute("SELECT id FROM documents WHERE source_type='demo'").fetchall()]
            for did in ids:
                conn.execute("DELETE FROM chunks WHERE document_id=?", (did,))
                conn.execute("DELETE FROM documents WHERE id=?", (did,))
            conn.commit()
    count = 0
    for path in sorted(DEMO_DIR.glob("*")):
        if path.suffix.lower() in {".md", ".txt", ".pdf", ".docx"}:
            index_file(path, path.name, "demo")
            count += 1
    return count


seed_demo_data()


class AskRequest(BaseModel):
    question: str
    top_k: int = 5
    call_context: Optional[str] = None
    provider: Literal["auto", "openai", "claude", "demo"] = "auto"
    answer_style: Literal["short", "detailed", "technical"] = "short"


class Source(BaseModel):
    document_id: str
    filename: str
    chunk_index: int
    score: float
    excerpt: str
    url: Optional[str] = None


class AskResponse(BaseModel):
    answer: str
    confidence: float
    sources: List[Source]
    follow_up: Optional[str] = None
    mode: str
    provider: str
    question: str


class DetectRequest(BaseModel):
    transcript: str
    provider: Literal["auto", "openai", "claude", "demo"] = "auto"


class SessionRequest(BaseModel):
    customer: str = "Demo Customer"
    call_type: str = "Discovery"
    context: str = ""


class TranscriptRequest(BaseModel):
    text: str


class ConfluenceConnectRequest(BaseModel):
    base_url: str
    email: str
    api_token: str
    space_key: str


class ConfluenceStatus(BaseModel):
    connected: bool
    base_url: Optional[str] = None
    email: Optional[str] = None
    space_key: Optional[str] = None
    space_name: Optional[str] = None
    last_synced_at: Optional[str] = None
    last_synced_pages: int = 0
    syncing: bool = False
    last_error: Optional[str] = None


class WebConnectRequest(BaseModel):
    sitemap_url: str
    path_prefix: str
    label: str = "Docs"


class WebStatus(BaseModel):
    connected: bool
    label: Optional[str] = None
    sitemap_url: Optional[str] = None
    path_prefix: Optional[str] = None
    last_synced_at: Optional[str] = None
    last_synced_pages: int = 0
    syncing: bool = False
    last_error: Optional[str] = None


class OverlayPushRequest(BaseModel):
    question: str
    answer: str
    confidence: float = 0.0
    source: Optional[str] = None
    follow_up: Optional[str] = None

OVERLAY_STATE = {
    "visible": False,
    "question": "",
    "answer": "CallPilot private overlay is ready.",
    "confidence": 0.0,
    "source": None,
    "follow_up": None,
}


def provider_status() -> dict:
    return {
        "openai": bool(os.getenv("OPENAI_API_KEY") and OpenAI is not None),
        "claude": bool(os.getenv("ANTHROPIC_API_KEY") and Anthropic is not None),
        "demo": True,
        "openai_model": os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        "claude_model": os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
        "transcription_model": os.getenv("TRANSCRIPTION_PROVIDER", "local"),
        "local_transcription": local_whisper_available(),
        "local_whisper_model": os.getenv("LOCAL_WHISPER_MODEL", "base.en"),
    }


def resolve_provider(requested: str) -> str:
    status = provider_status()
    if requested == "openai" and status["openai"]:
        return "openai"
    if requested == "claude" and status["claude"]:
        return "claude"
    if requested == "demo":
        return "demo"
    if requested == "auto":
        if status["openai"]:
            return "openai"
        if status["claude"]:
            return "claude"
        return "demo"
    return "demo"


def retrieve(question: str, top_k: int = 5) -> List[dict]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT c.document_id, c.chunk_index, c.content, d.filename, d.path, d.source_type
            FROM chunks c JOIN documents d ON d.id = c.document_id
            ORDER BY d.created_at DESC, c.chunk_index ASC
            """
        ).fetchall()
    if not rows:
        return []
    corpus = [r["content"] for r in rows]
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=40000, sublinear_tf=True)
    matrix = vectorizer.fit_transform(corpus + [question])
    scores = cosine_similarity(matrix[-1], matrix[:-1]).flatten()
    ranked = np.argsort(scores)[::-1][: max(1, min(top_k, len(rows)))]
    return [
        {
            "document_id": rows[int(i)]["document_id"],
            "filename": rows[int(i)]["filename"],
            "chunk_index": rows[int(i)]["chunk_index"],
            "content": rows[int(i)]["content"],
            "score": float(scores[int(i)]),
            "url": rows[int(i)]["path"] if rows[int(i)]["source_type"] in ("confluence", "web") else None,
        }
        for i in ranked
    ]


def demo_answer(question: str, results: List[dict], style: str) -> tuple[str, Optional[str]]:
    if not results or results[0]["score"] < 0.035:
        return "I couldn't verify that from the current knowledge base.", "Should I capture this as a follow-up item for the product team?"
    content = results[0]["content"].strip()
    # Lightweight extractive answer for zero-key demo mode.
    sentences = re.split(r"(?<=[.!?])\s+", re.sub(r"#+\s*", "", content))
    q_terms = {w.lower() for w in re.findall(r"[A-Za-z0-9-]{3,}", question)}
    ranked = sorted(sentences, key=lambda s: sum(1 for w in q_terms if w in s.lower()), reverse=True)
    n = {"short": 2, "detailed": 4, "technical": 5}.get(style, 2)
    selected = [s.strip() for s in ranked[:n] if s.strip()]
    answer = " ".join(selected)
    if not answer:
        answer = content[:700]
    return answer[:1600], "Would you like me to go deeper on the implementation or integration details?"


def build_prompt(question: str, results: List[dict], call_context: Optional[str], style: str) -> tuple[str, str]:
    context = "\n\n".join(
        f"SOURCE {i+1}: {r['filename']} (chunk {r['chunk_index']})\n{r['content']}"
        for i, r in enumerate(results)
    )
    style_instruction = {
        "short": "Keep the answer to 2-4 short sentences suitable for speaking live.",
        "detailed": "Give a concise but complete answer in 1-3 short paragraphs.",
        "technical": "Give a technical answer with concrete implementation details, constraints, and terminology while remaining concise.",
    }[style]
    system = (
        "You are a real-time B2B Solutions Engineer call copilot. Answer ONLY from the supplied knowledge-base excerpts. "
        "Never invent product capabilities, limits, pricing, compliance claims, or integrations. If the evidence is insufficient, say exactly that. "
        "Start with the direct answer. Do not mention that you are an AI. " + style_instruction + " "
        "End with exactly one useful next question on a new line prefixed FOLLOW_UP:."
    )
    user = f"CALL CONTEXT:\n{call_context or 'Not provided'}\n\nCUSTOMER QUESTION:\n{question}\n\nKNOWLEDGE BASE:\n{context}"
    return system, user


def llm_answer(question: str, results: List[dict], call_context: Optional[str], requested_provider: str, style: str) -> tuple[str, Optional[str], str]:
    provider = resolve_provider(requested_provider)
    if provider == "demo":
        answer, follow = demo_answer(question, results, style)
        return answer, follow, provider

    system, user = build_prompt(question, results, call_context, style)
    try:
        if provider == "openai":
            client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
                temperature=0.1,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            )
            text = (resp.choices[0].message.content or "").strip()
        else:
            client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
            resp = client.messages.create(
                model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
                max_tokens=900,
                temperature=0.1,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text").strip()
    except Exception:
        # A live call can't wait on a provider outage/bad model/rate limit — fall
        # back to the always-available extractive answer instead of a hard 500.
        answer, follow = demo_answer(question, results, style)
        return answer, follow, "demo"

    follow = None
    if "FOLLOW_UP:" in text:
        text, follow = text.split("FOLLOW_UP:", 1)
        text, follow = text.strip(), follow.strip()
    return text, follow, provider


def heuristic_question(transcript: str) -> Optional[str]:
    cleaned = re.sub(r"\s+", " ", transcript.strip())
    if not cleaned:
        return None
    # Prefer the last explicit question.
    parts = re.findall(r"(?:^|(?<=[.!]))\s*([^?]{3,220}\?)", cleaned)
    if parts:
        return parts[-1].strip()
    tail = cleaned[-500:]
    cues = ["can you", "could you", "do you", "does it", "is there", "how do", "how does", "what is", "what are", "where", "when", "why", "which"]
    low = tail.lower()
    hits = [(low.rfind(c), c) for c in cues if low.rfind(c) >= 0]
    if hits:
        pos, _ = max(hits)
        q = tail[pos:].strip()
        q = re.split(r"[\n.]", q)[0].strip()
        return q + ("" if q.endswith("?") else "?")
    return None


def llm_detect_question(transcript: str, provider: str) -> tuple[bool, Optional[str]]:
    """Ask the LLM to spot a customer question in a transcript tail.

    Returns (ok, question). ok=False means the call itself failed (bad key,
    network, rate limit) and the caller should fall back to the keyword
    heuristic; ok=True with question=None means the model looked and found
    no clear question, which the caller should trust as-is.
    """
    system = (
        "You read a rolling transcript of a live sales call (may contain transcription errors and no punctuation). "
        "Find the customer's most recent, clearly-asked question — a real ask, not small talk or the rep talking. "
        "Reply with ONLY that question, cleaned up and ending in '?'. "
        "If there is no clear customer question, reply with exactly: NONE"
    )
    user = f"TRANSCRIPT (most recent last):\n{transcript.strip()[-3000:]}"
    try:
        if provider == "openai":
            client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            resp = client.chat.completions.create(
                model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
                temperature=0, max_tokens=80,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            )
            text = (resp.choices[0].message.content or "").strip()
        else:
            client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
            resp = client.messages.create(
                model=os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
                max_tokens=80, temperature=0,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
            text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text").strip()
    except Exception:
        return False, None
    if not text or text.strip().upper().startswith("NONE"):
        return True, None
    return True, text.strip()


@app.get("/health")
def health():
    with db() as conn:
        docs = conn.execute("SELECT COUNT(*) AS c FROM documents").fetchone()["c"]
        chunks = conn.execute("SELECT COUNT(*) AS c FROM chunks").fetchone()["c"]
    return {"status": "ok", "version": APP_VERSION, "documents": docs, "chunks": chunks, "providers": provider_status()}


@app.get("/settings/providers")
def settings_providers():
    return provider_status()


@app.get("/documents")
def list_documents():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT d.id, d.filename, d.source_type, d.created_at, d.path, COUNT(c.id) AS chunks
            FROM documents d LEFT JOIN chunks c ON c.document_id=d.id
            GROUP BY d.id ORDER BY d.created_at DESC
            """
        ).fetchall()
    result = []
    for r in rows:
        item = dict(r)
        path = item.pop("path", None)
        if item.get("source_type") in ("confluence", "web"):
            item["source_url"] = path
        result.append(item)
    return result


@app.post("/documents/upload")
async def upload_document(file: UploadFile = File(...)):
    original_name = Path(file.filename or "upload.txt").name
    suffix = Path(original_name).suffix.lower()
    if suffix not in {".pdf", ".docx", ".txt", ".md", ".markdown"}:
        raise HTTPException(status_code=400, detail="Supported types: PDF, DOCX, TXT, Markdown")
    saved_path = UPLOAD_DIR / f"{uuid.uuid4()}{suffix}"
    with saved_path.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    try:
        return index_file(saved_path, original_name, "upload")
    except Exception as exc:
        saved_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Could not parse document: {exc}")


@app.post("/documents/seed-demo")
def seed_demo(force: bool = False):
    return {"seeded": seed_demo_data(force=force)}


@app.delete("/documents/{document_id}")
def delete_document(document_id: str):
    with db() as conn:
        row = conn.execute("SELECT path, source_type FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Document not found")
        conn.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
        conn.execute("DELETE FROM documents WHERE id=?", (document_id,))
        conn.commit()
    if row["source_type"] == "upload":
        Path(row["path"]).unlink(missing_ok=True)
    return {"deleted": True}


def _confluence_status_response() -> ConfluenceStatus:
    cfg = get_confluence_config()
    state = SYNC_STATE["confluence"]
    if not cfg:
        return ConfluenceStatus(connected=False, syncing=state["running"], last_error=state["error"])
    last_synced = cfg.get("last_synced_at")
    return ConfluenceStatus(
        connected=True,
        base_url=cfg["base_url"],
        email=cfg["email"],
        space_key=cfg["space_key"],
        space_name=cfg.get("space_name"),
        last_synced_at=str(last_synced) if last_synced else None,
        last_synced_pages=cfg.get("last_synced_pages") or 0,
        syncing=state["running"],
        last_error=state["error"],
    )


@app.get("/integrations/confluence/status", response_model=ConfluenceStatus)
def confluence_status():
    return _confluence_status_response()


@app.post("/integrations/confluence/connect", response_model=ConfluenceStatus)
def confluence_connect(req: ConfluenceConnectRequest):
    base_url = req.base_url.strip().rstrip("/")
    email = req.email.strip()
    api_token = req.api_token.strip()
    space_key = req.space_key.strip()
    if not (base_url and email and api_token and space_key):
        raise HTTPException(status_code=400, detail="Site URL, email, API token, and space key are all required")
    try:
        space = confluence_find_space(base_url, email, api_token, space_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except requests.RequestException as exc:
        raise HTTPException(status_code=400, detail=f"Could not reach Confluence: {exc}")

    with db() as conn:
        conn.execute(
            """
            INSERT INTO confluence_config (id, base_url, email, api_token, space_key, space_name, last_synced_at, last_synced_pages)
            VALUES (1, ?, ?, ?, ?, ?, NULL, 0)
            ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url, email=excluded.email, api_token=excluded.api_token,
                space_key=excluded.space_key, space_name=excluded.space_name, last_synced_at=NULL, last_synced_pages=0
            """,
            (base_url, email, api_token, space_key, space.get("name") or space_key),
        )
        conn.commit()
    return _confluence_status_response()


def _run_confluence_sync() -> None:
    state = SYNC_STATE["confluence"]
    try:
        cfg = get_confluence_config()
        if not cfg:
            return
        space = confluence_find_space(cfg["base_url"], cfg["email"], cfg["api_token"], cfg["space_key"])
        pages = confluence_fetch_pages(cfg["base_url"], cfg["email"], cfg["api_token"], space["id"])

        clear_confluence_documents()
        indexed = 0
        for page in pages:
            if index_confluence_page(page, cfg["base_url"], cfg["space_key"]):
                indexed += 1

        space_name = space.get("name") or cfg["space_key"]
        with db() as conn:
            conn.execute(
                """
                INSERT INTO confluence_config (id, base_url, email, api_token, space_key, space_name, last_synced_at, last_synced_pages)
                VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(id) DO UPDATE SET space_name=excluded.space_name, last_synced_at=CURRENT_TIMESTAMP, last_synced_pages=excluded.last_synced_pages
                """,
                (cfg["base_url"], cfg["email"], cfg["api_token"], cfg["space_key"], space_name, indexed),
            )
            conn.commit()
        state["error"] = None
    except Exception as exc:
        state["error"] = str(exc)
    finally:
        state["running"] = False


def start_confluence_sync() -> bool:
    """Returns False if a sync is already running or nothing is configured."""
    if not get_confluence_config():
        return False
    with SYNC_LOCK:
        if SYNC_STATE["confluence"]["running"]:
            return False
        SYNC_STATE["confluence"]["running"] = True
    threading.Thread(target=_run_confluence_sync, daemon=True).start()
    return True


@app.post("/integrations/confluence/sync")
def confluence_sync():
    if not get_confluence_config():
        raise HTTPException(status_code=400, detail="Connect Confluence first")
    started = start_confluence_sync()
    return {"started": started, "already_running": not started and SYNC_STATE["confluence"]["running"]}


@app.delete("/integrations/confluence/disconnect")
def confluence_disconnect():
    clear_confluence_documents()
    with db() as conn:
        conn.execute("DELETE FROM confluence_config WHERE id=1")
        conn.commit()
    return {"disconnected": True}


def _web_status_response() -> WebStatus:
    cfg = get_web_config()
    state = SYNC_STATE["web"]
    if not cfg:
        return WebStatus(connected=False, syncing=state["running"], last_error=state["error"])
    last_synced = cfg.get("last_synced_at")
    return WebStatus(
        connected=True,
        label=cfg["label"],
        sitemap_url=cfg["sitemap_url"],
        path_prefix=cfg["path_prefix"],
        last_synced_at=str(last_synced) if last_synced else None,
        last_synced_pages=cfg.get("last_synced_pages") or 0,
        syncing=state["running"],
        last_error=state["error"],
    )


@app.get("/integrations/web/status", response_model=WebStatus)
def web_status():
    return _web_status_response()


@app.post("/integrations/web/connect", response_model=WebStatus)
def web_connect(req: WebConnectRequest):
    sitemap_url = req.sitemap_url.strip()
    path_prefix = req.path_prefix.strip()
    label = req.label.strip() or "Docs"
    if not (sitemap_url and path_prefix):
        raise HTTPException(status_code=400, detail="Sitemap URL and path prefix are required")
    try:
        urls = fetch_sitemap_urls(sitemap_url, path_prefix)
    except requests.RequestException as exc:
        raise HTTPException(status_code=400, detail=f"Could not reach that sitemap: {exc}")
    if not urls:
        raise HTTPException(status_code=400, detail="No pages found under that path prefix in the sitemap")

    with db() as conn:
        conn.execute(
            """
            INSERT INTO web_config (id, label, sitemap_url, path_prefix, last_synced_at, last_synced_pages)
            VALUES (1, ?, ?, ?, NULL, 0)
            ON CONFLICT(id) DO UPDATE SET label=excluded.label, sitemap_url=excluded.sitemap_url,
                path_prefix=excluded.path_prefix, last_synced_at=NULL, last_synced_pages=0
            """,
            (label, sitemap_url, path_prefix),
        )
        conn.commit()
    return _web_status_response()


def _run_web_sync() -> None:
    state = SYNC_STATE["web"]
    try:
        cfg = get_web_config()
        if not cfg:
            return
        urls = fetch_sitemap_urls(cfg["sitemap_url"], cfg["path_prefix"])[:MAX_WEB_PAGES]

        clear_web_documents()
        indexed = 0
        for url in urls:
            if index_web_page(url, cfg["label"]):
                indexed += 1
            time.sleep(0.12)  # be polite to the source site

        with db() as conn:
            conn.execute(
                """
                INSERT INTO web_config (id, label, sitemap_url, path_prefix, last_synced_at, last_synced_pages)
                VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP, ?)
                ON CONFLICT(id) DO UPDATE SET last_synced_at=CURRENT_TIMESTAMP, last_synced_pages=excluded.last_synced_pages
                """,
                (cfg["label"], cfg["sitemap_url"], cfg["path_prefix"], indexed),
            )
            conn.commit()
        state["error"] = None
    except Exception as exc:
        state["error"] = str(exc)
    finally:
        state["running"] = False


def start_web_sync() -> bool:
    if not get_web_config():
        return False
    with SYNC_LOCK:
        if SYNC_STATE["web"]["running"]:
            return False
        SYNC_STATE["web"]["running"] = True
    threading.Thread(target=_run_web_sync, daemon=True).start()
    return True


@app.post("/integrations/web/sync")
def web_sync():
    if not get_web_config():
        raise HTTPException(status_code=400, detail="Connect a website source first")
    started = start_web_sync()
    return {"started": started, "already_running": not started and SYNC_STATE["web"]["running"]}


@app.delete("/integrations/web/disconnect")
def web_disconnect():
    clear_web_documents()
    with db() as conn:
        conn.execute("DELETE FROM web_config WHERE id=1")
        conn.commit()
    return {"disconnected": True}


@app.on_event("startup")
def _auto_sync_on_startup() -> None:
    # Free-tier hosting wipes local disk on every cold start; if the source
    # config is available (DB row, or env-var fallback) but this fresh
    # instance has no indexed documents for it yet, re-sync automatically
    # instead of silently serving an empty/demo knowledge base.
    with db() as conn:
        has_confluence_docs = conn.execute("SELECT 1 FROM documents WHERE source_type='confluence' LIMIT 1").fetchone()
        has_web_docs = conn.execute("SELECT 1 FROM documents WHERE source_type='web' LIMIT 1").fetchone()
    if not has_confluence_docs:
        start_confluence_sync()
    if not has_web_docs:
        start_web_sync()


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest):
    question = req.question.strip()
    if len(question) < 3:
        raise HTTPException(status_code=400, detail="Question is too short")
    results = retrieve(question, req.top_k)
    if not results:
        return AskResponse(answer="Your knowledge base is empty.", confidence=0, sources=[], mode="empty", provider="demo", question=question)
    answer, follow, provider = llm_answer(question, results, req.call_context, req.provider, req.answer_style)
    top = results[0]["score"] if results else 0
    confidence = min(0.98, max(0.0, 0.25 + top * 2.1)) if top > 0 else 0.0
    sources = [
        Source(
            document_id=r["document_id"], filename=r["filename"], chunk_index=r["chunk_index"],
            score=round(r["score"], 4), excerpt=(r["content"][:520] + "…") if len(r["content"]) > 520 else r["content"],
            url=r.get("url"),
        ) for r in results if r["score"] > 0
    ]
    return AskResponse(answer=answer, confidence=round(confidence, 2), sources=sources, follow_up=follow, mode=f"{provider}+rag", provider=provider, question=question)


@app.post("/detect-question")
def detect_question(req: DetectRequest):
    provider = resolve_provider(req.provider)
    if provider != "demo":
        ok, q = llm_detect_question(req.transcript, provider)
        if ok:
            return {"question_detected": bool(q), "question": q}
    q = heuristic_question(req.transcript)
    return {"question_detected": bool(q), "question": q}


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    requested = os.getenv("TRANSCRIPTION_PROVIDER", "local").lower()
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        temp_path = Path(tmp.name)
    try:
        text = ""
        used = requested
        if requested == "openai":
            if not provider_status()["openai"]:
                raise HTTPException(status_code=400, detail="OpenAI transcription selected but OPENAI_API_KEY is not configured")
            client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
            with temp_path.open("rb") as fh:
                result = client.audio.transcriptions.create(model=os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"), file=fh)
            text = getattr(result, "text", "") or ""
        else:
            if not local_whisper_available():
                raise HTTPException(status_code=503, detail="Local Whisper is unavailable. Re-run the CallPilot installer.")
            try:
                text = transcribe_local(temp_path)
                used = "local"
            except Exception as exc:
                raise HTTPException(status_code=503, detail=f"Local transcription failed: {exc}") from exc
        return {"text": text.strip(), "question": heuristic_question(text), "transcription_provider": used}
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/sessions")
def create_session(req: SessionRequest):
    sid = str(uuid.uuid4())
    with db() as conn:
        conn.execute("INSERT INTO sessions (id, customer, call_type, context) VALUES (?, ?, ?, ?)", (sid, req.customer, req.call_type, req.context))
        conn.commit()
    return {"id": sid, **req.model_dump(), "transcript": ""}


@app.post("/sessions/{session_id}/transcript")
def append_transcript(session_id: str, req: TranscriptRequest):
    with db() as conn:
        row = conn.execute("SELECT transcript FROM sessions WHERE id=?", (session_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Session not found")
        transcript = (row["transcript"] + "\n" + req.text).strip()
        conn.execute("UPDATE sessions SET transcript=? WHERE id=?", (transcript, session_id))
        conn.commit()
    return {"transcript": transcript, "question": heuristic_question(transcript)}


@app.get("/sessions/{session_id}")
def get_session(session_id: str):
    with db() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    return dict(row)


@app.get("/overlay/state")
def overlay_state():
    return OVERLAY_STATE


@app.post("/overlay/push")
def overlay_push(req: OverlayPushRequest):
    OVERLAY_STATE.update({
        "visible": True,
        "question": req.question,
        "answer": req.answer,
        "confidence": req.confidence,
        "source": req.source,
        "follow_up": req.follow_up,
    })
    return OVERLAY_STATE


@app.post("/overlay/hide")
def overlay_hide():
    OVERLAY_STATE["visible"] = False
    return OVERLAY_STATE
