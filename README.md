# Apfel Harness

> [!IMPORTANT]
> Apfel Harness is embedded as a first-class window in Perci (`APFEL_WINDOW_ID`). Updates should be made to both this standalone repository (`~/apfel-harness`) and the Perci codebase (`~/opal`).

A local web GUI that wraps the [`apfel`](https://github.com/Arthur-Ficial/apfel)
CLI — Apple Intelligence (on-device FoundationModels) from a browser. Built to
squeeze every ounce out of a tiny 4,096-token, fully-offline model, and to drop
into [Perci](../opal) as a first-class window.

```
node server.js      # or: npm start
open http://127.0.0.1:6271
```

`server.js` spawns and supervises its own `apfel --serve` child (port 6272,
auto-restart with backoff, health-gated) and proxies it. No cloud, no keys.

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
| `public/` | UI (vanilla — `index.html`, `styles.css`, `app.js`) |
| `perci/` | Drop-in `ApfelMode.jsx` + `INTEGRATION.md` for embedding in Perci |
| `examples/` | Runnable MCP servers: `mcp-clock.js` (time + calculator), `mcp-websearch.js` (SearXNG-backed), and `searxng/` (container setup) |
| `config.json` | Persisted tuning (created on first save) |

**Try MCP in 30 seconds:** Tune → MCP tools → Add
`…/apfel-harness/examples/mcp-clock.js`, then ask the model "what is 19 × 23?"
For live web search, follow [`examples/searxng/README.md`](examples/searxng/README.md).

## API

`/api/health` · `/api/model` · `/api/chat` (SSE proxy) · `/api/escalate` (SSE
proxy to the bigger model) · `/api/count` (exact tokens) · `/api/config`
(GET/POST; MCP changes restart the child) · `/api/tools` (discovered MCP tools +
recent calls) · `/api/restart` · `/api/logs`.

## Ports

6271 (UI) and 6272 (`apfel --serve` child) — registered in
`~/.config/agent-rules/PORTMASTER.md`. Independent of the LFM Harness's apfel on
11435.
