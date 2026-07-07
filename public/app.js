// Apfel Harness UI — everything runs against the local /api/* proxy.
'use strict';

const $ = (id) => document.getElementById(id);
const estTokens = (s) => Math.ceil((s || '').length / 4);
const fmt = (n) => n.toLocaleString('en-US');

// ---------- boot: theme + embed flags (Perci passes ?theme=dark&perci=1) ----------
const params = new URLSearchParams(location.search);
if (params.get('perci') === '1') document.body.classList.add('embedded');

function applyTheme(mode) {
  const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const resolved = mode === 'system' || !mode ? system : mode;
  document.documentElement.setAttribute('data-theme', resolved);
}

// ---------- state ----------
let config = {
  systemPrompt: '', temperature: 0.7, topP: null, seed: null, maxTokens: 512,
  contextStrategy: 'newest-first', contextMaxTurns: 8, themeMode: 'system',
};
let messages = []; // {role, content, tokens?}
let attachments = []; // {name, content}
let ceiling = 4096;
let controller = null;
let exactTotal = null; // last exact count from the apfel tokenizer

// session persistence
try { messages = JSON.parse(localStorage.getItem('apfel-harness-session') || '[]'); } catch { messages = []; }
const persist = () => localStorage.setItem('apfel-harness-session', JSON.stringify(messages));

// ---------- config ----------
async function loadConfig() {
  try {
    config = await (await fetch('/api/config')).json();
  } catch { /* server not up yet; defaults are fine */ }
  $('cfg-system').value = config.systemPrompt || '';
  $('cfg-temperature').value = config.temperature;
  $('cfg-maxtokens').value = config.maxTokens;
  $('cfg-topp').value = config.topP ?? '';
  $('cfg-seed').value = config.seed ?? '';
  $('cfg-strategy').value = config.contextStrategy;
  $('cfg-maxturns').value = config.contextMaxTurns;
  reflectTuning();
  applyTheme(params.get('theme') || config.themeMode);
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/config', { method: 'POST', body: JSON.stringify(config) }).catch(() => {});
  }, 400);
}

function reflectTuning() {
  $('temp-val').textContent = Number(config.temperature).toFixed(1);
  $('maxtok-val').textContent = config.maxTokens;
  $('turns-val').textContent = `${config.contextMaxTurns} turns`;
  $('field-maxturns').hidden = config.contextStrategy !== 'sliding-window';
  $('sys-tokens').textContent = config.systemPrompt ? `~${fmt(estTokens(config.systemPrompt))} tok` : '';
}

// ---------- health lamp ----------
async function pollHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    const state = h.apfel?.state || 'offline';
    $('lamp').dataset.state = state;
    if (h.apfel?.health) {
      ceiling = h.apfel.health.context_window || 4096;
      $('status-text').textContent = `${h.apfel.health.model} · ${fmt(ceiling)} ctx`;
    } else {
      $('status-text').textContent = state === 'starting' ? 'starting…' : 'apfel offline';
    }
  } catch {
    $('lamp').dataset.state = 'offline';
    $('status-text').textContent = 'harness offline';
  }
  updateGauge();
}

// ---------- the gauge ----------
function buildRuler() {
  const ruler = $('gauge-ruler');
  ruler.innerHTML = '';
  for (let t = 0; t <= ceiling; t += 512) {
    const tick = document.createElement('i');
    tick.className = 'tick' + (t % 1024 === 0 ? ' major' : '');
    tick.style.left = `${(t / ceiling) * 100}%`;
    ruler.appendChild(tick);
    if (t % 1024 === 0 && t < ceiling) {
      const label = document.createElement('span');
      label.className = 'tick-label';
      label.style.left = `${(t / ceiling) * 100}%`;
      label.textContent = t === 0 ? '0' : `${t / 1024}k`;
      ruler.appendChild(label);
    }
  }
}

function contextParts() {
  const sys = estTokens(config.systemPrompt);
  const hist = messages.reduce((n, m) => n + (m.tokens || estTokens(m.content)), 0);
  const draft = estTokens($('input').value) + attachments.reduce((n, a) => n + estTokens(a.content), 0);
  return { sys, hist, draft };
}

function updateGauge() {
  const { sys, hist, draft } = contextParts();
  const reserve = Number(config.maxTokens) || 512;
  const pct = (n) => `${Math.min((n / ceiling) * 100, 100)}%`;
  $('seg-system').style.left = '0';
  $('seg-system').style.width = pct(sys);
  $('seg-history').style.left = pct(sys);
  $('seg-history').style.width = pct(hist);
  $('seg-draft').style.left = pct(sys + hist);
  $('seg-draft').style.width = pct(draft);
  $('seg-reserve').style.width = pct(reserve);

  const used = sys + hist + draft;
  const hot = used > ceiling - reserve;
  $('gauge').classList.toggle('hot', hot);
  const exact = exactTotal !== null;
  $('readout').innerHTML = `<span class="approx">${exact ? '' : '~'}</span>${fmt(exact ? exactTotal : used)} / ${fmt(ceiling)}`;
  $('gauge').title = hot
    ? `Over budget — "${config.contextStrategy}" decides what apfel trims`
    : `system ${fmt(sys)} · history ${fmt(hist)} · draft ${fmt(draft)} · reserve ${fmt(reserve)}`;
}

// exact recount via the apfel tokenizer, debounced — estimates stay live in between
let countTimer = null;
function scheduleExactCount() {
  exactTotal = null;
  clearTimeout(countTimer);
  countTimer = setTimeout(async () => {
    const text = [
      config.systemPrompt,
      ...messages.map((m) => m.content),
      $('input').value,
      ...attachments.map((a) => a.content),
    ].filter(Boolean).join('\n');
    if (!text) { exactTotal = 0; updateGauge(); return; }
    try {
      const r = await (await fetch('/api/count', { method: 'POST', body: JSON.stringify({ text }) })).json();
      if (r.exact) { exactTotal = r.tokens; updateGauge(); }
    } catch { /* estimate stays */ }
  }, 600);
}

// ---------- transcript ----------
function renderTranscript() {
  const t = $('transcript');
  t.innerHTML = '';
  if (!messages.length) { t.appendChild(emptyState); return; }
  messages.forEach((m, i) => t.appendChild(renderMessage(m, i)));
  t.scrollTop = t.scrollHeight;
}

function renderMessage(m, index) {
  const el = document.createElement('article');
  el.className = `msg ${m.role}${m.error ? ' error' : ''}`;
  const head = document.createElement('div');
  head.className = 'msg-head';
  const role = document.createElement('span');
  role.className = 'msg-role';
  role.textContent = m.role === 'user' ? 'you' : 'apfel';
  const tok = document.createElement('span');
  tok.className = 'msg-tokens';
  tok.textContent = m.tokens ? `${fmt(m.tokens)} tok` : `~${fmt(estTokens(m.content))} tok`;
  const tools = document.createElement('span');
  tools.className = 'msg-tools';
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title; b.onclick = fn;
    return b;
  };
  tools.appendChild(mkBtn('copy', 'Copy text', () => navigator.clipboard.writeText(m.content)));
  if (m.role === 'assistant' && index === messages.length - 1) {
    tools.appendChild(mkBtn('retry', 'Regenerate this response', regenerate));
  }
  tools.appendChild(mkBtn('✕', 'Remove from context — frees its tokens', () => {
    messages.splice(index, 1);
    persist(); renderTranscript(); updateGauge(); scheduleExactCount();
  }));
  head.append(role, tok, tools);
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = m.content;
  el.append(head, body);
  return el;
}

const emptyState = $('empty-state');

// ---------- streaming ----------
async function streamChat(body, onDelta, signal) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || j.error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const ev of events) {
      const line = ev.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(delta, full); }
      } catch { /* partial frame */ }
    }
  }
  return { text: full, usage };
}

function apiParams() {
  const p = {
    temperature: Number(config.temperature),
    max_tokens: Number(config.maxTokens),
    x_context_strategy: config.contextStrategy,
    x_context_output_reserve: Number(config.maxTokens),
  };
  if (config.topP) p.top_p = Number(config.topP);
  if (config.seed !== null && config.seed !== '') p.seed = Number(config.seed);
  if (config.contextStrategy === 'sliding-window') p.x_context_max_turns = Number(config.contextMaxTurns);
  return p;
}

function buildApiMessages(history) {
  const out = [];
  if (config.systemPrompt.trim()) out.push({ role: 'system', content: config.systemPrompt });
  for (const m of history) out.push({ role: m.role, content: m.content });
  return out;
}

async function send() {
  const draft = $('input').value.trim();
  if ((!draft && !attachments.length) || controller) return;
  let content = draft;
  if (attachments.length) {
    const blocks = attachments.map((a) => `[file: ${a.name}]\n\`\`\`\n${a.content}\n\`\`\``).join('\n\n');
    content = content ? `${blocks}\n\n${content}` : blocks;
  }
  messages.push({ role: 'user', content });
  attachments = [];
  renderAttachments();
  $('input').value = '';
  autosize();
  await complete();
}

async function regenerate() {
  if (controller) return;
  if (messages[messages.length - 1]?.role === 'assistant') messages.pop();
  await complete();
}

async function complete() {
  persist();
  renderTranscript();
  updateGauge();
  const asst = { role: 'assistant', content: '' };
  messages.push(asst);
  renderTranscript();
  const el = $('transcript').lastElementChild;
  el.classList.add('streaming');
  const bodyEl = el.querySelector('.msg-body');
  setBusy(true);
  controller = new AbortController();
  try {
    const { usage } = await streamChat(
      { messages: buildApiMessages(messages.slice(0, -1)), ...apiParams() },
      (_, full) => {
        asst.content = full;
        bodyEl.textContent = full;
        $('transcript').scrollTop = $('transcript').scrollHeight;
      },
      controller.signal
    );
    if (usage?.completion_tokens) asst.tokens = usage.completion_tokens;
    if (!asst.content) { asst.content = '(empty response)'; asst.error = true; }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (!asst.content) messages.pop();
    } else {
      asst.content = `${err.message}\n\nIf apfel is offline, use Restart in the header.`;
      asst.error = true;
    }
  }
  controller = null;
  setBusy(false);
  persist();
  renderTranscript();
  updateGauge();
  scheduleExactCount();
}

function setBusy(busy) {
  $('btn-send').disabled = busy;
  $('btn-stop').hidden = !busy;
}

// ---------- attachments (read client-side; content joins the prompt) ----------
function renderAttachments() {
  const row = $('attach-row');
  row.innerHTML = '';
  row.hidden = !attachments.length;
  attachments.forEach((a, i) => {
    const chip = document.createElement('span');
    const cost = estTokens(a.content);
    chip.className = 'chip' + (cost > ceiling * 0.6 ? ' heavy' : '');
    chip.title = cost > ceiling * 0.6 ? 'This file alone dominates the 4k window' : a.name;
    chip.append(`${a.name} · ~${fmt(cost)} tok`);
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Remove attachment';
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); updateGauge(); scheduleExactCount(); };
    chip.appendChild(x);
    row.appendChild(chip);
  });
}

$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = async (e) => {
  for (const f of e.target.files) {
    attachments.push({ name: f.name, content: await f.text() });
  }
  e.target.value = '';
  renderAttachments();
  updateGauge();
  scheduleExactCount();
};

// ---------- JSON mode ----------
const DEFAULT_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, role: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  required: ['people'],
};
$('json-schema').value = JSON.stringify(DEFAULT_SCHEMA, null, 2);

$('json-run').onclick = async () => {
  const out = $('json-result');
  let schema;
  try {
    schema = JSON.parse($('json-schema').value);
  } catch (err) {
    out.className = 'result mono error';
    out.textContent = `Schema is not valid JSON: ${err.message}`;
    return;
  }
  $('json-valid').hidden = true;
  $('json-copy').hidden = true;
  out.className = 'result mono';
  out.textContent = 'Generating…';
  $('json-run').disabled = true;
  try {
    const { text } = await streamChat({
      messages: [{ role: 'user', content: $('json-prompt').value }],
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema } },
      ...apiParams(),
    }, (_, full) => { out.textContent = full; });
    try {
      out.textContent = JSON.stringify(JSON.parse(text), null, 2);
      out.className = 'result mono done';
      $('json-valid').hidden = false;
      $('json-copy').hidden = false;
      $('json-copy').onclick = () => navigator.clipboard.writeText(out.textContent);
    } catch {
      out.textContent = text;
      out.className = 'result mono error';
      $('json-hint').textContent = 'Response was not valid JSON — try a simpler schema.';
    }
  } catch (err) {
    out.className = 'result mono error';
    out.textContent = err.message;
  }
  $('json-run').disabled = false;
};

// ---------- tools (mirrors apfel's bundled demos) ----------
const TOOLS = [
  { id: 'explain', title: 'Explain a command', desc: 'Paste a shell command; get a plain-English breakdown.', placeholder: 'tar -xzvf backup.tar.gz -C /tmp', system: 'Explain the given shell command flag by flag, briefly, in plain English. Warn about anything destructive.' },
  { id: 'oneliner', title: 'Shell one-liner', desc: 'Describe what you want; get a pipe chain to do it.', placeholder: 'sum the third column of a CSV', system: 'Reply with a single macOS-compatible shell one-liner that does what is asked, then one short line explaining it. No markdown fences.' },
  { id: 'naming', title: 'Name things', desc: 'Describe a function or variable; get good names.', placeholder: 'function that retries HTTP requests with backoff', system: 'Suggest 5 concise, idiomatic code names for what is described, one per line, best first. No commentary.' },
  { id: 'summarize', title: 'Summarize', desc: 'Paste anything; get the three sentences that matter.', placeholder: 'Paste text…', system: 'Summarize the text in at most 3 short sentences. Keep concrete facts, drop filler.' },
  { id: 'proofread', title: 'Tighten prose', desc: 'Paste a draft; get it back shorter and cleaner.', placeholder: 'Paste a draft…', system: 'Rewrite the text to be clearer and about 30% shorter. Keep the author\'s voice. Return only the rewrite.' },
];

function buildTools() {
  const grid = $('tools');
  for (const t of TOOLS) {
    const card = document.createElement('div');
    card.className = 'tool';
    card.innerHTML = `<h3></h3><p class="desc"></p><textarea spellcheck="false"></textarea>
      <div class="tool-actions"><button class="ghost btn-copy" hidden>Copy</button><button class="primary btn-run">Run</button></div>
      <div class="out mono"></div>`;
    card.querySelector('h3').textContent = t.title;
    card.querySelector('.desc').textContent = t.desc;
    const input = card.querySelector('textarea');
    input.placeholder = t.placeholder;
    const out = card.querySelector('.out');
    const run = card.querySelector('.btn-run');
    const copy = card.querySelector('.btn-copy');
    run.onclick = async () => {
      if (!input.value.trim()) return;
      run.disabled = true;
      copy.hidden = true;
      out.className = 'out mono show';
      out.textContent = '…';
      try {
        const { text } = await streamChat({
          messages: [{ role: 'system', content: t.system }, { role: 'user', content: input.value }],
          temperature: 0.3,
          max_tokens: Number(config.maxTokens),
        }, (_, full) => { out.textContent = full; });
        out.textContent = text || '(empty response)';
        out.classList.add('done');
        copy.hidden = false;
        copy.onclick = () => navigator.clipboard.writeText(text);
      } catch (err) {
        out.textContent = err.message;
      }
      run.disabled = false;
    };
    grid.appendChild(card);
  }
}

// ---------- wiring ----------
document.querySelectorAll('.mode').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.mode').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-selected', b === btn);
    });
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    $(`view-${btn.dataset.mode}`).classList.add('is-active');
    $('deck').style.display = btn.dataset.mode === 'chat' ? '' : 'none';
  };
});

$('btn-tune').onclick = () => {
  const open = $('tuning').hidden;
  $('tuning').hidden = !open;
  $('btn-tune').setAttribute('aria-expanded', open);
};

$('btn-restart').onclick = async () => {
  $('lamp').dataset.state = 'starting';
  $('status-text').textContent = 'restarting…';
  await fetch('/api/restart', { method: 'POST' }).catch(() => {});
};

$('btn-clear').onclick = () => {
  messages = [];
  persist();
  renderTranscript();
  updateGauge();
  scheduleExactCount();
};

$('btn-send').onclick = send;
$('btn-stop').onclick = () => controller?.abort();

const input = $('input');
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}
input.addEventListener('input', () => { autosize(); updateGauge(); scheduleExactCount(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && controller) controller.abort();
});

document.querySelectorAll('.starter').forEach((b) => {
  b.onclick = () => { input.value = b.textContent; input.focus(); autosize(); updateGauge(); };
});

// tuning bindings
$('cfg-system').oninput = (e) => { config.systemPrompt = e.target.value; reflectTuning(); updateGauge(); scheduleExactCount(); saveConfig(); };
$('cfg-temperature').oninput = (e) => { config.temperature = Number(e.target.value); reflectTuning(); saveConfig(); };
$('cfg-maxtokens').oninput = (e) => { config.maxTokens = Number(e.target.value); reflectTuning(); updateGauge(); saveConfig(); };
$('cfg-topp').onchange = (e) => { config.topP = e.target.value === '' ? null : Number(e.target.value); saveConfig(); };
$('cfg-seed').onchange = (e) => { config.seed = e.target.value === '' ? null : Number(e.target.value); saveConfig(); };
$('cfg-strategy').onchange = (e) => { config.contextStrategy = e.target.value; reflectTuning(); saveConfig(); };
$('cfg-maxturns').oninput = (e) => { config.contextMaxTurns = Number(e.target.value); reflectTuning(); saveConfig(); };

// ---------- go ----------
(async function boot() {
  applyTheme(params.get('theme') || 'system');
  await loadConfig();
  buildRuler();
  buildTools();
  renderTranscript();
  updateGauge();
  scheduleExactCount();
  pollHealth();
  setInterval(pollHealth, 5000);
})();
