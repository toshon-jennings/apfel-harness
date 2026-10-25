#!/usr/bin/env node
// Apfel Harness — GUI harness for Apple Intelligence via the apfel CLI.
// Zero-dependency Node server: static UI + proxy to a supervised
// `apfel --serve` child (OpenAI-compatible, on-device FoundationModels).
//
// Ports (registered in ~/.config/agent-rules/PORTMASTER.md):
//   6271  this harness (UI + /api/*)
//   6272  apfel --serve child (apfel's default 11434 belongs to Ollama)
//   6273  tool-free apfel --serve child for Perci Notes (/api/notes/chat)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Resolve apfel without trusting PATH. launchd (and other bare environments)
// hand processes a minimal PATH, so the bare name only works if whoever
// started us exported one — probe the usual install locations instead, and
// fall back to the bare name for anything this list doesn't know about.
const APFEL_CANDIDATES = [
  '/opt/homebrew/bin/apfel',
  '/usr/local/bin/apfel',
  path.join(process.env.HOME || '', '.local/bin/apfel'),
];
const APFEL_BIN = APFEL_CANDIDATES.find((p) => {
  try { return p && fs.accessSync(p, fs.constants.X_OK) === undefined; } catch { return false; }
}) || 'apfel';

// PATH to hand the apfel child: MCP servers are node scripts spawned via
// `#!/usr/bin/env node`, so `node`'s directory must be on their PATH even if
// ours was minimal. The running node's own dir leads; system dirs trail.
const CHILD_PATH = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
const CHILD_ENV = { ...process.env, PATH: CHILD_PATH };

const PORT = 6271;
const HOST = '127.0.0.1';
const UPSTREAM_PORT = 6272;
const UPSTREAM_HOST = '127.0.0.1';
const NOTES_PORT = 6273;
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const VERSION = require('./package.json').version;

const DEFAULT_CONFIG = {
  systemPrompt: '',
  temperature: 0.7,
  topP: null, // null = let apfel decide
  seed: null,
  maxTokens: 512,
  contextStrategy: 'newest-first', // newest-first | oldest-first | sliding-window | summarize | strict
  contextMaxTurns: 8, // sliding-window only
  themeMode: 'dark', // system | dark | light
  mcpServers: [], // [{ path, enabled }] — apfel executes these tools server-side
  mcpTimeout: 5, // seconds
  escalation: { baseUrl: '', apiKey: '', model: '' }, // OpenAI-compatible upstream for the "escalate" hook
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---------- apfel --serve supervisor ----------
// One supervisor, two children: the shared worker (6272) runs the MCP tools
// from config.json; the Notes worker (6273) is never given any MCP flags.
let shuttingDown = false;
let mcpFallback = false; // true once a bad MCP config forced a no-tools restart
let mcpError = null;
let discoveredTools = []; // [{ server, name }] parsed from apfel's startup log
const recentToolCalls = []; // [{ name, args, result, at }] parsed live from apfel's log
const logRing = [];
function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  logRing.push(entry);
  if (logRing.length > 200) logRing.shift();
  process.stderr.write(entry + '\n');
}

// Build the --mcp flags for the enabled, existing server paths. A missing path
// is skipped (not fatal); a present-but-broken one is caught by fast-crash below.
function mcpArgs() {
  if (mcpFallback) return [];
  const cfg = loadConfig();
  const args = [];
  for (const s of cfg.mcpServers || []) {
    if (!s || !s.enabled || !s.path) continue;
    if (!fs.existsSync(s.path)) { log(`[harness] MCP path not found, skipping: ${s.path}`); continue; }
    args.push('--mcp', s.path);
  }
  if (args.length) args.push('--mcp-timeout', String(cfg.mcpTimeout || 5));
  return args;
}

// apfel prints one "mcp: <path> - <tool>" per tool at startup, and
// "mcp tool: <name>(<args>) = <result>" when the model invokes one. Parse both.
function parseApfelLine(l) {
  const disc = l.match(/^mcp: (.+?) - (\S+)$/);
  if (disc) {
    if (!discoveredTools.find((t) => t.name === disc[2])) discoveredTools.push({ server: disc[1], name: disc[2] });
    return;
  }
  const call = l.match(/mcp tool: (\S+?)\((.*)\) = (.*)$/);
  if (call) {
    recentToolCalls.push({ name: call[1], args: call[2], result: call[3], at: Date.now() });
    if (recentToolCalls.length > 30) recentToolCalls.shift();
  }
}

// Spawn `apfel --serve` on `port` with `flags()` and keep it alive: health-gated
// "online", restart with backoff on exit. `onFastExit(extra)` may return true
// to retry at once after a near-instant exit.
function supervise(name, port, { flags, onLine, env = CHILD_ENV, onStart = () => {}, onFastExit = () => false }) {
  const w = { port, env, state: 'starting', argv: [], child: null, restartDelay: 500 }; // state: starting | online | offline
  w.start = () => {
    if (shuttingDown) return;
    w.state = 'starting';
    onStart();
    const lastStart = Date.now();
    const extra = flags();
    w.argv = ['--serve', '--port', String(port), '--host', UPSTREAM_HOST, ...extra];
    const child = (w.child = spawn(APFEL_BIN, w.argv, { stdio: ['ignore', 'pipe', 'pipe'], env }));
    const onData = (buf) => String(buf).split('\n').filter(Boolean).forEach(onLine);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      w.state = 'offline';
      log(`[harness] failed to spawn ${name}: ${err.message}`);
    });
    child.on('exit', (code) => {
      w.child = null;
      if (shuttingDown) return;
      w.state = 'offline';
      if (Date.now() - lastStart < 2500 && onFastExit(extra)) return setTimeout(w.start, 300);
      log(`[harness] ${name} exited (code ${code}); restarting in ${w.restartDelay}ms`);
      setTimeout(w.start, w.restartDelay);
      w.restartDelay = Math.min(w.restartDelay * 2, 15000);
    });
    // poll /health until the model is ready
    const poll = setInterval(() => {
      upstreamGet('/health', port)
        .then(() => {
          w.state = 'online';
          w.restartDelay = 500;
          clearInterval(poll);
          log(`[harness] ${name} is online${extra.length ? ` with ${discoveredTools.length} tool(s)` : ''}`);
        })
        .catch(() => {});
    }, 400);
    setTimeout(() => clearInterval(poll), 20000);
  };
  // Restart cleanly (used when MCP config changes — --mcp is a startup flag).
  w.restart = () => {
    w.restartDelay = 500;
    if (w.child) w.child.kill('SIGTERM'); // exit handler relaunches
    else w.start();
  };
  return w;
}

const shared = supervise('apfel', UPSTREAM_PORT, {
  flags: mcpArgs,
  onStart: () => { discoveredTools = []; }, // re-announced on every start
  onLine: (l) => { log(`[apfel] ${l}`); parseApfelLine(l); },
  // A near-instant exit while MCP flags were set means a bad server path —
  // fall back to running WITHOUT tools so the harness stays usable.
  onFastExit: (extra) => {
    if (!extra.length || mcpFallback) return false;
    mcpFallback = true;
    mcpError = 'apfel could not start with the configured MCP server(s); running without tools. Check each path exists and is executable.';
    log('[harness] ' + mcpError);
    return true;
  },
});

// Perci Notes' worker. Whatever config.json says it gets no MCP flags, and no
// APFEL_* environment (APFEL_MCP also attaches tools), so apfel has no tools to
// run on note text. Its output is never logged (it could carry note text) and
// never reaches recentToolCalls. If it prints an MCP line anyway (apfel 1.12:
// "mcp: <path> - <tools>" at startup, "  • mcp tool: <name> ok …" per call),
// /api/notes/chat refuses requests until the harness restarts.
let notesUnsafe = false;
const notes = supervise('apfel notes worker', NOTES_PORT, {
  flags: () => [],
  env: Object.fromEntries(Object.entries(CHILD_ENV).filter(([k]) => !k.startsWith('APFEL_'))),
  onLine: (l) => {
    if (notesUnsafe || !/^[\s•]*mcp( tool)?:/.test(l)) return;
    notesUnsafe = true;
    log('[harness] notes worker announced an MCP tool; /api/notes/chat now refuses requests');
  },
});
// The Notes port must be held by our own child alone. If a stray process
// already had it, our child could not bind and that process would answer instead.
function notesOwnsPort() {
  return new Promise((resolve) => {
    const pid = notes.child && String(notes.child.pid);
    if (!pid) return resolve(false);
    execFile('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${NOTES_PORT}`, '-sTCP:LISTEN'], (err, out) => {
      const pids = String(out || '').split('\n').filter(Boolean);
      resolve(pids.length > 0 && pids.every((p) => p === pid));
    });
  });
}
const notesToolFree = async () =>
  !notesUnsafe &&
  !notes.argv.some((a) => a.startsWith('--mcp')) &&
  !Object.keys(notes.env).some((k) => k.startsWith('APFEL_MCP')) &&
  (await notesOwnsPort());

function upstreamGet(pathname, port = UPSTREAM_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: UPSTREAM_HOST, port, path: pathname, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('bad JSON from apfel'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// ---------- helpers ----------
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const abs = path.join(ROOT, 'public', rel);
  if (!abs.startsWith(path.join(ROOT, 'public'))) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(abs, (err, buf) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- API handlers ----------
// Ask a worker's own /health so its reported state is current.
async function probe(w) {
  try {
    const health = await upstreamGet('/health', w.port);
    w.state = 'online';
    return health;
  } catch {
    if (w.state === 'online') w.state = 'offline';
    return null;
  }
}

async function handleHealth(res) {
  const [upstream] = await Promise.all([probe(shared), probe(notes)]);
  sendJSON(res, 200, {
    ok: true,
    service: 'apfel-harness',
    version: VERSION,
    url: `http://${HOST}:${PORT}`,
    apfel: { state: shared.state, port: UPSTREAM_PORT, health: upstream },
    notesWorker: { state: notes.state, toolFree: await notesToolFree(), port: NOTES_PORT },
    mcp: { tools: discoveredTools.length, fallback: mcpFallback, error: mcpError },
    escalation: !!(loadConfig().escalation || {}).model,
  });
}

async function handleModel(res) {
  try {
    const [models, health] = await Promise.all([upstreamGet('/v1/models'), upstreamGet('/health')]);
    sendJSON(res, 200, { model: models.data && models.data[0], health });
  } catch (err) {
    sendJSON(res, 502, { error: `apfel is not reachable: ${err.message}` });
  }
}

// Proxy chat completions; streams SSE straight through so the UI can render
// tokens as the on-device model produces them. Nothing here logs content.
async function handleChat(req, res, port = UPSTREAM_PORT) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJSON(res, 400, { error: `bad request body: ${err.message}` });
  }
  const body = JSON.stringify({ model: 'apple-foundationmodel', stream: true, ...payload });
  const upstreamReq = http.request(
    {
      host: UPSTREAM_HOST,
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, {
        'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      upstreamRes.pipe(res);
    }
  );
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) sendJSON(res, 502, { error: `apfel is not reachable: ${err.message}` });
    else res.end();
  });
  req.on('close', () => upstreamReq.destroy()); // stop generation when the client aborts
  upstreamReq.end(body);
}

// Perci Notes sends note text here, and it only ever reaches the tool-free
// Notes worker. Notes calls from its Electron main process, which sends no
// Origin, so any Origin (even this harness's own page) is refused.
async function handleNotesChat(req, res) {
  if (req.headers.origin !== undefined) return sendJSON(res, 403, { error: 'forbidden origin' });
  if (!(await notesToolFree())) return sendJSON(res, 503, { error: 'the Notes worker is not tool-free; refusing note text' });
  return handleChat(req, res, NOTES_PORT);
}

// Exact token count via the CLI tokenizer (no inference).
async function handleCount(req, res) {
  let text;
  try {
    text = JSON.parse(await readBody(req)).text || '';
  } catch (err) {
    return sendJSON(res, 400, { error: `bad request body: ${err.message}` });
  }
  if (!text.trim()) return sendJSON(res, 200, { tokens: 0, exact: true });
  const cp = execFile(APFEL_BIN, ['--count-tokens', '-o', 'json', '--', text], { timeout: 8000 }, (err, stdout) => {
    try {
      const j = JSON.parse(stdout);
      const tokens = typeof j.total === 'number' ? j.total : j.prompt_tokens;
      return sendJSON(res, 200, { tokens, exact: true, context: j.context_size, budget: j.budget });
    } catch {
      // fall back to the same rough estimate the UI uses
      return sendJSON(res, 200, { tokens: Math.ceil(text.length / 4), exact: false });
    }
  });
  cp.stdin.end(); // apfel blocks reading stdin without a TTY — close it so it returns immediately
}

// The escalation key never leaves the server: clients only learn whether one is set.
function publicConfig(cfg) {
  const { apiKey, ...esc } = cfg.escalation || {};
  return { ...cfg, escalation: { ...esc, apiKeySet: !!apiKey } };
}

// An empty or missing apiKey keeps the stored one (the UI never has it to send
// back); `clearApiKey: true` is the only way to remove it.
function mergeEscalation(prev, next) {
  prev = prev || {};
  if (!next || typeof next !== 'object') return prev;
  const { apiKey, apiKeySet, clearApiKey, ...rest } = next;
  const merged = { ...prev, ...rest };
  if (clearApiKey === true) merged.apiKey = '';
  else if (typeof apiKey === 'string' && apiKey.trim()) merged.apiKey = apiKey.trim();
  else merged.apiKey = prev.apiKey || '';
  return merged;
}

async function handleConfig(req, res) {
  if (req.method === 'GET') return sendJSON(res, 200, publicConfig(loadConfig()));
  try {
    const before = loadConfig();
    const incoming = JSON.parse(await readBody(req));
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('expected a JSON object');
    const cfg = { ...before, ...incoming, escalation: mergeEscalation(before.escalation, incoming.escalation) };
    delete cfg.restarting; // response-only flag; don't persist it if a client echoes it back
    saveConfig(cfg);
    // --mcp is a startup flag, so any change to the MCP set needs a child restart.
    const mcpChanged =
      JSON.stringify(before.mcpServers) !== JSON.stringify(cfg.mcpServers) ||
      before.mcpTimeout !== cfg.mcpTimeout;
    if (mcpChanged) {
      mcpFallback = false;
      mcpError = null;
      shared.restart(); // only the shared worker has MCP flags
    }
    sendJSON(res, 200, { ...publicConfig(cfg), restarting: mcpChanged });
  } catch (err) {
    sendJSON(res, 400, { error: `bad config: ${err.message}` });
  }
}

function handleTools(res) {
  const cfg = loadConfig();
  sendJSON(res, 200, {
    servers: cfg.mcpServers || [],
    discovered: discoveredTools,
    recentCalls: recentToolCalls.slice(-15).reverse(),
    fallback: mcpFallback,
    error: mcpError,
    state: shared.state,
  });
}

// Forward the current conversation to a bigger OpenAI-compatible model. The
// upstream base URL + key stay server-side; the SSE stream is piped straight back.
async function handleEscalate(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJSON(res, 400, { error: `bad request body: ${err.message}` });
  }
  const esc = loadConfig().escalation || {};
  if (!esc.baseUrl || !esc.model) {
    return sendJSON(res, 400, { error: 'Escalation is not configured — set a base URL and model in Tune → Escalate.' });
  }
  let url;
  try {
    url = new URL(esc.baseUrl.replace(/\/+$/, '') + '/chat/completions');
  } catch {
    return sendJSON(res, 400, { error: `Escalation base URL is not valid: ${esc.baseUrl}` });
  }
  const body = JSON.stringify({
    model: esc.model,
    stream: true,
    messages: payload.messages,
    temperature: payload.temperature ?? 0.7,
    max_tokens: payload.max_tokens ?? 1024,
  });
  const mod = url.protocol === 'https:' ? https : http;
  const upstreamReq = mod.request(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(esc.apiKey ? { Authorization: `Bearer ${esc.apiKey}` } : {}),
      },
    },
    (up) => {
      res.writeHead(up.statusCode, {
        'Content-Type': up.headers['content-type'] || 'text/event-stream',
        'Cache-Control': 'no-store',
      });
      up.pipe(res);
    }
  );
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) sendJSON(res, 502, { error: `Escalation upstream error: ${err.message}` });
    else res.end();
  });
  req.on('close', () => upstreamReq.destroy());
  upstreamReq.end(body);
}

function handleRestart(res) {
  log('[harness] restart requested from UI');
  mcpFallback = false;
  mcpError = null;
  shared.restart();
  sendJSON(res, 200, { ok: true, state: 'starting' });
}

// ---------- request guard ----------
// The harness binds to loopback, but any page open in the user's browser can
// still reach it. So: only answer to our own Host (defeats DNS rebinding), only
// accept state-changing or sensitive requests from our own origin, and only
// hand out CORS on the read-only status routes Perci polls.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const SELF_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const CORS_ROUTES = new Set(['/api/health', '/api/model']); // no secrets; Perci's renderer (Origin "null" / :5173) reads health

// Returns true if the request was rejected (response already sent).
function guard(req, res, pathname) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    sendJSON(res, 403, { error: 'forbidden host' });
    return true;
  }
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  if (req.method === 'OPTIONS') {
    if (!CORS_ROUTES.has(pathname)) {
      sendJSON(res, 403, { error: 'forbidden' });
      return true;
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return true;
  }
  // Writes, and every /api/* read except the public status routes (config,
  // logs, tools, …), must come from our own page. No Origin = a non-browser
  // client (Node, curl, URLSession) and is allowed; "null" counts as foreign.
  const sensitive = !readOnly || (pathname.startsWith('/api/') && !CORS_ROUTES.has(pathname));
  const origin = req.headers.origin;
  if (sensitive && origin !== undefined && !SELF_ORIGINS.has(String(origin).toLowerCase())) {
    sendJSON(res, 403, { error: 'forbidden origin' });
    return true;
  }
  if (readOnly && CORS_ROUTES.has(pathname)) res.setHeader('Access-Control-Allow-Origin', '*');
  return false;
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}:${PORT}`).pathname;
  } catch {
    return sendJSON(res, 400, { error: 'bad request' });
  }
  if (guard(req, res, pathname)) return;
  try {
    if (pathname === '/api/health') return await handleHealth(res);
    if (pathname === '/api/model') return await handleModel(res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/notes/chat' && req.method === 'POST') return await handleNotesChat(req, res);
    if (pathname === '/api/escalate' && req.method === 'POST') return await handleEscalate(req, res);
    if (pathname === '/api/count' && req.method === 'POST') return await handleCount(req, res);
    if (pathname === '/api/config') return await handleConfig(req, res);
    if (pathname === '/api/tools') return handleTools(res);
    if (pathname === '/api/restart' && req.method === 'POST') return handleRestart(res);
    if (pathname === '/api/logs') return sendJSON(res, 200, { lines: logRing.slice(-100) });
    if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'unknown endpoint' });
    return serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
});

function shutdown() {
  shuttingDown = true;
  for (const w of [shared, notes]) if (w.child) w.child.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`[harness] apfel-harness v${VERSION} on http://${HOST}:${PORT}`);
  shared.start();
  notes.start();
});
