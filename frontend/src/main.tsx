import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AudioLines, BookOpen, ChevronDown, CircleStop, Clock, FileText, Globe, Headphones,
  Link2, Loader2, MessageSquareText, Mic, MonitorUp, Plus, RefreshCw, Search, Send,
  Settings2, Sparkles, Trash2, Zap
} from "lucide-react";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

type Doc = { id:string; filename:string; chunks:number; created_at:string; source_type:string; source_url?:string };
type ConfluenceStatusT = {
  connected:boolean; base_url?:string; email?:string; space_key?:string; space_name?:string;
  last_synced_at?:string; last_synced_pages:number
};
type WebStatusT = {
  connected:boolean; label?:string; sitemap_url?:string; path_prefix?:string;
  last_synced_at?:string; last_synced_pages:number
};
type Source = { document_id:string; filename:string; chunk_index:number; score:number; excerpt:string; url?:string };
type QaLogEntry = {
  id:string; question:string; answer:string; confidence?:number; provider?:string;
  source_filename?:string; source_url?:string; follow_up?:string; created_at:string
};
type Answer = { answer:string; confidence:number; sources:Source[]; follow_up?:string; mode:string; provider:string; question:string };
type Providers = { openai:boolean; claude:boolean; demo:boolean; openai_model:string; claude_model:string; transcription_model:string };

type TranscriptLine = { speaker:string; text:string; ts:string };

const DEMO_QUESTIONS = [
  "Can the platform test IVR and DTMF inputs?",
  "What documents can I upload to generate scenarios?",
  "How long does a typical technical POC take?",
  "Can I claim that the product is compliance certified?",
  "Does the demo automatically join Zoom or Google Meet?"
];

function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [provider, setProvider] = useState("auto");
  const [style, setStyle] = useState("short");
  const [question, setQuestion] = useState(DEMO_QUESTIONS[0]);
  const [customer, setCustomer] = useState("Air Canada — Demo");
  const [callType, setCallType] = useState("POC");
  const [callContext, setCallContext] = useState("Customer is evaluating a conversational-agent testing platform for customer-facing chat, voice, and IVR workflows. Treat all bundled Nimbus documents as fictional demo data.");
  const [result, setResult] = useState<Answer | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"answer"|"live"|"history">("answer");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([
    {speaker:"Customer", text:"We currently use a phone-based assistant for booking changes.", ts:"00:03"},
    {speaker:"Customer", text:"Can your platform test IVR navigation and DTMF inputs?", ts:"00:10"}
  ]);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState("Ready");
  const [captureMode, setCaptureMode] = useState<"mic"|"tab">("mic");
  const liveRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);

  const [confluence, setConfluence] = useState<ConfluenceStatusT | null>(null);
  const [cfBaseUrl, setCfBaseUrl] = useState("");
  const [cfEmail, setCfEmail] = useState("");
  const [cfToken, setCfToken] = useState("");
  const [cfSpaceKey, setCfSpaceKey] = useState("");
  const [cfConnecting, setCfConnecting] = useState(false);
  const [cfSyncing, setCfSyncing] = useState(false);
  const [cfError, setCfError] = useState("");

  const [web, setWeb] = useState<WebStatusT | null>(null);
  const [webSitemapUrl, setWebSitemapUrl] = useState("https://www.lambdatest.com/sitemap.xml");
  const [webPathPrefix, setWebPathPrefix] = useState("/support/docs/");
  const [webLabel, setWebLabel] = useState("LT Docs");
  const [webConnecting, setWebConnecting] = useState(false);
  const [webSyncing, setWebSyncing] = useState(false);
  const [webError, setWebError] = useState("");

  const [qaLog, setQaLog] = useState<QaLogEntry[]>([]);
  const [qaLogLoading, setQaLogLoading] = useState(false);
  const [qaLogSearch, setQaLogSearch] = useState("");

  const context = useMemo(() => `Customer: ${customer}\nCall type: ${callType}\n${callContext}`, [customer, callType, callContext]);

  async function refresh() {
    try {
      const [d,p] = await Promise.all([fetch(`${API}/documents`), fetch(`${API}/settings/providers`)]);
      if (d.ok) setDocs(await d.json());
      if (p.ok) setProviders(await p.json());
    } catch { setError("Backend is not reachable. Start FastAPI on port 8000."); }
  }
  useEffect(() => { refresh(); refreshConfluence(); refreshWeb(); }, []);
  useEffect(() => { if (tab === "history" && qaLog.length === 0 && !qaLogLoading) refreshQaLog(); }, [tab]);

  async function refreshQaLog() {
    setQaLogLoading(true);
    try {
      const r = await fetch(`${API}/qa-log?limit=200`);
      if (r.ok) setQaLog(await r.json());
    } catch { /* backend not reachable yet; refresh() already surfaces that error */ }
    finally { setQaLogLoading(false); }
  }

  async function deleteQaLogEntry(id:string) {
    await fetch(`${API}/qa-log/${id}`, {method:"DELETE"});
    setQaLog(prev => prev.filter(e => e.id !== id));
  }

  async function clearQaLog() {
    if (!window.confirm("Clear all Q&A history? This can't be undone.")) return;
    await fetch(`${API}/qa-log`, {method:"DELETE"});
    setQaLog([]);
  }

  // Syncs run in a background thread server-side and can take minutes (a big
  // Confluence space, a few hundred docs pages) — too long for a hosting
  // platform's request proxy to sit on. The sync endpoints just kick the job
  // off; this polls /status until `syncing` flips back to false.
  async function pollUntilSynced(kind: "confluence"|"web") {
    const statusUrl = kind === "confluence" ? `${API}/integrations/confluence/status` : `${API}/integrations/web/status`;
    const setStatus: (s:any)=>void = kind === "confluence" ? setConfluence : (setWeb as any);
    const setSyncing = kind === "confluence" ? setCfSyncing : setWebSyncing;
    const setErr = kind === "confluence" ? setCfError : setWebError;
    setSyncing(true);
    for (let i = 0; i < 300; i++) {
      try {
        const r = await fetch(statusUrl);
        if (r.ok) {
          const data = await r.json();
          setStatus(data);
          if (!data.syncing) {
            if (data.last_error) setErr(data.last_error);
            break;
          }
        }
      } catch { /* transient network hiccup; keep polling */ }
      await new Promise(res => setTimeout(res, 2000));
    }
    setSyncing(false);
    await refresh();
  }

  async function refreshConfluence() {
    try {
      const r = await fetch(`${API}/integrations/confluence/status`);
      if (r.ok) {
        const data = await r.json();
        setConfluence(data);
        if (data.syncing) pollUntilSynced("confluence");
      }
    } catch { /* backend not reachable yet; refresh() already surfaces that error */ }
  }

  async function connectConfluence() {
    setCfConnecting(true); setCfError("");
    try {
      const r = await fetch(`${API}/integrations/confluence/connect`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({base_url:cfBaseUrl.trim(), email:cfEmail.trim(), api_token:cfToken.trim(), space_key:cfSpaceKey.trim()})
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Could not connect to Confluence");
      setConfluence(data);
      setCfToken("");
      await syncConfluence();
    } catch(e:any) { setCfError(e.message); }
    finally { setCfConnecting(false); }
  }

  async function syncConfluence() {
    setCfError("");
    try {
      const r = await fetch(`${API}/integrations/confluence/sync`, {method:"POST"});
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Sync failed to start");
      await pollUntilSynced("confluence");
    } catch(e:any) { setCfError(e.message); }
  }

  async function disconnectConfluence() {
    setCfError("");
    await fetch(`${API}/integrations/confluence/disconnect`, {method:"DELETE"});
    setConfluence({connected:false, last_synced_pages:0});
    await refresh();
  }

  async function refreshWeb() {
    try {
      const r = await fetch(`${API}/integrations/web/status`);
      if (r.ok) {
        const data = await r.json();
        setWeb(data);
        if (data.syncing) pollUntilSynced("web");
      }
    } catch { /* backend not reachable yet; refresh() already surfaces that error */ }
  }

  async function connectWeb() {
    setWebConnecting(true); setWebError("");
    try {
      const r = await fetch(`${API}/integrations/web/connect`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({sitemap_url:webSitemapUrl.trim(), path_prefix:webPathPrefix.trim(), label:webLabel.trim() || "Docs"})
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Could not connect to that site");
      setWeb(data);
      await syncWeb();
    } catch(e:any) { setWebError(e.message); }
    finally { setWebConnecting(false); }
  }

  async function syncWeb() {
    setWebError("");
    try {
      const r = await fetch(`${API}/integrations/web/sync`, {method:"POST"});
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Sync failed to start");
      await pollUntilSynced("web");
    } catch(e:any) { setWebError(e.message); }
  }

  async function disconnectWeb() {
    setWebError("");
    await fetch(`${API}/integrations/web/disconnect`, {method:"DELETE"});
    setWeb({connected:false, last_synced_pages:0});
    await refresh();
  }

  async function upload(file?: File) {
    if (!file) return;
    setUploading(true); setError("");
    try {
      const body = new FormData(); body.append("file", file);
      const r = await fetch(`${API}/documents/upload`, {method:"POST", body});
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Upload failed");
      await refresh();
    } catch(e:any) { setError(e.message); }
    finally { setUploading(false); }
  }

  async function removeDoc(id:string) {
    await fetch(`${API}/documents/${id}`, {method:"DELETE"});
    await refresh();
  }

  async function reseed() {
    await fetch(`${API}/documents/seed-demo?force=true`, {method:"POST"});
    await refresh();
  }

  async function ask(q = question) {
    if (!q.trim()) return;
    setQuestion(q); setLoading(true); setError(""); setResult(null);
    try {
      const r = await fetch(`${API}/ask`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({question:q, call_context:context, provider, answer_style:style, top_k:5})});
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Could not generate answer");
      setResult(data); setTab("answer");
    } catch(e:any) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function processTranscript(text:string) {
    if (!text.trim()) return;
    const stamp = new Date().toLocaleTimeString([], {minute:"2-digit", second:"2-digit"});
    setTranscript(prev => [...prev, {speaker:"Call", text, ts:stamp}]);
    try {
      const d = await fetch(`${API}/detect-question`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({transcript:text, provider})});
      const detected = await d.json();
      if (detected.question_detected && detected.question) {
        setLiveStatus("Question detected — generating answer");
        await ask(detected.question);
      } else setLiveStatus("Listening for a question…");
    } catch { setLiveStatus("Transcript captured"); }
  }

  async function captureSegment(stream:MediaStream) {
    if (!liveRef.current) return;
    const chunks:BlobPart[] = [];
    let recorder:MediaRecorder;
    try { recorder = new MediaRecorder(stream, {mimeType:"audio/webm"}); }
    catch { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      if (!chunks.length) return;
      const blob = new Blob(chunks, {type:recorder.mimeType || "audio/webm"});
      const form = new FormData(); form.append("file", blob, "segment.webm");
      try {
        setLiveStatus("Transcribing…");
        const r = await fetch(`${API}/transcribe`, {method:"POST", body:form});
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || "Transcription failed");
        if (data.text) await processTranscript(data.text);
      } catch(e:any) { setError(e.message); stopLive(); return; }
      if (liveRef.current) setTimeout(() => captureSegment(stream), 150);
    };
    recorder.start();
    setLiveStatus("Listening…");
    setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 7000);
  }

  async function startLive() {
    setError("");
    if (!providers?.openai) {
      setError("Live transcription needs OPENAI_API_KEY. You can still use transcript simulation and RAG without a key.");
      return;
    }
    try {
      const stream = captureMode === "mic"
        ? await navigator.mediaDevices.getUserMedia({audio:true})
        : await navigator.mediaDevices.getDisplayMedia({video:true, audio:true});
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) throw new Error("No audio track was shared. For tab audio, enable 'Share tab audio' in the browser dialog.");
      const audioOnly = new MediaStream(audioTracks);
      streamRef.current = stream;
      liveRef.current = true; setLive(true); setTab("live");
      captureSegment(audioOnly);
    } catch(e:any) { setError(e.message || "Could not start audio capture"); }
  }

  function stopLive() {
    liveRef.current = false; setLive(false); setLiveStatus("Stopped");
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
  }

  return <main className="appShell">
    <header className="topbar">
      <div className="brand"><div className="logo"><Sparkles size={18}/></div><div><b>CallPilot AI</b><span>Real-time knowledge copilot</span></div></div>
      <div className="topActions">
        <div className="health"><i/> API connected</div>
        <div className="version">v1.0</div>
      </div>
    </header>

    <section className="layout">
      <aside className="sidebar">
        <div className="sectionTitle"><Link2 size={17}/><b>Confluence</b>{confluence?.connected && <span className="okDot" title="Connected"/>}</div>
        {confluence?.connected ? <div className="confluenceCard connected">
          <div className="cfSpace"><b>{confluence.space_name || confluence.space_key}</b><span>{confluence.space_key} · {confluence.base_url}</span></div>
          <div className="cfMeta">{confluence.last_synced_at ? `Synced ${confluence.last_synced_pages} page${confluence.last_synced_pages===1?"":"s"} · ${new Date(confluence.last_synced_at).toLocaleString()}` : "Connected — not synced yet"}</div>
          <div className="cfActions">
            <button className="ghostBtn" onClick={syncConfluence} disabled={cfSyncing}>{cfSyncing?<Loader2 className="spin" size={14}/>:<RefreshCw size={14}/>} {cfSyncing?"Syncing…":"Sync now"}</button>
            <button className="ghostBtn cfDanger" onClick={disconnectConfluence}><Trash2 size={14}/> Disconnect</button>
          </div>
        </div> : <div className="confluenceCard">
          <input placeholder="Site URL — https://yourorg.atlassian.net" value={cfBaseUrl} onChange={e=>setCfBaseUrl(e.target.value)}/>
          <input placeholder="Email" value={cfEmail} onChange={e=>setCfEmail(e.target.value)}/>
          <input placeholder="API token" type="password" value={cfToken} onChange={e=>setCfToken(e.target.value)}/>
          <input placeholder="Space key — e.g. SALES" value={cfSpaceKey} onChange={e=>setCfSpaceKey(e.target.value)}/>
          <button className="uploadBtn" onClick={connectConfluence} disabled={cfConnecting || !cfBaseUrl.trim() || !cfEmail.trim() || !cfToken.trim() || !cfSpaceKey.trim()}>
            {cfConnecting?<Loader2 className="spin" size={15}/>:<Link2 size={15}/>} {cfConnecting?"Connecting…":"Connect Confluence"}
          </button>
        </div>}
        {cfError && <div className="error cfErrorMsg">{cfError}</div>}

        <div className="sectionTitle"><Globe size={17}/><b>Website Docs</b>{web?.connected && <span className="okDot" title="Connected"/>}</div>
        {web?.connected ? <div className="confluenceCard connected">
          <div className="cfSpace"><b>{web.label}</b><span>{web.path_prefix}</span></div>
          <div className="cfMeta">{web.last_synced_at ? `Synced ${web.last_synced_pages} page${web.last_synced_pages===1?"":"s"} · ${new Date(web.last_synced_at).toLocaleString()}` : "Connected — not synced yet"}</div>
          <div className="cfActions">
            <button className="ghostBtn" onClick={syncWeb} disabled={webSyncing}>{webSyncing?<Loader2 className="spin" size={14}/>:<RefreshCw size={14}/>} {webSyncing?"Syncing…":"Sync now"}</button>
            <button className="ghostBtn cfDanger" onClick={disconnectWeb}><Trash2 size={14}/> Disconnect</button>
          </div>
        </div> : <div className="confluenceCard">
          <input placeholder="Sitemap URL — https://example.com/sitemap.xml" value={webSitemapUrl} onChange={e=>setWebSitemapUrl(e.target.value)}/>
          <input placeholder="Path prefix — e.g. /support/docs/" value={webPathPrefix} onChange={e=>setWebPathPrefix(e.target.value)}/>
          <input placeholder="Label — e.g. LT Docs" value={webLabel} onChange={e=>setWebLabel(e.target.value)}/>
          <button className="uploadBtn" onClick={connectWeb} disabled={webConnecting || !webSitemapUrl.trim() || !webPathPrefix.trim()}>
            {webConnecting?<Loader2 className="spin" size={15}/>:<Globe size={15}/>} {webConnecting?"Connecting…":"Connect Website"}
          </button>
        </div>}
        {webError && <div className="error cfErrorMsg">{webError}</div>}

        <div className="sectionTitle"><BookOpen size={17}/><b>Knowledge Base</b><span>{docs.length}</span></div>
        <label className="uploadBtn">{uploading?<Loader2 className="spin" size={17}/>:<Plus size={17}/>} {uploading?"Indexing…":"Add document"}<input hidden type="file" accept=".pdf,.docx,.txt,.md,.markdown" onChange={e=>upload(e.target.files?.[0])}/></label>
        <button className="ghostBtn" onClick={reseed}><RefreshCw size={15}/> Reset demo data</button>
        <div className="docList">
          {docs.map(d => <div className="doc" key={d.id}><div className={`docIcon ${d.source_type}`}><FileText size={16}/></div><div className="docMeta">{d.source_url ? <a href={d.source_url} target="_blank" rel="noreferrer"><b>{d.filename}</b></a> : <b>{d.filename}</b>}<span>{d.chunks} chunks · {d.source_type}</span></div><button onClick={()=>removeDoc(d.id)}><Trash2 size={14}/></button></div>)}
        </div>
        <div className="demoBadge"><Sparkles size={14}/><div><b>Demo data included</b><span>Bundled Nimbus files are fictional and safe for testing.</span></div></div>
      </aside>

      <section className="mainCol">
        <div className="callCard card">
          <div className="callGrid">
            <label><span>Customer</span><input value={customer} onChange={e=>setCustomer(e.target.value)}/></label>
            <label><span>Call type</span><select value={callType} onChange={e=>setCallType(e.target.value)}><option>Discovery</option><option>Demo</option><option>POC</option><option>Support</option><option>Renewal</option></select></label>
            <label className="wide"><span>Call context</span><input value={callContext} onChange={e=>setCallContext(e.target.value)}/></label>
          </div>
        </div>

        <div className="toolbar card">
          <div className="tabs"><button className={tab==="answer"?"active":""} onClick={()=>setTab("answer")}><MessageSquareText size={16}/> Copilot</button><button className={tab==="live"?"active":""} onClick={()=>setTab("live")}><AudioLines size={16}/> Live Demo</button><button className={tab==="history"?"active":""} onClick={()=>setTab("history")}><Clock size={16}/> History</button></div>
          <div className="controls">
            <label><Settings2 size={14}/><select value={provider} onChange={e=>setProvider(e.target.value)}><option value="auto">Auto provider</option><option value="openai">OpenAI {providers?.openai?"✓":"(no key)"}</option><option value="claude">Claude {providers?.claude?"✓":"(no key)"}</option><option value="demo">Demo / no key</option></select></label>
            <label><select value={style} onChange={e=>setStyle(e.target.value)}><option value="short">Short answer</option><option value="detailed">Detailed</option><option value="technical">Technical</option></select></label>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {tab === "answer" ? <>
          <div className="ask card">
            <div className="askTop"><div><span className="eyebrow">CUSTOMER QUESTION</span><h2>What did they ask?</h2></div><span className="kbd">⌘ / Ctrl + Enter</span></div>
            <textarea value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter") ask();}} />
            <div className="askFooter"><div className="chips">{DEMO_QUESTIONS.slice(0,3).map(q=><button key={q} onClick={()=>setQuestion(q)}>{q}</button>)}</div><button className="primary" onClick={()=>ask()} disabled={loading}>{loading?<Loader2 className="spin" size={17}/>:<Zap size={17}/>} Generate answer</button></div>
          </div>

          <div className="answer card">
            {!result ? <div className="emptyAnswer"><div className="orb"><Sparkles size={28}/></div><h2>Grounded answer appears here</h2><p>Ask a demo question or start Live Demo. The copilot retrieves relevant knowledge before answering.</p></div> : <>
              <div className="answerHeader"><div><span className="eyebrow">SUGGESTED RESPONSE</span><h2>{result.question}</h2></div><div className="score"><b>{Math.round(result.confidence*100)}%</b><span>confidence</span></div></div>
              <div className="answerBody">{result.answer}</div>
              {result.follow_up && <div className="follow"><Sparkles size={16}/><div><b>Suggested follow-up</b><span>{result.follow_up}</span></div></div>}
              <div className="sourceHead"><b>Evidence</b><span>{result.provider} + RAG · {result.sources.length} sources</span></div>
              <div className="sources">{result.sources.map((s,i)=><details key={`${s.document_id}-${s.chunk_index}`}><summary><div><span className="num">{i+1}</span>{s.url ? <a href={s.url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}><b>{s.filename}</b></a> : <b>{s.filename}</b>}</div><small>{Math.round(s.score*100)}% match <ChevronDown size={14}/></small></summary><p>{s.excerpt}</p></details>)}</div>
            </>}
          </div>
        </> : tab === "live" ? <div className="liveGrid">
          <div className="card livePanel">
            <div className="liveHead"><div><span className="eyebrow">LIVE TRANSCRIPT</span><h2>{live?"Listening to call":"Call simulator"}</h2></div><div className={`liveDot ${live?"on":""}`}><i/>{liveStatus}</div></div>
            <div className="transcript">{transcript.map((t,i)=><div className="line" key={i}><span>{t.ts}</span><b>{t.speaker}</b><p>{t.text}</p></div>)}</div>
            <div className="simulator"><input id="simtext" placeholder="Type a customer sentence, e.g. Does it support voice agents?" onKeyDown={async e=>{if(e.key==="Enter"){const el=e.currentTarget; await processTranscript(el.value); el.value="";}}}/><button onClick={async()=>{const el=document.getElementById("simtext") as HTMLInputElement; if(el?.value){await processTranscript(el.value); el.value="";}}}><Send size={16}/></button></div>
          </div>
          <div className="card capturePanel">
            <Headphones size={24}/><h2>Audio capture</h2><p>Use your microphone, or share a browser tab with audio. Audio is processed in 7-second segments for this demo.</p>
            <div className="captureModes"><button className={captureMode==="mic"?"selected":""} onClick={()=>setCaptureMode("mic")}><Mic size={17}/> Microphone</button><button className={captureMode==="tab"?"selected":""} onClick={()=>setCaptureMode("tab")}><MonitorUp size={17}/> Shared tab</button></div>
            {!live?<button className="primary large" onClick={startLive}><AudioLines size={18}/> Start live demo</button>:<button className="danger large" onClick={stopLive}><CircleStop size={18}/> Stop listening</button>}
            <div className="capNote"><b>Requires OpenAI key for speech-to-text.</b><span>Typed transcript simulation works without any API key.</span></div>
          </div>
        </div> : <div className="history card">
          <div className="historyHead">
            <div className="historySearch"><Search size={14}/><input placeholder="Search past questions and answers…" value={qaLogSearch} onChange={e=>setQaLogSearch(e.target.value)}/></div>
            <div className="historyActions">
              <button className="ghostBtn" onClick={refreshQaLog} disabled={qaLogLoading}>{qaLogLoading?<Loader2 className="spin" size={14}/>:<RefreshCw size={14}/>} Refresh</button>
              {qaLog.length > 0 && <button className="ghostBtn cfDanger" onClick={clearQaLog}><Trash2 size={14}/> Clear all</button>}
            </div>
          </div>
          {(() => {
            const term = qaLogSearch.trim().toLowerCase();
            const filtered = term ? qaLog.filter(e => e.question.toLowerCase().includes(term) || e.answer.toLowerCase().includes(term)) : qaLog;
            if (qaLogLoading && qaLog.length === 0) return <div className="historyEmpty"><Loader2 className="spin" size={22}/><p>Loading history…</p></div>;
            if (filtered.length === 0) return <div className="historyEmpty"><Clock size={26}/><h2>{qaLog.length===0 ? "No questions asked yet" : "No matches"}</h2><p>{qaLog.length===0 ? "Every question asked in the Copilot tab, the overlay, or a live call gets logged here for later reference." : "Try a different search term."}</p></div>;
            return <div className="historyList">{filtered.map(e => <div className="historyEntry" key={e.id}>
              <div className="historyEntryHead">
                <span className="historyTime">{new Date(e.created_at).toLocaleString()}</span>
                <button className="historyDelete" onClick={()=>deleteQaLogEntry(e.id)} title="Delete"><Trash2 size={13}/></button>
              </div>
              <b className="historyQ">{e.question}</b>
              <p className="historyA">{e.answer}</p>
              <div className="historyMeta">
                {typeof e.confidence === "number" && <span>{Math.round(e.confidence*100)}% confidence</span>}
                {e.source_filename && (e.source_url ? <a href={e.source_url} target="_blank" rel="noreferrer">{e.source_filename}</a> : <span>{e.source_filename}</span>)}
              </div>
            </div>)}</div>;
          })()}
        </div>}
      </section>
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(<App/>);
