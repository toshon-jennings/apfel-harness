# Apfel Harness

> [!IMPORTANT]
> Apfel Harness is embedded as a first-class window in Perci (`APFEL_WINDOW_ID`). Updates should be made to both this standalone repository (`~/apfel-harness`) and the Perci codebase (`~/opal`).

A local web GUI that wraps the [`apfel`](https://github.com/Arthur-Ficial/apfel)
CLI — Apple Intelligence (on-device FoundationModels) from a browser. Built to
squeeze every ounce out of a tiny 4,096-token fully-offline model. Use standalone or in [Perci](../opal) as a first-class window.

```
node server.js      # or: npm start
open http://127.0.0.1:6271
```

`server.js` spawns and supervises its own `apfel --serve` children (auto-restart
with backoff, health-gated) and proxies them: the shared worker on 6272, which
runs your MCP tools, and a tool-free Notes worker on 6273 for Perci Notes. No
cloud, no keys.

## Menu bar

`menubar/` holds a zero-dependency Swift menu-bar app (**● Apfel** in the
top-right, green = online). Click it for **Open Apfel Harness** (starts the
server via the `local.perci.apfel-harness` LaunchAgent first if it's down),
**Restart Backend**, and **Copy URL**. Rebuild with `menubar/build.sh`; the
installed copy lives in `~/Applications/ApfelHarnessMenu.app` and auto-starts
at login via `com.toshon.apfel-harness-menu`.

## What's in it

- **Chat** — streaming conversation with a live **context gauge**: a tape that
  shows exactly how the 4k window is spent — system prompt, history, your draft,
  and the reserve held back for the response — so you can see the ceiling coming.
  Token counts are exact (via `apfel --count-tokens`), not estimated. Per-message
  token readouts; drop any message to reclaim its tokens.
- **JSON** — constrained decoding against a JSON Schema. Output is *guaranteed*
  to match the schema; the result pane validates and pretty-prints it.
- **Batch** — run many inputs (pasted lines or attached files) through one recipe
  and get a results table, with concurrency, a progress bar, and CSV export.
  Because it's local and free, volume costs nothing.
- **Tools** — one-shot utilities from apfel's bundled demos (explain a command,
  shell one-liner, naming, summarize, tighten prose), each stateless.
- **Tune** — system prompt, temperature, top-p, seed, max response tokens, and
  the context-overflow strategy (`newest-first`, `sliding-window`, `summarize`,
  `strict`, …). Also two capability multipliers:
  - **MCP tools** — give the on-device model real abilities. Point at an
    executable MCP server and apfel runs it and executes tool calls itself; the
    model just decides when. The header shows a 🔧 count, chat messages note
    which tools fired, and a bad path falls back to running without tools rather
    than bricking the endpoint. Ships with two examples: a time/calculator server
    and **`web_search`** (see below).
  - **Private web search** — the on-device model can search the live web without
    breaking its offline identity: queries go to a local **SearXNG** container,
    not a third-party API. See [`examples/searxng/`](examples/searxng/) — one
    ~370 MB container, ~180 MB RAM, and every query stays on the Mac.
  - **Escalate** — hand the current conversation to a bigger OpenAI-compatible
    model (LM Studio, Ollama, vLLM, or a cloud endpoint) when the on-device one
    is out of its depth. The key stays server-side; reasoning models show a live
    "thinking…" state so they never look frozen.

  Settings save to `config.json` and apply to the next message.

## Layout

| Path | Purpose |
|------|---------|
| `server.js` | Node server: static UI, `apfel --serve` supervisor, `/api/*` proxy |
| `menubar/` | Swift menu-bar app source (`build.sh` rebuilds the `.app`) |
| `public/` | UI (vanilla — `index.html`, `styles.css`, `app.js`) |
| `perci/` | Drop-in `ApfelMode.jsx` + `INTEGRATION.md` for embedding in Perci |
| `examples/` | Runnable MCP servers: `mcp-clock.js` (time + calculator), `mcp-websearch.js` (SearXNG-backed), and `searxng/` (container setup) |
| `config.json` | Persisted tuning (created on first save) |

**Try MCP in 30 seconds:** Tune → MCP tools → Add
`…/apfel-harness/examples/mcp-clock.js`, then ask the model "what is 19 × 23?"
For live web search, follow [`examples/searxng/README.md`](examples/searxng/README.md).

## API

`/api/health` · `/api/model` · `/api/chat` (SSE proxy) · `/api/notes/chat` (SSE
proxy to the tool-free Notes worker; see below) · `/api/escalate` (SSE
proxy to the bigger model) · `/api/count` (exact tokens) · `/api/config`
(GET/POST; MCP changes restart the shared worker only; the API key is never returned) · `/api/tools` (discovered MCP tools +
recent calls) · `/api/restart` (shared worker) · `/api/logs`.

### Tool-free Notes route

apfel runs MCP tools itself, and the harness logs their activity, so the shared
worker is not safe for private text such as notes. `POST /api/notes/chat` (same
body as `/api/chat`) goes only to a second worker on 6273, which:

- is always started with **no** `--mcp` / `--mcp-timeout` flags and **no**
  `APFEL_*` environment (apfel also loads tools from `APFEL_MCP`), whatever
  `config.json` says;
- has its output discarded: nothing from it reaches `/api/logs` or `/api/tools`;
- is left alone when MCP settings change or `/api/restart` is called.

`/api/health` reports `notesWorker: { state, toolFree, port: 6273 }`. `toolFree`
is true only if the harness launched the worker without MCP flags or
`APFEL_MCP*` environment, the worker has never printed an MCP line, and `lsof`
shows the harness's own child is the only listener on 6273 (a stray process that
already held the port is not trusted). The route answers `503` whenever
`toolFree` is false, and `403` to any request with an `Origin` header (Perci
Notes calls from its Electron main process, which sends none). Perci Notes checks
`toolFree` before every request.

## Security

The harness binds to `127.0.0.1` only, and because any web page in your
browser can still reach loopback, it also checks every request:

- **Host** must be `127.0.0.1:6271` or `localhost:6271`, otherwise `403`
  (blocks DNS rebinding).
- **Writes and sensitive reads** (every non-GET, plus `/api/config`,
  `/api/logs`, `/api/tools`, …) are refused with `403` when they carry an
  `Origin` other than the harness's own. `Origin: null` counts as foreign.
  Clients that send no `Origin` (Node, curl, the menu-bar app) are allowed.
- **`/api/notes/chat`** refuses every request that carries an `Origin`,
  including the harness's own.
- **CORS** is sent only on `GET /api/health` and `GET /api/model`
  (`Access-Control-Allow-Origin: *`; neither holds secrets). Other routes send
  no CORS headers, and `OPTIONS` preflights get `403` there.
- **The escalation API key is write-only.** `GET /api/config` returns
  `escalation.apiKeySet: true|false`, never the key. On `POST /api/config`, an
  empty or missing `escalation.apiKey` keeps the stored key, and
  `escalation.clearApiKey: true` removes it. It is stored in plain text in
  `config.json`, which is git-ignored.

## Ports

6271 (UI), 6272 (shared `apfel --serve` child, MCP tools), and 6273 (tool-free
`apfel --serve` child behind `/api/notes/chat`). Each apfel process uses about
14 MB; the model itself runs in Apple's system service.
