const feedEl    = document.getElementById('feed');
const inp       = document.getElementById('inp');
const sendBtn   = document.getElementById('send');
const micBtn    = document.getElementById('mic');
const dot       = document.getElementById('dot');
const connText  = document.getElementById('connText');
const figmaFile = document.getElementById('figmaFile');
const fileBtn   = document.getElementById('fileBtn');
const chevron   = document.getElementById('chevron');
const fileDropdown = document.getElementById('fileDropdown');
const filePicker   = document.getElementById('filePicker');
const imgBtn       = document.getElementById('imgBtn');
const imgInput     = document.getElementById('imgInput');
const imgPreviewEl = document.getElementById('imgPreview');

// ── File picker ───────────────────────────────────────────────────────────────

let allFiles  = [];
let dropOpen  = false;

async function refreshFigmaFile() {
  try {
    const [infoRes, filesRes] = await Promise.all([
      fetch('/figma-info'),
      fetch('/files'),
    ]);
    const { name } = await infoRes.json();
    allFiles = await filesRes.json();

    figmaFile.textContent = name ?? '—';

    // Show chevron only when multiple files are available
    chevron.style.display = allFiles.length > 1 ? '' : 'none';
    fileBtn.style.cursor  = allFiles.length > 1 ? 'pointer' : 'default';
  } catch {
    figmaFile.textContent = '—';
  }
}

refreshFigmaFile();
setInterval(refreshFigmaFile, 3000);

function openDropdown() {
  if (allFiles.length <= 1) return;
  dropOpen = true;
  chevron.style.transform = 'rotate(180deg)';

  fileDropdown.innerHTML = '';

  // Auto option
  const auto = document.createElement('button');
  auto.className = 'file-option';
  auto.textContent = 'Auto (active tab)';
  auto.addEventListener('click', () => switchFile({ mode: 'auto' }));
  fileDropdown.appendChild(auto);

  // Divider
  if (allFiles.length) {
    const div = document.createElement('div');
    div.className = 'file-divider';
    fileDropdown.appendChild(div);
  }

  for (const f of allFiles) {
    const btn = document.createElement('button');
    btn.className = 'file-option';
    btn.textContent = f.title || 'Untitled';
    btn.addEventListener('click', () => switchFile({ mode: 'locked', title: f.title, url: f.url, id: f.id }));
    fileDropdown.appendChild(btn);
  }

  fileDropdown.classList.add('open');
}

function closeDropdown() {
  dropOpen = false;
  chevron.style.transform = '';
  fileDropdown.classList.remove('open');
}

function showToast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' toast-err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('toast-show'), 10);
  setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, 3000);
}

async function switchFile(data) {
  closeDropdown();
  try {
    const res = await fetch('/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.safeMode) {
      const connected = result.connected ? ` (connected: ${result.connected})` : '';
      showToast(`Safe Mode: reopen the plugin in "${data.title}"${connected}`, true);
    } else if (result.daemonMode === 'disconnected') {
      showToast(`Saved — will use "${data.title || 'auto'}" on next connect`, false);
    } else if (result.ok) {
      showToast(`Switched to "${data.title || 'auto'}"`, false);
    }
    setTimeout(refreshFigmaFile, 400);
  } catch {}
}

fileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (dropOpen) closeDropdown();
  else openDropdown();
});

document.addEventListener('click', () => { if (dropOpen) closeDropdown(); });
fileDropdown.addEventListener('click', e => e.stopPropagation());

// ── Image attach ──────────────────────────────────────────────────────────────

let attachedImage = null; // { base64, mimeType, dataUrl }

function attachImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    attachedImage = { base64: dataUrl.split(',')[1], mimeType: file.type, dataUrl };
    renderPreview();
  };
  reader.readAsDataURL(file);
}

function renderPreview() {
  if (!attachedImage) {
    imgPreviewEl.className = 'img-preview';
    imgBtn.classList.remove('has-img');
    return;
  }
  imgPreviewEl.className = 'img-preview show';
  imgPreviewEl.innerHTML = `<div class="img-thumb">
    <img src="${attachedImage.dataUrl}" alt="Attached">
    <button class="img-remove" id="imgRemove">✕</button>
  </div>`;
  document.getElementById('imgRemove').addEventListener('click', () => {
    attachedImage = null;
    renderPreview();
  });
  imgBtn.classList.add('has-img');
}

imgBtn.addEventListener('click', () => imgInput.click());
imgInput.addEventListener('change', () => {
  if (imgInput.files[0]) attachImage(imgInput.files[0]);
  imgInput.value = '';
});

// Paste screenshot from clipboard
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      attachImage(item.getAsFile());
      break;
    }
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

let sessionId = null; // claude session ID for multi-turn
let busy      = false;
let recording = false;

function setStatus(text, state) {
  dot.className        = 'dot' + (state ? ' ' + state : '');
  connText.textContent = text;
}

function scroll() { feedEl.scrollTop = feedEl.scrollHeight; }

function addUserMsg(text, imageDataUrl) {
  const d = document.createElement('div');
  d.className = 'msg user';
  const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const imgHtml = imageDataUrl ? `<img src="${imageDataUrl}" class="msg-img" alt="Screenshot">` : '';
  d.innerHTML = `<div class="avatar">U</div>
    <div class="bubble">${imgHtml}${escaped}</div>`;
  feedEl.appendChild(d);
  scroll();
}

function createAiBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = '✦';

  const bub = document.createElement('div');
  bub.className = 'bubble';

  const thinkEl = document.createElement('div');
  thinkEl.className = 'thinking';
  thinkEl.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking…`;
  bub.appendChild(thinkEl);

  wrap.appendChild(avatar);
  wrap.appendChild(bub);
  feedEl.appendChild(wrap);
  scroll();

  let currentTextEl = null;
  let currentToolEl = null;
  let started = false;

  function ensureStarted() {
    if (!started) { started = true; thinkEl.remove(); }
  }

  return {
    addText(text) {
      ensureStarted();
      currentToolEl = null;
      if (!currentTextEl) {
        currentTextEl = document.createElement('div');
        currentTextEl.className = 'resp-text';
        bub.appendChild(currentTextEl);
      }
      currentTextEl.textContent += text;
      scroll();
    },
    addTool(name, inputStr) {
      ensureStarted();
      currentTextEl = null;
      const el = document.createElement('div');
      el.className = 'tool-block';
      el.innerHTML = `<div class="tool-name">→ ${esc(name)}</div>
        <div class="tool-input">${esc(inputStr)}</div>`;
      bub.appendChild(el);
      currentToolEl = el;
      scroll();
    },
    addToolResult(text, isErr) {
      if (currentToolEl) {
        const r = document.createElement('div');
        r.className = isErr ? 'tool-err' : 'tool-result';
        r.textContent = (isErr ? '✗ ' : '✓ ') + text.slice(0, 200);
        currentToolEl.appendChild(r);
        scroll();
      }
    },
    finishThinking() { thinkEl.remove(); },
  };
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function summariseInput(input) {
  if (!input || typeof input !== 'object') return '';
  const str = JSON.stringify(input);
  return str.length > 120 ? str.slice(0, 120) + '…' : str;
}

async function sendMessage(text) {
  text = text.trim();
  if ((!text && !attachedImage) || busy) return;

  const image = attachedImage;
  attachedImage = null;
  renderPreview();

  busy = true;
  sendBtn.disabled = true;
  inp.value = '';
  inp.style.height = '';

  addUserMsg(text, image?.dataUrl);
  const bub = createAiBubble();
  setStatus('Thinking…', 'busy');

  const body = {
    prompt: text || 'Describe what you see in this screenshot.',
    sessionId,
  };
  if (image) { body.imageBase64 = image.base64; body.imageMimeType = image.mimeType; }

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error('Server error ' + res.status);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();

      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        let evt;
        try { evt = JSON.parse(part.slice(6)); } catch { continue; }

        if (evt.t === 'text')   bub.addText(evt.v);
        if (evt.t === 'tool')   bub.addTool(evt.name, summariseInput(evt.input));
        if (evt.t === 'result') bub.addToolResult(evt.v, evt.err);
        if (evt.t === 'sid')    { sessionId = evt.v; }
        if (evt.t === 'err')    bub.addText('\n[Error] ' + evt.v);
      }
    }

    bub.finishThinking();
    setStatus('Ready', '');
    refreshFigmaFile();

  } catch (err) {
    bub.addText('Error: ' + err.message);
    setStatus('Error', 'err');
    setTimeout(() => setStatus('Ready', ''), 4000);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    inp.focus();
  }
}

inp.addEventListener('input', () => {
  inp.style.height = '';
  inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
});
inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(inp.value); }
});
sendBtn.addEventListener('click', () => sendMessage(inp.value));

// Voice
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const rec = new SR();
  rec.continuous = false; rec.interimResults = true; rec.lang = 'en-US';
  rec.onstart  = () => { recording = true;  micBtn.classList.add('on'); };
  rec.onresult = e => {
    let f = '', i = '';
    for (const r of e.results) { if (r.isFinal) f += r[0].transcript; else i += r[0].transcript; }
    inp.value = f || i;
  };
  rec.onend   = () => { recording = false; micBtn.classList.remove('on'); if (inp.value.trim()) sendMessage(inp.value); };
  rec.onerror = () => { recording = false; micBtn.classList.remove('on'); };
  micBtn.addEventListener('click', () => { if (recording) rec.stop(); else try { rec.start(); } catch {} });
} else {
  micBtn.style.opacity = '.35'; micBtn.style.pointerEvents = 'none';
}

inp.focus();
