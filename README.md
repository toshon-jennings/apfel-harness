# Apfel Harness

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
- **Tools** — one-shot utilities from apfel's bundled demos (explain a command,
  shell one-liner, naming, summarize, tighten prose), each stateless.
- **Tune** — system prompt, temperature, top-p, seed, max response tokens, and
  the context-overflow strategy (`newest-first`, `sliding-window`, `summarize`,
  `strict`, …). Saved to `config.json`, applied to the next message.

## Layout

| Path | Purpose |
|------|---------|
| `server.js` | Node server: static UI, `apfel --serve` supervisor, `/api/*` proxy |
| `public/` | UI (vanilla — `index.html`, `styles.css`, `app.js`) |
| `perci/` | Drop-in `ApfelMode.jsx` + `INTEGRATION.md` for embedding in Perci |
| `config.json` | Persisted tuning (created on first save) |

## API

`/api/health` · `/api/model` · `/api/chat` (SSE proxy) · `/api/count` (exact
tokens) · `/api/config` (GET/POST) · `/api/restart` · `/api/logs`.

## Ports

6271 (UI) and 6272 (`apfel --serve` child) — registered in
`~/.config/agent-rules/PORTMASTER.md`. Independent of the LFM Harness's apfel on
11435.
