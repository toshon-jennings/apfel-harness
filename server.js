#!/usr/bin/env node
// Apfel Harness — GUI harness for Apple Intelligence via the apfel CLI.
// Zero-dependency Node server: static UI + proxy to a supervised
// `apfel --serve` child (OpenAI-compatible, on-device FoundationModels).
//
// Ports (registered in ~/.config/agent-rules/PORTMASTER.md):
//   6271  this harness (UI + /api/*)
//   6272  apfel --serve child (apfel's default 11434 belongs to Ollama)

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = 6271;
const HOST = '127.0.0.1';
const UPSTREAM_PORT = 6272;
const UPSTREAM_HOST = '127.0.0.1';
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
let child = null;
let childState = 'starting'; // starting | online | offline
let restartDelay = 500;
let shuttingDown = false;
let lastStart = 0;
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

function startUpstream() {
  if (shuttingDown) return;
  childState = 'starting';
  discoveredTools = []; // re-announced on every start
  lastStart = Date.now();
  const extra = mcpArgs();
  child = spawn('apfel', ['--serve', '--port', String(UPSTREAM_PORT), '--host', UPSTREAM_HOST, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (buf) =>
    String(buf)
      .split('\n')
      .filter(Boolean)
      .forEach((l) => { log(`[apfel] ${l}`); parseApfelLine(l); });
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => {
    childState = 'offline';
    log(`[harness] failed to spawn apfel: ${err.message}`);
  });
  child.on('exit', (code) => {
    child = null;
    if (shuttingDown) return;
    childState = 'offline';
    // A near-instant exit while MCP flags were set means a bad server path —
    // fall back to running WITHOUT tools so the harness stays usable.
    if (Date.now() - lastStart < 2500 && extra.length && !mcpFallback) {
      mcpFallback = true;
      mcpError = 'apfel could not start with the configured MCP server(s); running without tools. Check each path exists and is executable.';
      log('[harness] ' + mcpError);
      return setTimeout(startUpstream, 300);
    }
    log(`[harness] apfel exited (code ${code}); restarting in ${restartDelay}ms`);
    setTimeout(startUpstream, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 15000);
  });
  // poll /health until the model is ready
  const poll = setInterval(() => {
    upstreamGet('/health')
      .then(() => {
        childState = 'online';
        restartDelay = 500;
        clearInterval(poll);
        log(`[harness] apfel is online${extra.length ? ` with ${discoveredTools.length} tool(s)` : ''}`);
      })
      .catch(() => {});
  }, 400);
  setTimeout(() => clearInterval(poll), 20000);
}

// Restart the child cleanly (used when MCP config changes — --mcp is a startup flag).
function restartUpstream() {
  restartDelay = 500;
  if (child) child.kill('SIGTERM'); // exit handler relaunches
  else startUpstream();
}

function upstreamGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: pathname, timeout: 3000 }, (res) => {
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
async function handleHealth(res) {
  let upstream = null;
  try {
    upstream = await upstreamGet('/health');
    childState = 'online';
  } catch {
    if (childState === 'online') childState = 'offline';
  }
  sendJSON(res, 200, {
    ok: true,
    service: 'apfel-harness',
    version: VERSION,
    url: `http://${HOST}:${PORT}`,
    apfel: { state: childState, port: UPSTREAM_PORT, health: upstream },
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
// tokens as the on-device model produces them.
async function handleChat(req, res) {
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
      port: UPSTREAM_PORT,
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

// Exact token count via the CLI tokenizer (no inference).
async function handleCount(req, res) {
  let text;
  try {
    text = JSON.parse(await readBody(req)).text || '';
  } catch (err) {
    return sendJSON(res, 400, { error: `bad request body: ${err.message}` });
  }
  if (!text.trim()) return sendJSON(res, 200, { tokens: 0, exact: true });
  const cp = execFile('apfel', ['--count-tokens', '-o', 'json', '--', text], { timeout: 8000 }, (err, stdout) => {
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

async function handleConfig(req, res) {
  if (req.method === 'GET') return sendJSON(res, 200, loadConfig());
  try {
    const before = loadConfig();
    const cfg = { ...before, ...JSON.parse(await readBody(req)) };
    saveConfig(cfg);
    // --mcp is a startup flag, so any change to the MCP set needs a child restart.
    const mcpChanged =
      JSON.stringify(before.mcpServers) !== JSON.stringify(cfg.mcpServers) ||
      before.mcpTimeout !== cfg.mcpTimeout;
    if (mcpChanged) {
      mcpFallback = false;
      mcpError = null;
      restartUpstream();
    }
    sendJSON(res, 200, { ...cfg, restarting: mcpChanged });
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
    state: childState,
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
  restartUpstream();
  sendJSON(res, 200, { ok: true, state: 'starting' });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (pathname === '/api/health') return await handleHealth(res);
    if (pathname === '/api/model') return await handleModel(res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
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
  if (child) child.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`[harness] apfel-harness v${VERSION} on http://${HOST}:${PORT}`);
  startUpstream();
});
