import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AudioLines, BookOpen, ChevronDown, CircleStop, FileText, Headphones,
  Loader2, MessageSquareText, Mic, MonitorUp, Plus, RefreshCw, Send,
  Settings2, Sparkles, Trash2, Zap
} from "lucide-react";
import "./styles.css";
const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

type Doc = { id:string; filename:string; chunks:number; created_at:string; source_type:string };
type Source = { document_id:string; filename:string; chunk_index:number; score:number; excerpt:string };
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
  const [tab, setTab] = useState<"answer"|"live">("answer");
  const [transcript, setTranscript] = useState<TranscriptLine[]>([
    {speaker:"Customer", text:"We currently use a phone-based assistant for booking changes.", ts:"00:03"},
    {speaker:"Customer", text:"Can your platform test IVR navigation and DTMF inputs?", ts:"00:10"}
  ]);
  const [live, setLive] = useState(false);
  const [liveStatus, setLiveStatus] = useState("Ready");
  const [captureMode, setCaptureMode] = useState<"mic"|"tab">("mic");
  const liveRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);

  const context = useMemo(() => `Customer: ${customer}\nCall type: ${callType}\n${callContext}`, [customer, callType, callContext]);

  async function refresh() {
    try {
      const [d,p] = await Promise.all([fetch(`${API}/documents`), fetch(`${API}/settings/providers`)]);
      if (d.ok) setDocs(await d.json());
      if (p.ok) setProviders(await p.json());
    } catch { setError("Backend is not reachable. Start FastAPI on port 8000."); }
  }
  useEffect(() => { refresh(); }, []);

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
        <div className="sectionTitle"><BookOpen size={17}/><b>Knowledge Base</b><span>{docs.length}</span></div>
        <label className="uploadBtn">{uploading?<Loader2 className="spin" size={17}/>:<Plus size={17}/>} {uploading?"Indexing…":"Add document"}<input hidden type="file" accept=".pdf,.docx,.txt,.md,.markdown" onChange={e=>upload(e.target.files?.[0])}/></label>
        <button className="ghostBtn" onClick={reseed}><RefreshCw size={15}/> Reset demo data</button>
        <div className="docList">
          {docs.map(d => <div className="doc" key={d.id}><div className={`docIcon ${d.source_type}`}><FileText size={16}/></div><div className="docMeta"><b>{d.filename}</b><span>{d.chunks} chunks · {d.source_type}</span></div><button onClick={()=>removeDoc(d.id)}><Trash2 size={14}/></button></div>)}
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
          <div className="tabs"><button className={tab==="answer"?"active":""} onClick={()=>setTab("answer")}><MessageSquareText size={16}/> Copilot</button><button className={tab==="live"?"active":""} onClick={()=>setTab("live")}><AudioLines size={16}/> Live Demo</button></div>
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
              <div className="sources">{result.sources.map((s,i)=><details key={`${s.document_id}-${s.chunk_index}`}><summary><div><span className="num">{i+1}</span><b>{s.filename}</b></div><small>{Math.round(s.score*100)}% match <ChevronDown size={14}/></small></summary><p>{s.excerpt}</p></details>)}</div>
            </>}
          </div>
        </> : <div className="liveGrid">
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
        </div>}
      </section>
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(<App/>);
