import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, ArrowDown, ArrowRight, BookOpen, BrainCircuit, Check, ChevronRight,
  CircleHelp, ClipboardList, FileCheck2, FileText, Flame, Gauge, GraduationCap,
  Layers3, Menu, Moon, Plus, RefreshCw, ScanSearch, Send, ShieldCheck, Sparkles,
  Target, UploadCloud, X, Zap
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/* ---------- Text extraction + handwriting OCR ---------- */
const TEXT_LIMIT = 45000;       // max characters sent to the AI per file
const OCR_MAX_PAGES = 20;       // max handwritten pages per file (controls cost + time)
const OCR_CONCURRENCY = 2;      // pages transcribed in parallel
const MAX_SIDE = 1800;          // longest page edge (px) sent for OCR
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bitmapToJpeg(bitmap) {
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function pdfPageToJpeg(page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function ocrOnePage(image, pageNo, attempt = 0) {
  let res, data = {};
  try {
    res = await fetch("/api/ocr", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image, page: pageNo }) });
    try { data = await res.json(); } catch { /* non-JSON (e.g. gateway timeout page) */ }
  } catch { throw new Error("Network problem while reading handwriting. Please check your connection and try again."); }
  if (!res.ok) {
    if (attempt < 1 && (res.status >= 500 || res.status === 429)) { await sleep(1500); return ocrOnePage(image, pageNo, attempt + 1); }
    if (res.status === 502 || res.status === 504) throw new Error(`Reading page ${pageNo} timed out. Try again, or set a faster OPENAI_OCR_MODEL in Netlify.`);
    throw new Error(data.error || `Handwriting OCR failed on page ${pageNo} (HTTP ${res.status}).`);
  }
  return data.text || "";
}

// items: [{ pageNo, getImage: async () => dataUrl }] -> array of transcribed strings (same order)
async function ocrPages(items, onProgress) {
  const out = new Array(items.length);
  let next = 0, done = 0, failed = false;
  onProgress(0, items.length);
  async function worker() {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await ocrOnePage(await items[i].getImage(), items[i].pageNo);
        onProgress(++done, items.length);
      } catch (e) { failed = true; throw e; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(OCR_CONCURRENCY, items.length) }, worker));
  return out;
}

async function extractFromPdf(file, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map(x => x.str).join(" ").trim());
  }
  // Pages with (almost) no selectable text are scanned/handwritten -> OCR only those pages.
  const needOcr = pageTexts.map((t, i) => (t.length < 40 ? i : -1)).filter(i => i >= 0);
  if (!needOcr.length) {
    return { name: file.name, type: "PDF", pages: pdf.numPages, source: "text", text: pageTexts.join("\n").slice(0, TEXT_LIMIT) };
  }
  if (needOcr.length > OCR_MAX_PAGES) throw new Error(`This PDF has ${needOcr.length} handwritten/scanned pages. The limit is ${OCR_MAX_PAGES} pages per file; please split the PDF into smaller parts.`);
  const items = needOcr.map(i => ({ pageNo: i + 1, getImage: async () => pdfPageToJpeg(await pdf.getPage(i + 1)) }));
  const ocrTexts = await ocrPages(items, onProgress);
  const merged = pageTexts.map((t, i) => {
    const k = needOcr.indexOf(i);
    return `[Page ${i + 1}]\n${k >= 0 ? ocrTexts[k] : t}`;
  }).join("\n\n");
  if (merged.replace(/\[Page \d+\]|\[blank page\]/g, "").trim().length < 30) throw new Error("No readable writing was found in this file. Try a clearer, well-lit scan.");
  return { name: file.name, type: "PDF", pages: pdf.numPages, source: "ocr", text: merged.slice(0, TEXT_LIMIT) };
}

async function extractFromImages(files, onProgress) {
  if (files.length > OCR_MAX_PAGES) throw new Error(`Please upload at most ${OCR_MAX_PAGES} page images at a time.`);
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const items = sorted.map((f, i) => ({ pageNo: i + 1, getImage: async () => { const bmp = await createImageBitmap(f); try { return bitmapToJpeg(bmp); } finally { bmp.close?.(); } } }));
  const texts = await ocrPages(items, onProgress);
  const merged = texts.map((t, i) => `[Page ${i + 1}]\n${t}`).join("\n\n");
  if (merged.replace(/\[Page \d+\]|\[blank page\]/g, "").trim().length < 30) throw new Error("No readable writing was found in these images. Try clearer, well-lit photos.");
  return { name: sorted.length === 1 ? sorted[0].name : `${sorted.length} page photos`, type: "IMAGE", pages: sorted.length, source: "ocr", text: merged.slice(0, TEXT_LIMIT) };
}

async function extractText(fileList, onProgress) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return null;
  const exts = files.map(f => f.name.split(".").pop().toLowerCase());
  if (files.length > 1) {
    if (!exts.every(e => IMAGE_EXTS.includes(e))) throw new Error("To upload several files at once, choose only page photos (JPG, PNG, WEBP). PDFs, DOCX and TXT must be uploaded one at a time.");
    return extractFromImages(files, onProgress);
  }
  const file = files[0], ext = exts[0];
  if (ext === "pdf") return extractFromPdf(file, onProgress);
  if (IMAGE_EXTS.includes(ext)) return extractFromImages(files, onProgress);
  if (ext === "txt" || ext === "md") return { name: file.name, type: ext.toUpperCase(), pages: 1, source: "text", text: (await file.text()).slice(0, TEXT_LIMIT) };
  if (ext === "docx") {
    const mammoth = await import("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/+esm");
    const parsed = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { name: file.name, type: "DOCX", pages: 1, source: "text", text: parsed.value.slice(0, TEXT_LIMIT) };
  }
  throw new Error("Please upload a PDF, page photos (JPG/PNG/WEBP), DOCX, TXT or MD file.");
}

const navItems = [
  { id: "evaluate", label: "Answer evaluator", icon: FileCheck2 },
  { id: "compare", label: "Copy comparison", icon: Layers3 },
  { id: "daily", label: "Daily question", icon: Target },
];

function App() {
  const [page, setPage] = useState("evaluate");
  const [mobileNav, setMobileNav] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [topper, setTopper] = useState(null);
  const [myCopy, setMyCopy] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(null); // { done, total } while OCR / parsing runs
  const [result, setResult] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [error, setError] = useState("");
  const [topic, setTopic] = useState("");
  const [subject, setSubject] = useState("General Studies II");
  const [difficulty, setDifficulty] = useState("UPSC standard");
  const [question, setQuestion] = useState(null);
  const [questionBusy, setQuestionBusy] = useState(false);

  const dateLabel = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

  async function onFile(fileList, setter) {
    setError("");
    const files = Array.from(fileList || []);
    if (!files.length || reading) return;
    try {
      if (files.some(f => f.size > 20 * 1024 * 1024)) throw new Error("A file is larger than 20 MB. Please upload a smaller file.");
      setReading({ done: 0, total: 0 });
      const parsed = await extractText(files, (done, total) => setReading({ done, total }));
      setter(parsed);
    } catch (e) { setError(e.message || "Could not read that file."); }
    finally { setReading(null); }
  }

  async function callAI(action, payload) {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI request failed. Check your Netlify function and API key.");
    return data;
  }

  async function evaluate() {
    if (!answer) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const data = await callAI("evaluate", { answer });
      setResult(data.result);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function compare() {
    if (!topper || !myCopy) return;
    setBusy(true); setError(""); setCompareResult(null);
    try {
      const data = await callAI("compare", { topper, answer: myCopy });
      setCompareResult(data.result);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function makeQuestion() {
    if (!topic.trim()) return;
    setQuestionBusy(true); setError(""); setQuestion(null);
    try {
      const data = await callAI("question", { topic, subject, difficulty });
      setQuestion(data.result);
    } catch (e) { setError(e.message); }
    finally { setQuestionBusy(false); }
  }

  return <div className="app-shell">
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <div className="brand">
        <div className="brand-mark"><span>M</span><i /></div>
        <div><div className="brand-name">MAINS<span>//</span>LAB</div><div className="brand-sub">THE ANSWER STUDIO</div></div>
        <button className="mobile-close icon-btn" onClick={() => setMobileNav(false)}><X size={18}/></button>
      </div>
      <div className="workspace-label">WORKSPACE <span>01</span></div>
      <nav>
        {navItems.map(item => {
          const Icon = item.icon;
          return <button key={item.id} className={`nav-link ${page === item.id ? "active" : ""}`} onClick={() => { setPage(item.id); setMobileNav(false); }}>
            <Icon size={17}/><span>{item.label}</span>{page === item.id && <ChevronRight className="nav-chevron" size={15}/>}
          </button>;
        })}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-orbit"><div className="orbit-core"><BrainCircuit size={22}/></div><div className="orbit-ring ring-a"/><div className="orbit-ring ring-b"/></div>
        <div className="side-note">Think sharper.<br/><b>Write better.</b></div>
        <div className="side-version">BUILT FOR THE NEXT RANK <span>✳</span></div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <button className="mobile-menu icon-btn" onClick={() => setMobileNav(true)}><Menu size={20}/></button>
        <div className="crumb"><span>MAINS LAB</span><i>/</i><b>{navItems.find(x => x.id === page)?.label.toUpperCase()}</b></div>
        <div className="top-actions"><div className="live-status"><span className="pulse-dot"/> AI ENGINE READY</div><div className="top-date">{dateLabel}</div><div className="avatar">A</div></div>
      </header>

      <div className="content">
        {error && <div className="error-banner"><CircleHelp size={17}/><span>{error}</span><button onClick={() => setError("")}><X size={15}/></button></div>}
        {reading && <div className="ocr-banner"><span className="spinner"/><div><b>{reading.total ? "Reading handwriting…" : "Preparing your file…"}</b>{reading.total > 0 && <small>{reading.done} of {reading.total} {reading.total === 1 ? "page" : "pages"} transcribed. Handwritten pages can take a few seconds each.</small>}{reading.total > 0 && <div className="ocr-bar"><i style={{ width: `${(reading.done / reading.total) * 100}%` }}/></div>}</div></div>}
        {page === "evaluate" && <section className="page-enter">
          <div className="hero-row">
            <div><div className="eyebrow"><span className="eyebrow-line"/> YOUR PERSONAL MAINS MENTOR</div><h1>Turn every answer<br/>into <em>an advantage.</em></h1><p className="hero-copy">Upload your answer. Get examiner-style feedback, actionable improvements and the next questions you should practise.</p></div>
            <div className="hero-visual"><div className="visual-grid"/><div className="glass-disc disc-back"/><div className="glass-disc disc-front"><div className="disc-inner"><BrainCircuit size={39}/><span>AI</span></div></div><div className="float-tag tag-top"><Sparkles size={13}/> DEEP ANALYSIS</div><div className="float-tag tag-bottom"><span className="tiny-bars"><i/><i/><i/><i/></span> ANSWER INTELLIGENCE</div><div className="visual-cross">✳</div></div>
          </div>
          <div className="section-heading"><div><span className="section-index">01 / SUBMIT</span><h2>Evaluate an answer</h2><p>One upload. A complete improvement roadmap.</p></div><div className="supported"><ShieldCheck size={15}/> FILES ARE NOT STORED</div></div>
          <div className="upload-panel">
            <div className="upload-main">
              <FileDrop file={answer} onFile={f => onFile(f, setAnswer)} title="Drop your answer copy here" subtitle="or browse files from your device" />
              <div className="upload-foot"><span><FileText size={14}/> PDF (typed or handwritten), PHOTOS, DOCX, TXT</span><span>MAX 20 MB</span></div>
            </div>
            <div className="upload-side">
              <div className="side-kicker">WHAT YOU'LL GET</div>
              <div className="benefit"><div className="benefit-icon"><Gauge size={17}/></div><div><b>Examiner-style evaluation</b><small>Structure, relevance, depth & presentation</small></div></div>
              <div className="benefit"><div className="benefit-icon"><ScanSearch size={17}/></div><div><b>Line-by-line diagnosis</b><small>What works, what is missing, what to fix</small></div></div>
              <div className="benefit"><div className="benefit-icon"><Target size={17}/></div><div><b>Targeted practice</b><small>Follow-up Mains questions on weak areas</small></div></div>
              <button className="primary-btn full-btn" disabled={!answer || busy || !!reading} onClick={evaluate}>{busy ? <><span className="spinner"/> Analysing your answer</> : <>Evaluate my answer <ArrowRight size={17}/></>}</button>
            </div>
          </div>
          {answer && <div className="file-chip"><FileCheck2 size={16}/><div><b>{answer.name}</b><small>{answer.type} · {answer.pages} {answer.pages === 1 ? "page" : "pages"} · {answer.source === "ocr" ? "handwriting transcribed" : "text extracted"}</small></div><button onClick={() => setAnswer(null)}><X size={15}/></button></div>}
          {answer?.source === "ocr" && <TranscriptReview file={answer} setFile={setAnswer} />}
          {result && <ResultPanel data={result} title="Your answer evaluation" />}
          <div className="bottom-tip"><Zap size={15}/><span><b>Pro tip:</b> Upload a complete answer with the question statement for the most accurate evaluation. Handwritten? Scan in good light and check the transcription below before evaluating.</span></div>
        </section>}

        {page === "compare" && <section className="page-enter">
          <div className="eyebrow"><span className="eyebrow-line"/> LEARN FROM THE BEST</div><h1>Study the gap.<br/><em>Close the distance.</em></h1><p className="hero-copy narrow">Compare a topper's answer with your own handwritten copy. Discover the differences in approach, structure, content and presentation.</p>
          <div className="section-heading compare-heading"><div><span className="section-index">02 / COMPARE</span><h2>Two copies. One clear direction.</h2><p>Upload both copies (typed or handwritten PDFs, or page photos) to get a side-by-side learning analysis.</p></div><div className="compare-badge"><Layers3 size={15}/> COMPARATIVE MODE</div></div>
          <div className="compare-grid">
            <div className="compare-upload"><div className="compare-number">A</div><div className="compare-title"><span>REFERENCE COPY</span><h3>Topper's answer</h3><p>The benchmark you want to learn from.</p></div><FileDrop compact file={topper} onFile={f => onFile(f, setTopper)} title="Drop topper PDF" subtitle="or browse your device" /></div>
            <div className="compare-middle"><div className="versus">VS</div><div className="versus-line"/></div>
            <div className="compare-upload"><div className="compare-number number-purple">B</div><div className="compare-title"><span>YOUR SUBMISSION</span><h3>My handwritten copy</h3><p>Your answer, ready for honest feedback.</p></div><FileDrop compact file={myCopy} onFile={f => onFile(f, setMyCopy)} title="Drop your answer PDF" subtitle="or browse your device" /></div>
          </div>
          <div className="compare-action"><div><b>Ready for your comparison?</b><small>AI will identify the gap and turn it into a practical improvement plan.</small></div><button className="primary-btn" disabled={!topper || !myCopy || busy || !!reading} onClick={compare}>{busy ? <><span className="spinner"/> Comparing copies</> : <>Compare both copies <ArrowRight size={17}/></>}</button></div>
          {(topper || myCopy) && <div className="selected-files">{topper && <span><Check size={13}/> Topper: {topper.name}</span>}{myCopy && <span><Check size={13}/> Your copy: {myCopy.name}</span>}</div>}
          {topper?.source === "ocr" && <TranscriptReview file={topper} setFile={setTopper} label="topper's copy" />}
          {myCopy?.source === "ocr" && <TranscriptReview file={myCopy} setFile={setMyCopy} label="your copy" />}
          {compareResult && <ResultPanel data={compareResult} title="Comparative analysis" />}
          <div className="comparison-note"><ShieldCheck size={16}/><span>Handwritten and scanned PDFs are read with AI handwriting recognition. Use clear, well-lit scans (dark ink, flat pages) and review the transcription before comparing.</span></div>
        </section>}

        {page === "daily" && <section className="page-enter">
          <div className="eyebrow"><span className="eyebrow-line"/> YOUR DAILY THINKING DRILL</div><h1>One topic.<br/><em>One sharper answer.</em></h1><p className="hero-copy narrow">Choose what you're studying. Get a UPSC Mains-style question designed to test understanding, analysis and balanced thinking.</p>
          <div className="daily-layout">
            <div className="daily-form panel">
              <div className="section-index">03 / QUESTION GENERATOR</div><h2>Build today's question</h2><p className="muted">Be specific with your topic for a more focused question.</p>
              <label>SUBJECT / PAPER</label><select value={subject} onChange={e => setSubject(e.target.value)}><option>General Studies I</option><option>General Studies II</option><option>General Studies III</option><option>General Studies IV</option><option>Essay</option><option>Optional — Political Science</option><option>Optional — Sociology</option><option>Optional — Geography</option><option>Optional — History</option><option>Optional — Other</option></select>
              <label>TOPIC OR THEME</label><div className="topic-input"><BookOpen size={17}/><input value={topic} onChange={e => setTopic(e.target.value)} onKeyDown={e => e.key === "Enter" && makeQuestion()} placeholder="e.g. Cooperative federalism in India"/></div>
              <label>DIFFICULTY</label><div className="difficulty-options">{["UPSC standard","Advanced","Foundational"].map(x => <button key={x} className={difficulty === x ? "selected" : ""} onClick={() => setDifficulty(x)}>{x}</button>)}</div>
              <button className="primary-btn full-btn generate-btn" disabled={!topic.trim() || questionBusy} onClick={makeQuestion}>{questionBusy ? <><span className="spinner"/> Crafting question</> : <><Sparkles size={17}/> Generate Mains question <ArrowRight size={17}/></>}</button>
              <div className="daily-foot"><RefreshCw size={13}/> Generate a fresh question whenever you need a new challenge.</div>
            </div>
            <div className="question-stage">
              <div className="stage-orb"><div className="stage-orb-inner"><GraduationCap size={34}/><span>DAILY<br/>DRILL</span></div></div>
              {question ? <div className="question-card"><div className="question-top"><span><span className="pulse-dot"/> YOUR QUESTION</span><span>{subject}</span></div><div className="question-topic">{topic}</div><h3>{question.question || question}</h3>{question.directive && <div className="directive"><span>DIRECTIVE</span>{question.directive}</div>}{question.approach && <div className="approach"><b>How to approach</b><p>{question.approach}</p></div>}{question.value_addition && <div className="value-add"><Sparkles size={14}/>{question.value_addition}</div>}</div> : <div className="empty-question"><div className="empty-dash">✳</div><h3>Your next challenge<br/>starts here.</h3><p>Your generated question will appear here, along with a suggested approach and value-addition angle.</p><div className="empty-meta"><span>10 / 15 MARKS</span><span>ANALYTICAL</span><span>UPSC PATTERN</span></div></div>}
            </div>
          </div>
        </section>}
        <footer className="footer"><span>MAINS//LAB <i>✳</i> BUILT FOR BETTER ANSWERS</span><span>AN AI STUDY COMPANION · NOT AN OFFICIAL UPSC PRODUCT</span></footer>
      </div>
    </main>
  </div>;
}

function FileDrop({ file, onFile, title, subtitle, compact = false }) {
  const [drag, setDrag] = useState(false);
  return <label className={`drop-zone ${compact ? "compact-drop" : ""} ${drag ? "dragging" : ""} ${file ? "has-file" : ""}`}
    onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
    onDrop={e => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files); }}>
    <input type="file" multiple accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp,application/pdf,image/*" onChange={e => { onFile(e.target.files); e.target.value = ""; }}/>
    <div className="drop-icon"><UploadCloud size={compact ? 21 : 25}/></div>
    <b>{file ? "File ready to analyse" : title}</b><span>{file ? file.name : subtitle}</span>
    {!file && <small>BROWSE FILES <ArrowDown size={11}/></small>}
  </label>;
}

function TranscriptReview({ file, setFile, label = "answer" }) {
  return <details className="ocr-review">
    <summary><ScanSearch size={15}/> Review &amp; correct the handwriting transcription ({label})</summary>
    <p>AI handwriting reading can misread words. Fix anything important before evaluating; <code>[illegible]</code> and <code>[?]</code> mark uncertain words.</p>
    <textarea value={file.text} onChange={e => setFile({ ...file, text: e.target.value })} spellCheck="false" />
  </details>;
}

function ResultPanel({ data, title }) {
  const [open, setOpen] = useState(true);
  const formatted = typeof data === "string" ? null : data;
  return <div className="result-panel">
    <div className="result-header"><div><span className="section-index">AI INSIGHT REPORT</span><h2>{title}</h2></div><button className="outline-btn" onClick={() => setOpen(!open)}>{open ? "Collapse" : "Expand"} <ArrowDown size={14}/></button></div>
    {open && (formatted ? <div className="result-content">
      {formatted.score && <div className="score-strip"><div className="score-number">{formatted.score.value ?? formatted.score}<small>/ 10</small></div><div><b>{formatted.score.label || "Indicative answer score"}</b><p>{formatted.score.rationale || "A coaching estimate, not an official UPSC marking."}</p></div></div>}
      {Object.entries(formatted).filter(([k]) => k !== "score").map(([key, val]) => <div className="result-section" key={key}><h3>{key.replaceAll("_"," ")}</h3>{Array.isArray(val) ? <ul>{val.map((v,i) => <li key={i}>{typeof v === "string" ? v : JSON.stringify(v)}</li>)}</ul> : <p>{typeof val === "object" ? JSON.stringify(val, null, 2) : String(val)}</p>}</div>)}
    </div> : <pre className="result-raw">{data}</pre>)}
  </div>;
}

createRoot(document.getElementById("root")).render(<App/>);
