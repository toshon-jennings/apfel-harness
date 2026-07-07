#!/usr/bin/env node
// Apfel Harness — GUI harness for Apple Intelligence via the apfel CLI.
// Zero-dependency Node server: static UI + proxy to a supervised
// `apfel --serve` child (OpenAI-compatible, on-device FoundationModels).
//
// Ports (registered in ~/.config/agent-rules/PORTMASTER.md):
//   6271  this harness (UI + /api/*)
//   6272  apfel --serve child (apfel's default 11434 belongs to Ollama)

const http = require('http');
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
  themeMode: 'system', // system | dark | light
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
const logRing = [];
function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  logRing.push(entry);
  if (logRing.length > 200) logRing.shift();
  process.stderr.write(entry + '\n');
}

function startUpstream() {
  if (shuttingDown) return;
  childState = 'starting';
  child = spawn('apfel', ['--serve', '--port', String(UPSTREAM_PORT), '--host', UPSTREAM_HOST], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (buf) =>
    String(buf)
      .split('\n')
      .filter(Boolean)
      .forEach((l) => log(`[apfel] ${l}`));
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
        log('[harness] apfel is online');
      })
      .catch(() => {});
  }, 400);
  setTimeout(() => clearInterval(poll), 20000);
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
    const patch = JSON.parse(await readBody(req));
    const cfg = { ...loadConfig(), ...patch };
    saveConfig(cfg);
    sendJSON(res, 200, cfg);
  } catch (err) {
    sendJSON(res, 400, { error: `bad config: ${err.message}` });
  }
}

function handleRestart(res) {
  log('[harness] restart requested from UI');
  restartDelay = 500;
  if (child) child.kill('SIGTERM');
  else startUpstream();
  sendJSON(res, 200, { ok: true, state: 'starting' });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (pathname === '/api/health') return await handleHealth(res);
    if (pathname === '/api/model') return await handleModel(res);
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/count' && req.method === 'POST') return await handleCount(req, res);
    if (pathname === '/api/config') return await handleConfig(req, res);
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
