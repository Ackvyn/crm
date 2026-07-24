/**
 * Public share-link signing page HTML (visual e-sign + pdf-lib bake).
 * Served by Worker at GET /v1/:site/sign/:token — not a QES / cert signature.
 *
 * Session PDF is expected pre-baked (RO values + stamps + flattened forms).
 * Signer fills fields via floating widgets anchored to the PDF (required guide
 * advances in document order; any field can be opened by clicking it).
 */

export function buildSignPageHtml({ siteKey, token, apiBase }) {
  const safeSite = String(siteKey || "").replace(/[^a-z0-9_-]/gi, "");
  const safeToken = String(token || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const base = String(apiBase || "").replace(/\/$/, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Sign document · Ackvyn CRM</title>
<style>
  :root { --bg:#f6f3ee; --ink:#1c1917; --muted:#78716c; --accent:#0f766e; --card:#fff; --line:#e7e5e4; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 "Source Sans 3", system-ui, sans-serif; color:var(--ink); background:
    radial-gradient(ellipse at 20% 0%, #dcefe9 0%, transparent 50%),
    radial-gradient(ellipse at 90% 10%, #f5e6d3 0%, transparent 45%),
    var(--bg); min-height:100dvh; }
  main { max-width:52rem; margin:0 auto; padding:1.25rem 1rem 5.5rem; }
  h1 { font-family: "Fraunces", Georgia, serif; font-weight:600; font-size:1.65rem; margin:0 0 .35rem; }
  .sub { color:var(--muted); font-size:.9rem; margin-bottom:1rem; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1rem; margin-bottom:1rem; }
  .step-title { font-family:"Fraunces", Georgia, serif; font-size:1.05rem; margin:0 0 .25rem; }
  .tabs { display:flex; gap:.35rem; margin:.55rem 0 .4rem; }
  .tab { flex:1; border:1px solid var(--line); background:#fafaf9; border-radius:8px; padding:.4rem .55rem; font:inherit; font-weight:600; color:var(--muted); cursor:pointer; }
  .tab.on { background:var(--accent); color:#fff; border-color:var(--accent); }
  .sig-wrap { position:relative; width:100%; height:140px; border:1px dashed #a8a29e; border-radius:8px; background:#fafaf9; overflow:hidden; touch-action:none; }
  .sig-wrap canvas { display:block; width:100%; height:100%; touch-action:none; }
  .type-preview { width:100%; min-height:88px; border:1px dashed #a8a29e; border-radius:8px; background:#fafaf9; display:flex; align-items:center; padding:0 .85rem;
    font-family:"Caveat", cursive; font-size:clamp(1.6rem, 6vw, 2.5rem); color:var(--ink); line-height:1.1; word-break:break-word; }
  button, .btn { appearance:none; border:0; border-radius:8px; padding:.6rem .95rem; font-weight:600; cursor:pointer; font:inherit; }
  .primary { background:var(--accent); color:#fff; }
  .primary:disabled { opacity:.45; cursor:not-allowed; }
  .ghost { background:transparent; color:var(--muted); text-decoration:underline; padding:.45rem .5rem; }
  .err { color:#b91c1c; }
  .ok { color:var(--accent); }
  label { display:block; font-size:.78rem; color:var(--muted); margin:.4rem 0 .2rem; }
  input[type=text], select { width:100%; padding:.5rem .65rem; border:1px solid #d6d3d1; border-radius:8px; font:inherit; background:#fff; }
  .actions { display:flex; gap:.55rem; flex-wrap:wrap; margin-top:.7rem; align-items:center; }
  .hint { font-size:.78rem; color:var(--muted); margin:.3rem 0 0; }
  #docPreview {
    width: 100%;
    min-height: min(62vh, 34rem);
    max-height: min(78vh, 48rem);
    overflow: auto;
    border:1px solid var(--line);
    border-radius:8px;
    background:#d6d3d1;
    padding:.65rem;
  }
  .page-wrap {
    position: relative; margin: 0 auto .75rem; width: 100%; max-width: 100%;
    background:#fff; box-shadow: 0 1px 4px rgba(0,0,0,.08);
  }
  .page-wrap:last-child { margin-bottom: 0; }
  .page-wrap canvas { display:block; width:100%; height:auto; }
  .page-overlay { position:absolute; inset:0; pointer-events:none; }
  .field-box {
    position:absolute; overflow:hidden; display:flex; align-items:center; justify-content:center;
    pointer-events:auto; cursor:pointer;
  }
  .field-box.done { background: transparent; }
  .field-box.current {
    background: rgba(15, 118, 110, 0.14);
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    box-shadow: 0 0 0 4px rgba(15, 118, 110, 0.18);
    z-index: 2;
    animation: fieldPulse 1.6s ease-in-out infinite;
  }
  .field-box.pending {
    background: rgba(120, 113, 108, 0.08);
    outline: 1px dashed rgba(120, 113, 108, 0.55);
  }
  .field-box.optional {
    background: rgba(15, 118, 110, 0.05);
    outline: 1px dashed rgba(15, 118, 110, 0.45);
    z-index: 1;
  }
  .field-box img { width:100%; height:100%; object-fit:contain; object-position:center; padding:6%; box-sizing:border-box; pointer-events:none; }
  /* NEW CODE - TESTING: sig/initials preview fills the field like the baked PDF */
  .field-box img.sig-ink {
    padding: 4%;
    object-fit: fill;
    object-position: center;
  }
  .field-box .ink {
    width:100%; padding:0 4px; color:#1c1917; line-height:1.1; text-align:center;
    font-size: clamp(11px, 2.4vw, 16px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .field-box .ink.hand { font-family:"Caveat", cursive; font-size: clamp(16px, 3.2vw, 28px); }
  .field-box .ink.check { font-weight:700; font-size: clamp(14px, 3vw, 22px); }
  @keyframes fieldPulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.16); }
    50% { box-shadow: 0 0 0 6px rgba(15, 118, 110, 0.28); }
  }
  /* Floating field widget — sits near the active PDF field */
  #fieldWidget {
    position: fixed;
    z-index: 40;
    width: min(22rem, calc(100vw - 1.5rem));
    max-height: min(70dvh, 32rem);
    overflow: auto;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(28, 25, 23, 0.18);
    padding: .85rem .9rem .95rem;
    display: none;
  }
  #fieldWidget.open { display: block; }
  #fieldWidget .widget-head {
    display:flex; align-items:flex-start; justify-content:space-between; gap:.5rem;
  }
  #fieldWidget .widget-close {
    flex-shrink:0; width:2rem; height:2rem; border-radius:8px; border:0;
    background:transparent; color:var(--muted); cursor:pointer; font-size:1.25rem; line-height:1;
  }
  #fieldWidget .widget-close:hover { background:#f5f5f4; color:var(--ink); }
  .submit-bar {
    position: fixed; left:0; right:0; bottom:0; z-index:30;
    background: rgba(255,255,255,.94); backdrop-filter: blur(8px);
    border-top: 1px solid var(--line);
    padding: .75rem 1rem calc(.75rem + env(safe-area-inset-bottom));
    display: flex; flex-wrap: wrap; gap: .65rem; align-items: center; justify-content: center;
  }
  .submit-bar .bar-meta { font-size: .82rem; color: var(--muted); margin: 0; max-width: 28rem; text-align: center; }
  .submit-bar .bar-meta strong { color: var(--ink); }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&family=Fraunces:opsz,wght@9..144,600&family=Source+Sans+3:wght@400;600&display=swap" rel="stylesheet"/>
</head>
<body>
<main>
  <h1>Review &amp; sign</h1>
  <p class="sub">Electronic signature with audit trail — not a government-certified / qualified electronic signature.</p>
  <div id="status" class="card">Loading…</div>
  <div id="app" hidden>
    <div class="card">
      <p id="meta" class="sub" style="margin-bottom:.65rem"></p>
      <div id="docPreview" aria-label="Document preview"></div>
    </div>
    <p class="sub" id="legal" style="margin-bottom:0">Click a highlighted field to fill it. Required fields open in order; you can jump to any field anytime. Checkboxes toggle when you click them.</p>
  </div>
</main>
<div id="fieldWidget" role="dialog" aria-modal="false" aria-labelledby="widgetTitle" hidden></div>
<div class="submit-bar" id="submitBar" hidden>
  <p class="bar-meta" id="barMeta"></p>
  <button type="button" class="primary" id="btnSubmit" disabled>Sign &amp; submit</button>
</div>
<script type="module">
const SITE = ${JSON.stringify(safeSite)};
const TOKEN = ${JSON.stringify(safeToken)};
const API = ${JSON.stringify(base)} + "/v1/" + SITE + "/sign/" + TOKEN;
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38";
const statusEl = document.getElementById("status");
const app = document.getElementById("app");
const meta = document.getElementById("meta");
const docPreview = document.getElementById("docPreview");
const fieldWidget = document.getElementById("fieldWidget");
const submitBar = document.getElementById("submitBar");
const barMeta = document.getElementById("barMeta");
const btnSubmit = document.getElementById("btnSubmit");

let envelope = null;
let SignaturePadCtor = null;
let signaturePad = null;
let padCanvas = null;
let typedName = "";
/** fieldId -> string | { mode, png?, text? } */
const captures = Object.create(null);
let sigMode = "draw";
let pdfBytes = null;
/** Currently open floating widget field (required or optional). */
let activeField = null;
/** After save, auto-open the next incomplete required field. */
let guideAfterSave = true;

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = "card" + (cls ? " " + cls : "");
  statusEl.hidden = false;
}

function isSignerEditable(field) {
  return Boolean(field) && !field.readOnly;
}

function fieldIsRequired(field) {
  if (!isSignerEditable(field)) return false;
  if (typeof field.required === "boolean") return field.required;
  return field.type === "signature" || field.type === "initials";
}

/** Keep only digits, one optional leading minus, and one decimal point. */
function sanitizeNumberInput(raw) {
  let s = String(raw || "").replace(/[^\d.\-]/g, "");
  const neg = s.startsWith("-");
  s = s.replace(/-/g, "");
  const parts = s.split(".");
  s = parts[0] + (parts.length > 1 ? "." + parts.slice(1).join("") : "");
  return (neg ? "-" : "") + s;
}

function isValidSignedNumber(s) {
  return (
    /^-?(?:\d+\.?\d*|\.\d+)$/.test(String(s || "")) &&
    Number.isFinite(Number(s))
  );
}

function guessInitials(name) {
  const parts = String(name || "").trim().split(/\\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fieldLabel(field) {
  const custom = String(field.label || "").trim();
  if (custom) return custom;
  if (field.type === "signature") return "Signature";
  if (field.type === "initials") return "Initials";
  if (field.type === "checkbox") return "Checkbox";
  if (field.type === "dropdown") return "Choice";
  if (field.type === "text") return "Text";
  // NEW CODE - TESTING
  if (field.type === "number") return "Number";
  if (field.type === "name") return "Name";
  if (field.type === "date") return "Date";
  return "Field";
}

function fieldDocOrder(a, b) {
  const pa = Math.max(1, Number(a.page) || 1);
  const pb = Math.max(1, Number(b.page) || 1);
  if (pa !== pb) return pa - pb;
  const ya = Number(a.y) || 0;
  const yb = Number(b.y) || 0;
  if (Math.abs(ya - yb) > 0.008) return ya - yb;
  return (Number(a.x) || 0) - (Number(b.x) || 0);
}

function signerDisplayName() {
  return (
    String(typedName || "").trim() ||
    String((envelope && envelope.contactName) || "").trim() ||
    "Signer"
  );
}

function fieldIsFilled(field) {
  if (!field) return false;
  if (field.type === "checkbox") return captures[field.id] === "yes";
  const cap = captures[field.id];
  if (cap == null) return false;
  if (typeof cap === "object") {
    if (cap.png) return true;
    if (String(cap.text || "").trim()) return true;
    return false;
  }
  return Boolean(String(cap).trim());
}

/** Required fields that use a widget (not date / checkbox). */
function requiredWidgetFields() {
  return (envelope.fields || [])
    .filter(
      (f) =>
        f &&
        fieldIsRequired(f) &&
        f.type !== "date" &&
        f.type !== "checkbox",
    )
    .slice()
    .sort(fieldDocOrder);
}

function requiredCheckboxesUnchecked() {
  return (envelope.fields || []).filter(
    (f) =>
      f &&
      f.type === "checkbox" &&
      fieldIsRequired(f) &&
      captures[f.id] !== "yes",
  );
}

function nextIncompleteRequired(afterId) {
  const list = requiredWidgetFields();
  const incomplete = list.filter((f) => !fieldIsFilled(f));
  if (!incomplete.length) return null;
  if (!afterId) return incomplete[0];
  const order = list.map((f) => f.id);
  const afterIdx = order.indexOf(afterId);
  for (let i = afterIdx + 1; i < list.length; i++) {
    if (!fieldIsFilled(list[i])) return list[i];
  }
  for (let i = 0; i <= afterIdx; i++) {
    if (!fieldIsFilled(list[i])) return list[i];
  }
  return null;
}

function allRequiredComplete() {
  if (requiredCheckboxesUnchecked().length) return false;
  return requiredWidgetFields().every((f) => fieldIsFilled(f));
}

function updateSubmitBar() {
  submitBar.hidden = false;
  const req = requiredWidgetFields();
  const done = req.filter((f) => fieldIsFilled(f)).length;
  const checksLeft = requiredCheckboxesUnchecked().length;
  const ready = allRequiredComplete();
  let msg =
    req.length || checksLeft
      ? "Required fields <strong>" +
        done +
        "</strong> of <strong>" +
        req.length +
        "</strong>"
      : "No required fields";
  if (checksLeft) {
    msg +=
      " · <span class=\\"err\\">" +
      checksLeft +
      " checkbox" +
      (checksLeft === 1 ? "" : "es") +
      " still unchecked</span>";
  }
  if (ready) {
    msg =
      "Ready to sign as <strong>" +
      escapeHtml(signerDisplayName()) +
      "</strong>";
  }
  barMeta.innerHTML = msg;
  btnSubmit.disabled = !ready;
  btnSubmit.textContent = ready ? "I agree — sign & submit" : "Sign & submit";
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function toggleCheckboxField(field) {
  if (!field || field.type !== "checkbox") return;
  if (captures[field.id] === "yes") {
    delete captures[field.id];
  } else {
    captures[field.id] = "yes";
  }
  statusEl.hidden = true;
  paintFieldOverlays();
  updateSubmitBar();
  // Keep guiding: if required checks remain, scroll to next unchecked
  if (fieldIsRequired(field) && captures[field.id] === "yes") {
    const left = requiredCheckboxesUnchecked();
    if (left.length) {
      const el = docPreview.querySelector(
        '.field-box[data-field-id="' + left[0].id + '"]',
      );
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (guideAfterSave) {
      const next = nextIncompleteRequired(null);
      if (next) openFieldWidget(next, { scroll: true });
    }
  }
}

function closeFieldWidget() {
  activeField = null;
  signaturePad = null;
  padCanvas = null;
  fieldWidget.classList.remove("open");
  fieldWidget.hidden = true;
  fieldWidget.innerHTML = "";
  paintFieldOverlays();
}

function positionFieldWidget() {
  if (!activeField || !fieldWidget.classList.contains("open")) return;
  const box = docPreview.querySelector(
    '.field-box[data-field-id="' + activeField.id + '"]',
  );
  const margin = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const wRect = fieldWidget.getBoundingClientRect();
  const ww = wRect.width || Math.min(352, vw - 24);
  const wh = wRect.height || 200;
  let left;
  let top;
  if (box) {
    const r = box.getBoundingClientRect();
    // Prefer below the field; flip above if needed
    left = r.left + r.width / 2 - ww / 2;
    top = r.bottom + 10;
    if (top + wh > vh - 72) {
      top = r.top - wh - 10;
    }
    if (top < margin) top = margin;
    // Prefer to the right if vertical space is tight and field is leftish
    if (r.bottom + 10 + wh > vh - 72 && r.top - wh - 10 < margin) {
      left = r.right + 10;
      top = Math.max(margin, Math.min(r.top, vh - wh - 72));
      if (left + ww > vw - margin) {
        left = r.left - ww - 10;
      }
    }
  } else {
    left = (vw - ww) / 2;
    top = Math.max(margin, vh * 0.2);
  }
  left = Math.max(margin, Math.min(left, vw - ww - margin));
  top = Math.max(margin, Math.min(top, vh - wh - 64));
  fieldWidget.style.left = Math.round(left) + "px";
  fieldWidget.style.top = Math.round(top) + "px";
}

function openFieldWidget(field, opts = {}) {
  if (!field || !isSignerEditable(field) || field.type === "date") return;
  if (field.type === "checkbox") {
    toggleCheckboxField(field);
    return;
  }
  statusEl.hidden = true;
  activeField = field;
  signaturePad = null;
  padCanvas = null;
  const optional = !fieldIsRequired(field);
  const reqList = requiredWidgetFields();
  const ord = reqList.findIndex((f) => f.id === field.id) + 1;
  renderWidgetBody(field, {
    optional,
    ord: optional ? 0 : ord,
    fieldCount: reqList.length,
  });
  fieldWidget.hidden = false;
  fieldWidget.classList.add("open");
  paintFieldOverlays();
  const scroll = opts.scroll !== false;
  requestAnimationFrame(() => {
    if (scroll) {
      const el = docPreview.querySelector(
        '.field-box[data-field-id="' + field.id + '"]',
      );
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    positionFieldWidget();
    // Reposition after layout / scroll settle
    setTimeout(positionFieldWidget, 280);
    setTimeout(positionFieldWidget, 520);
  });
}

function jumpToField(field) {
  if (!field || !isSignerEditable(field) || field.type === "date") return;
  if (field.type === "checkbox") {
    toggleCheckboxField(field);
    return;
  }
  // Clicking any field replaces the current widget
  openFieldWidget(field, { scroll: true });
}

async function renderPdfPages() {
  const pdfjs = await import(PDFJS_CDN + "/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "/build/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise;
  docPreview.innerHTML = "";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const hostW = Math.max(
    320,
    Math.floor(docPreview.clientWidth || docPreview.getBoundingClientRect().width || 640) - 16,
  );
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = hostW / base.width;
    const viewport = page.getViewport({ scale: Math.min(Math.max(scale, 0.75), 2.5) });
    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.page = String(n);
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const overlay = document.createElement("div");
    overlay.className = "page-overlay";
    wrap.appendChild(canvas);
    wrap.appendChild(overlay);
    docPreview.appendChild(wrap);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  }
  if (typeof doc.destroy === "function") {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
  paintFieldOverlays();
}

function paintFieldOverlays() {
  const activeId = activeField && activeField.id;
  document.querySelectorAll(".page-overlay").forEach((ov) => {
    ov.innerHTML = "";
  });

  for (const field of envelope.fields || []) {
    if (!field || !isSignerEditable(field)) continue;
    if (field.type === "date") continue;

    const page = Math.max(1, Number(field.page) || 1);
    const wrap = docPreview.querySelector('.page-wrap[data-page="' + page + '"]');
    if (!wrap) continue;
    const overlay = wrap.querySelector(".page-overlay");
    if (!overlay) continue;

    const box = document.createElement("div");
    box.className = "field-box";
    box.style.left = (Number(field.x) || 0) * 100 + "%";
    box.style.top = (Number(field.y) || 0) * 100 + "%";
    box.style.width = (Number(field.w) || 0.1) * 100 + "%";
    box.style.height = (Number(field.h) || 0.04) * 100 + "%";
    box.dataset.fieldId = field.id || "";

    if (field.type === "checkbox") {
      box.title =
        fieldLabel(field) +
        (captures[field.id] === "yes"
          ? " (checked — click to uncheck)"
          : " (click to check)");
    } else {
      box.title =
        fieldLabel(field) +
        (fieldIsRequired(field) ? " (required)" : " (optional — click to fill)");
    }

    const cap = captures[field.id];
    const isCurrent = field.id === activeId;
    if (field.type === "checkbox") {
      if (cap === "yes") box.classList.add("done");
      else if (fieldIsRequired(field)) box.classList.add("pending");
      else box.classList.add("optional");
    } else if (isCurrent) box.classList.add("current");
    else if (fieldIsFilled(field)) box.classList.add("done");
    else if (fieldIsRequired(field)) box.classList.add("pending");
    else box.classList.add("optional");

    if (cap && typeof cap === "object" && cap.png) {
      const img = document.createElement("img");
      img.src = cap.png;
      img.alt = fieldLabel(field);
      if (field.type === "signature" || field.type === "initials") {
        img.className = "sig-ink";
      }
      box.appendChild(img);
    } else if (field.type === "checkbox") {
      if (cap === "yes") {
        const ink = document.createElement("div");
        ink.className = "ink check";
        ink.textContent = "X";
        box.appendChild(ink);
      }
    } else if (typeof cap === "string" && cap) {
      const ink = document.createElement("div");
      ink.className = "ink";
      ink.textContent = cap;
      box.appendChild(ink);
    } else if (cap && cap.text) {
      const ink = document.createElement("div");
      ink.className = "ink hand";
      ink.textContent = cap.text;
      box.appendChild(ink);
    }

    box.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      jumpToField(field);
    });

    overlay.appendChild(box);
  }
}

function resizeSignaturePad() {
  if (!padCanvas || !signaturePad) return;
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const rect = padCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * ratio));
  const h = Math.max(1, Math.floor(rect.height * ratio));
  if (padCanvas.width === w && padCanvas.height === h) return;
  const data = signaturePad.isEmpty() ? null : signaturePad.toData();
  padCanvas.width = w;
  padCanvas.height = h;
  const ctx = padCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(ratio, ratio);
  signaturePad.clear();
  if (data) signaturePad.fromData(data);
}

async function ensureHandFont() {
  try {
    if (document.fonts && document.fonts.load) {
      await document.fonts.load('48px "Caveat"');
    }
  } catch { /* ignore */ }
}

function canvasToTrimmedPng(sourceCanvas, padRatio) {
  if (!sourceCanvas) return null;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  if (!w || !h) return null;
  const ctx = sourceCanvas.getContext("2d");
  if (!ctx) return null;
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  // Ignore faint anti-alias / noise so trim stays tight around real ink
  const alphaMin = 28;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > alphaMin) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = Math.max(
    2,
    Math.ceil(Math.max(w, h) * (typeof padRatio === "number" ? padRatio : 0.03)),
  );
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  out.getContext("2d").drawImage(sourceCanvas, minX, minY, tw, th, 0, 0, tw, th);
  return out;
}

/** Pack trimmed ink into a field-aspect canvas so preview + bake share the same fill. */
function packInkForField(sourceCanvas, field) {
  const trimmed = canvasToTrimmedPng(sourceCanvas, 0.04);
  if (!trimmed) return null;
  const fw = Math.max(0.04, Number(field && field.w) || 0.25);
  const fh = Math.max(0.02, Number(field && field.h) || 0.06);
  const aspect = fw / fh;
  const outW = 900;
  const outH = Math.max(48, Math.round(outW / aspect));
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  ctx.clearRect(0, 0, outW, outH);
  const iw = trimmed.width;
  const ih = trimmed.height;
  const fit = Math.min(outW / iw, outH / ih);
  const drawW = iw * fit;
  const drawH = ih * fit;
  ctx.drawImage(
    trimmed,
    (outW - drawW) / 2,
    (outH - drawH) / 2,
    drawW,
    drawH,
  );
  return out.toDataURL("image/png");
}

async function handwritingPng(text, opts = {}) {
  await ensureHandFont();
  const width = opts.width || 700;
  const height = opts.height || 180;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#1c1917";
  const size = Math.min(Math.floor(height * 0.62), Math.floor(width / Math.max(4, text.length * 0.55)));
  ctx.font = size + 'px "Caveat", cursive';
  ctx.textBaseline = "middle";
  ctx.fillText(String(text || "").trim(), Math.floor(width * 0.05), height / 2);
  if (opts.field) {
    return packInkForField(c, opts.field) || c.toDataURL("image/png");
  }
  const trimmed = canvasToTrimmedPng(c, 0.04);
  return trimmed ? trimmed.toDataURL("image/png") : c.toDataURL("image/png");
}

function renderWidgetBody(field, meta) {
  const title = fieldLabel(field);
  const optional = Boolean(meta.optional);
  const ord = meta.ord || 0;
  const fieldCount = meta.fieldCount || 0;
  const hint = optional
    ? "Optional · page " + (field.page || 1)
    : "Required " + ord + " of " + fieldCount + " · page " + (field.page || 1);

  let body = "";
  if (field.type === "name") {
    body =
      '<label for="cf_name">Name</label>' +
      '<input id="cf_name" type="text" autocomplete="name" placeholder="Full name"/>';
  } else if (field.type === "signature" || field.type === "initials") {
    const isInit = field.type === "initials";
    sigMode = "draw";
    body =
      '<div class="tabs">' +
      '<button type="button" class="tab on" data-mode="draw">Draw</button>' +
      '<button type="button" class="tab" data-mode="type">Type</button>' +
      "</div>" +
      '<div id="drawPane"><div class="sig-wrap"><canvas id="pad"></canvas></div></div>' +
      '<div id="typePane" hidden>' +
      '<label for="typedSig">' +
      (isInit ? "Type initials" : "Type your signature") +
      "</label>" +
      '<input id="typedSig" type="text" maxlength="' +
      (isInit ? "8" : "80") +
      '" placeholder="' +
      (isInit ? "e.g. JD" : "Your name as a signature") +
      '"/>' +
      '<div class="type-preview" id="typePreview" aria-hidden="true"></div>' +
      "</div>";
  } else if (field.type === "dropdown") {
    const opts = Array.isArray(field.options) ? field.options : [];
    body =
      '<label for="cf_sel">Choose</label><select id="cf_sel"><option value="">Select…</option>';
    for (const o of opts) {
      const s = String(o || "").trim();
      if (!s) continue;
      body += '<option value="' + escapeAttr(s) + '">' + escapeHtml(s) + "</option>";
    }
    body += "</select>";
  } else if (field.type === "number") {
    // NEW CODE - TESTING: numeric-only input
    body =
      '<label for="cf_num">Number</label>' +
      '<input id="cf_num" type="text" inputmode="decimal" autocomplete="off" placeholder="' +
      escapeAttr(title) +
      '"/>';
  } else {
    body =
      '<label for="cf_text">Your answer</label>' +
      '<input id="cf_text" type="text" placeholder="' +
      escapeAttr(title) +
      '"/>';
  }

  fieldWidget.innerHTML =
    '<div class="widget-head">' +
    '<div>' +
    '<p class="step-title" id="widgetTitle">' +
    escapeHtml(title) +
    (optional ? ' <span class="hint">(optional)</span>' : "") +
    "</p>" +
    '<p class="hint">' +
    escapeHtml(hint) +
    "</p>" +
    "</div>" +
    '<button type="button" class="widget-close" id="btnWidgetClose" aria-label="Close" title="Close">×</button>' +
    "</div>" +
    '<div id="widgetBody">' +
    body +
    "</div>" +
    '<div class="actions">' +
    (field.type === "signature" || field.type === "initials"
      ? '<button type="button" class="ghost" id="btnClearPad">Clear</button>'
      : "") +
    (optional
      ? '<button type="button" class="ghost" id="btnSkipOptional">Skip</button>'
      : "") +
    '<button type="button" class="primary" id="btnSaveField">' +
    (optional ? "Save" : "Save &amp; continue") +
    "</button>" +
    "</div>";

  document.getElementById("btnWidgetClose").onclick = () => {
    closeFieldWidget();
  };

  const saveBtn = document.getElementById("btnSaveField");
  saveBtn.onclick = () => {
    void onSaveActiveField();
  };

  const skipBtn = document.getElementById("btnSkipOptional");
  if (skipBtn) {
    skipBtn.onclick = () => {
      if (!activeField) return;
      delete captures[activeField.id];
      const wasId = activeField.id;
      closeFieldWidget();
      updateSubmitBar();
      if (guideAfterSave) {
        const next = nextIncompleteRequired(wasId);
        if (next) openFieldWidget(next, { scroll: true });
      }
    };
  }

  if (field.type === "name") {
    const inp = document.getElementById("cf_name");
    inp.value =
      captures[field.id] ||
      typedName ||
      (envelope && envelope.contactName) ||
      "";
    inp.focus();
    inp.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void onSaveActiveField();
      }
    };
  } else if (field.type === "signature" || field.type === "initials") {
    wireSigStep(field);
    const clearBtn = document.getElementById("btnClearPad");
    if (clearBtn) {
      clearBtn.onclick = () => {
        if (signaturePad) signaturePad.clear();
      };
    }
  } else if (field.type === "dropdown") {
    const sel = document.getElementById("cf_sel");
    sel.value = captures[field.id] || field.value || "";
  } else if (field.type === "number") {
    // NEW CODE - TESTING
    const inp = document.getElementById("cf_num");
    inp.value = captures[field.id] || field.value || "";
    inp.focus();
    inp.oninput = () => {
      inp.value = sanitizeNumberInput(inp.value);
    };
    inp.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void onSaveActiveField();
      }
    };
  } else {
    const inp = document.getElementById("cf_text");
    inp.value = captures[field.id] || field.value || "";
    inp.focus();
    inp.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void onSaveActiveField();
      }
    };
  }
}

function wireSigStep(field) {
  const drawPane = document.getElementById("drawPane");
  const typePane = document.getElementById("typePane");
  const typedSig = document.getElementById("typedSig");
  const typePreview = document.getElementById("typePreview");
  padCanvas = document.getElementById("pad");
  signaturePad = new SignaturePadCtor(padCanvas, {
    backgroundColor: "rgba(0,0,0,0)",
    penColor: "rgb(28, 25, 23)",
  });
  window.removeEventListener("resize", onLayoutChange);
  window.addEventListener("resize", onLayoutChange);
  requestAnimationFrame(() => {
    resizeSignaturePad();
    positionFieldWidget();
    const prev = captures[field.id];
    if (prev && prev.mode === "type" && prev.text) {
      sigMode = "type";
      setSigModeUi();
      typedSig.value = prev.text;
      typePreview.textContent = prev.text;
    }
  });

  fieldWidget.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      sigMode = tab.getAttribute("data-mode") || "draw";
      setSigModeUi();
      requestAnimationFrame(positionFieldWidget);
    };
  });

  function setSigModeUi() {
    fieldWidget.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("on", t.getAttribute("data-mode") === sigMode);
    });
    drawPane.hidden = sigMode !== "draw";
    typePane.hidden = sigMode !== "type";
    if (sigMode === "draw") requestAnimationFrame(resizeSignaturePad);
    if (sigMode === "type") {
      if (!typedSig.value.trim()) {
        const fallback = signerDisplayName();
        typedSig.value =
          field.type === "initials"
            ? guessInitials(fallback)
            : fallback === "Signer"
              ? ""
              : fallback;
      }
      typePreview.textContent = typedSig.value;
      typedSig.focus();
    }
  }

  typedSig.oninput = () => {
    let v = typedSig.value;
    if (field.type === "initials") v = v.toUpperCase();
    typedSig.value = v;
    typePreview.textContent = v;
  };
}

async function commitFieldCapture(field, opts = {}) {
  const allowEmpty = Boolean(opts.allowEmpty);

  if (field.type === "name") {
    const inp = document.getElementById("cf_name");
    const v = ((inp && inp.value) || "").trim();
    if (!v) {
      if (allowEmpty) {
        delete captures[field.id];
        return true;
      }
      setStatus("Enter a name for this field", "err");
      return false;
    }
    captures[field.id] = v;
    typedName = v;
    return true;
  }

  if (field.type === "signature" || field.type === "initials") {
    if (sigMode === "draw") {
      resizeSignaturePad();
      if (!signaturePad || signaturePad.isEmpty()) {
        if (allowEmpty) {
          delete captures[field.id];
          return true;
        }
        setStatus(
          field.type === "initials"
            ? "Draw your initials"
            : "Draw your signature",
          "err",
        );
        return false;
      }
      captures[field.id] = {
        mode: "draw",
        // NEW CODE - TESTING: pack ink into field aspect so overlay matches bake
        png:
          packInkForField(padCanvas, field) ||
          signaturePad.toDataURL("image/png"),
      };
    } else {
      const typedSig = document.getElementById("typedSig");
      let text = ((typedSig && typedSig.value) || "").trim();
      if (field.type === "initials") text = text.toUpperCase();
      if (!text) {
        if (allowEmpty) {
          delete captures[field.id];
          return true;
        }
        setStatus(
          field.type === "initials"
            ? "Type your initials"
            : "Type your signature",
          "err",
        );
        return false;
      }
      const png = await handwritingPng(text, { field });
      captures[field.id] = { mode: "type", text, png };
    }
    return true;
  }

  if (field.type === "dropdown") {
    const sel = document.getElementById("cf_sel");
    const v = ((sel && sel.value) || "").trim();
    if (!v) {
      if (allowEmpty) {
        delete captures[field.id];
        return true;
      }
      setStatus("Make a selection", "err");
      return false;
    }
    captures[field.id] = v;
    return true;
  }

  // NEW CODE - TESTING: number field
  if (field.type === "number") {
    const inp = document.getElementById("cf_num");
    const v = sanitizeNumberInput(((inp && inp.value) || "").trim());
    if (!v) {
      if (allowEmpty) {
        delete captures[field.id];
        return true;
      }
      setStatus("Enter a number", "err");
      return false;
    }
    if (!isValidSignedNumber(v)) {
      setStatus("Enter a valid number", "err");
      return false;
    }
    captures[field.id] = v;
    return true;
  }

  const inp = document.getElementById("cf_text");
  const v = ((inp && inp.value) || "").trim();
  if (!v) {
    if (allowEmpty) {
      delete captures[field.id];
      return true;
    }
    setStatus("Fill in this field", "err");
    return false;
  }
  captures[field.id] = v;
  return true;
}

async function onSaveActiveField() {
  if (!activeField) return;
  const field = activeField;
  const optional = !fieldIsRequired(field);
  const ok = await commitFieldCapture(field, { allowEmpty: optional });
  if (!ok) return;
  statusEl.hidden = true;
  const wasId = field.id;
  closeFieldWidget();
  updateSubmitBar();
  if (guideAfterSave) {
    const next = nextIncompleteRequired(wasId);
    if (next) {
      openFieldWidget(next, { scroll: true });
    } else {
      const checks = requiredCheckboxesUnchecked();
      if (checks.length) {
        const el = docPreview.querySelector(
          '.field-box[data-field-id="' + checks[0].id + '"]',
        );
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }
}

function onLayoutChange() {
  resizeSignaturePad();
  positionFieldWidget();
  paintFieldOverlays();
}

async function boot() {
  try {
    const [{ default: SignaturePad }, pdfLib] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/signature_pad@5.0.4/+esm"),
      import("https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm"),
    ]);
    SignaturePadCtor = SignaturePad;
    window.__pdfLib = pdfLib;
    await ensureHandFont();

    const res = await fetch(API + "/envelope");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Session unavailable");
    envelope = data;
    typedName = data.contactName || "";
    meta.textContent =
      (data.filename || "Document") +
      " · for " +
      (data.contactEmail || "signer");

    pdfBytes = Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0));
    statusEl.hidden = true;
    app.hidden = false;
    await renderPdfPages();
    updateSubmitBar();

    // Start guide on first incomplete required field
    const first = nextIncompleteRequired(null);
    if (first) {
      openFieldWidget(first, { scroll: true });
    } else {
      const checks = requiredCheckboxesUnchecked();
      if (checks.length) {
        const el = docPreview.querySelector(
          '.field-box[data-field-id="' + checks[0].id + '"]',
        );
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    btnSubmit.onclick = async () => {
      if (!allRequiredComplete()) {
        const next = nextIncompleteRequired(null);
        if (next) {
          openFieldWidget(next, { scroll: true });
          setStatus("Please complete required fields first", "err");
          return;
        }
        const checks = requiredCheckboxesUnchecked();
        if (checks.length) {
          setStatus(
            "Please check “" + fieldLabel(checks[0]) + "” on the document",
            "err",
          );
          const el = docPreview.querySelector(
            '.field-box[data-field-id="' + checks[0].id + '"]',
          );
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      btnSubmit.disabled = true;
      try {
        closeFieldWidget();
        await submitSign();
      } finally {
        if (!app.hidden) {
          updateSubmitBar();
        }
      }
    };

    docPreview.addEventListener("scroll", () => {
      positionFieldWidget();
    }, { passive: true });
    window.addEventListener("resize", onLayoutChange);
    window.addEventListener("scroll", positionFieldWidget, { passive: true });
  } catch (err) {
    setStatus(err.message || "Could not load signing session", "err");
  }
}

async function sha256Hex(bytes) {
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resolveFieldText(field, name, today) {
  if (field.readOnly) {
    if (field.type === "checkbox") return field.value === "yes" ? "yes" : "no";
    return String(field.value || "").trim();
  }
  if (field.type === "date") return today;
  if (field.type === "name") {
    if (Object.prototype.hasOwnProperty.call(captures, field.id)) {
      return String(captures[field.id] || "").trim();
    }
    const fallback = String(field.value || "").trim();
    if (fallback) return fallback;
    return fieldIsRequired(field) ? name : "";
  }
  if (field.type === "initials") {
    const cap = captures[field.id];
    if (cap && typeof cap === "object" && cap.text) return String(cap.text).toUpperCase();
    if (typeof cap === "string") return cap.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(captures, field.id)) return "";
    return fieldIsRequired(field) ? guessInitials(name) : "";
  }
  if (field.type === "text" || field.type === "number" || field.type === "dropdown" || field.type === "checkbox") {
    return captures[field.id] || String(field.value || "").trim();
  }
  return name;
}

async function submitSign() {
  const missingChecks = requiredCheckboxesUnchecked();
  if (missingChecks.length) {
    setStatus(
      "Please check “" +
        fieldLabel(missingChecks[0]) +
        "” on the document (click the box)" +
        (missingChecks.length > 1 ? " — and any other required boxes" : ""),
      "err",
    );
    const el = docPreview.querySelector(
      '.field-box[data-field-id="' + missingChecks[0].id + '"]',
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    paintFieldOverlays();
    updateSubmitBar();
    return;
  }
  const missing = nextIncompleteRequired(null);
  if (missing) {
    openFieldWidget(missing, { scroll: true });
    setStatus("Please complete “" + fieldLabel(missing) + "”", "err");
    return;
  }

  const signerName = signerDisplayName();
  setStatus("Preparing signed PDF…");
  try {
    const { PDFDocument, rgb, StandardFonts } = window.__pdfLib;
    const docBytes = pdfBytes.slice();
    const pdfDoc = await PDFDocument.load(docBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const today = new Date().toLocaleDateString();
    const pngCache = Object.create(null);

    for (const field of envelope.fields || []) {
      if (!field || field.readOnly) continue;
      const page = pages[Math.max(0, (field.page || 1) - 1)];
      if (!page) continue;
      const { width, height } = page.getSize();
      const x = field.x * width;
      const y = height - (field.y + field.h) * height;
      const w = field.w * width;
      const h = field.h * height;

      if (field.type === "signature" || field.type === "initials") {
        const cap = captures[field.id];
        if (cap && cap.png) {
          if (!pngCache[field.id]) {
            pngCache[field.id] = await pdfDoc.embedPng(cap.png);
          }
          // NEW CODE - TESTING: packed PNG already matches field aspect — stretch to box
          const img = pngCache[field.id];
          const inset = Math.max(1.5, Math.min(w, h) * 0.05);
          const boxW = Math.max(4, w - inset * 2);
          const boxH = Math.max(4, h - inset * 2);
          page.drawImage(img, {
            x: x + inset,
            y: y + inset,
            width: boxW,
            height: boxH,
          });
        } else if (field.type === "initials") {
          const text = resolveFieldText(field, signerName, today);
          if (text) {
            const inset = Math.max(2.5, Math.min(w, h) * 0.08);
            page.drawText(text, {
              x: x + inset,
              y: y + inset + (h - inset * 2) * 0.2,
              size: Math.min(18, Math.max(9, (h - inset * 2) * 0.75)),
              font,
              color: rgb(0.05, 0.05, 0.05),
              maxWidth: Math.max(8, w - inset * 2),
            });
          }
        }
        continue;
      }

      if (field.type === "checkbox") {
        const on = resolveFieldText(field, signerName, today) === "yes";
        if (!field.stamp) {
          page.drawRectangle({
            x, y, width: Math.min(w, h), height: Math.min(w, h),
            borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 1.2,
          });
        }
        if (on) {
          const s = Math.min(w, h);
          page.drawText("X", {
            x: x + s * 0.18, y: y + s * 0.18,
            size: Math.max(8, s * 0.7), font, color: rgb(0.05, 0.05, 0.05),
          });
        }
        continue;
      }

      const text = resolveFieldText(field, signerName, today);
      if (fieldIsRequired(field) && !text) {
        throw new Error("Missing: " + fieldLabel(field));
      }
      if (!text) continue;
      const size =
        field.type === "initials"
          ? Math.min(18, Math.max(9, h * 0.85))
          : Math.min(14, h * 0.7);
      page.drawText(text, {
        x: x + 2, y: y + h * 0.22, size, font,
        color: rgb(0.05, 0.05, 0.05), maxWidth: Math.max(8, w - 4),
      });
    }

    const out = await pdfDoc.save();
    const signedSha256 = await sha256Hex(out);
    let b64 = "";
    const chunk = 0x8000;
    for (let i = 0; i < out.length; i += chunk) {
      b64 += String.fromCharCode.apply(null, out.subarray(i, i + chunk));
    }
    b64 = btoa(b64);
    const res = await fetch(API + "/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signedPdfBase64: b64,
        signedSha256,
        signerName,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || "Submit failed");
    app.hidden = true;
    submitBar.hidden = true;
    closeFieldWidget();
    setStatus("Signed. Thank you — you can close this page.", "ok");
  } catch (err) {
    setStatus(err.message || "Signing failed", "err");
  }
}

boot();
</script>
</body>
</html>`;
}
