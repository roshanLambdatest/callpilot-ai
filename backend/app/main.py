from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import uuid
from pathlib import Path
from typing import List, Optional, Literal

import numpy as np
from docx import Document
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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


def seed_demo_data(force: bool = False) -> int:
    if not DEMO_DIR.exists():
        return 0
    with db() as conn:
        existing = conn.execute("SELECT COUNT(*) AS c FROM documents WHERE source_type='demo'").fetchone()["c"]
    if existing and not force:
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
        "claude_model": os.getenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
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
            SELECT c.document_id, c.chunk_index, c.content, d.filename
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
            model=os.getenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
            max_tokens=900,
            temperature=0.1,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text").strip()

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
            SELECT d.id, d.filename, d.source_type, d.created_at, COUNT(c.id) AS chunks
            FROM documents d LEFT JOIN chunks c ON c.document_id=d.id
            GROUP BY d.id ORDER BY d.created_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


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
            score=round(r["score"], 4), excerpt=(r["content"][:520] + "…") if len(r["content"]) > 520 else r["content"]
        ) for r in results if r["score"] > 0
    ]
    return AskResponse(answer=answer, confidence=round(confidence, 2), sources=sources, follow_up=follow, mode=f"{provider}+rag", provider=provider, question=question)


@app.post("/detect-question")
def detect_question(req: DetectRequest):
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
