#!/usr/bin/env node
// web-search MCP server for the Apfel Harness — grounds the on-device model on
// live results from a *local* SearXNG instance, so queries never leave the Mac.
//
// Point the harness at it (Tune → MCP tools → Add):
//   /absolute/path/to/apfel-harness/examples/mcp-websearch.js
//   chmod +x examples/mcp-websearch.js
//
// Requires SearXNG running with JSON output enabled (see examples/searxng/).
//   SEARXNG_URL   base URL of the instance   [default http://127.0.0.1:8999]
//   SEARX_RESULTS max results to return       [default 4]
//
// The 4k context is tiny, so results are deliberately terse: N hits, each a
// one-line snippet. apfel runs the tool loop itself and feeds these back to the
// model, which then answers grounded in — and able to cite — them.

const http = require('http');
const https = require('https');

const BASE = (process.env.SEARXNG_URL || 'http://127.0.0.1:8999').replace(/\/+$/, '');
const MAX = Math.max(1, Math.min(8, parseInt(process.env.SEARX_RESULTS || '4', 10)));

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function searxSearch(query) {
  const url = new URL(BASE + '/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'apfel-harness-websearch/1.0' }, timeout: 12000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`SearXNG HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('SearXNG did not return JSON (is `json` in search.formats?)')); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('SearXNG timed out')));
  });
}

// Format results tight enough to survive a 4k window: title, host, one-line snippet.
function formatResults(data, query) {
  const results = (data.results || []).slice(0, MAX);
  if (!results.length) return `No web results for "${query}".`;
  const lines = results.map((r, i) => {
    let host = r.url;
    try { host = new URL(r.url).host.replace(/^www\./, ''); } catch {}
    return `${i + 1}. ${clip(r.title, 100)} — ${host}\n   ${clip(r.content, 180)}\n   ${r.url}`;
  });
  const answer = (data.answers || [])[0];
  const head = answer ? `Answer: ${clip(typeof answer === 'string' ? answer : answer.answer, 200)}\n\n` : '';
  return `${head}Top ${results.length} results for "${query}":\n\n${lines.join('\n\n')}`;
}

const TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the live web for current or factual information the model may not know. Returns a short list of titles, sources, and snippets. Use for recent events, facts, docs, or anything time-sensitive; cite the sources in your answer.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query — keep it focused.' } },
      required: ['query'],
    },
  },
];

const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'apfel-websearch', version: '1.0.0' },
    }});
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const query = params && params.arguments && params.arguments.query;
    if (params.name !== 'web_search' || !query) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'web_search requires a query' } });
    }
    try {
      const data = await searxSearch(query);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: formatResults(data, query) }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Search failed: ${err.message}` }], isError: true } });
    }
  } else if (method && method.startsWith('notifications/')) {
    // no reply
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
