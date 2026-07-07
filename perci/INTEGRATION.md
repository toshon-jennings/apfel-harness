# Embedding Apfel Harness as a Perci window

The harness is a self-contained web app at `http://127.0.0.1:6271`. It ships its
own dark/light theming and reads two query params, so embedding is the same
pattern Perci already uses for MarkItDownUI and Open Notebook.

## URL contract

```
http://127.0.0.1:6271/?theme=<dark|light>&perci=1
```

- `theme` — sets the palette. Pass Perci's `resolvedTheme`. Omit to follow the OS.
- `perci=1` — hides the harness's own brand mark so it sits flush under Perci's
  window chrome. Everything else (modes, gauge, composer) stays.

The harness also exposes `GET /api/health` returning
`{ ok, version, apfel: { state } }` — use it for a status dot. `apfel.state` is
`online` only when the on-device model itself is ready, not just the UI server.

## Steps

1. **Copy the component:** `perci/ApfelMode.jsx` → `~/opal/src/components/ApfelMode.jsx`.
   It mirrors `MarkItDownMode.jsx` (webview on desktop, iframe in the browser) but
   drops the vision `postMessage` bridge — apfel is fully on-device.

2. **Register the mode** in `~/opal/src/context/ModeContext.jsx` and add a sidebar
   entry + route in `~/opal/src/App.jsx`, next to `markitdown` / `opennotebook`.

3. **(Optional) Auto-start** like MarkItDownUI: add an Electron helper that spawns
   `node ~/apfel-harness/server.js` and expose `window.electron.startApfelServer`.
   The harness already supervises and auto-restarts its own `apfel --serve` child,
   so you only need to keep the Node process (port 6271) alive.

## Ports

| Port | What |
|------|------|
| 6271 | Harness UI + `/api/*` (this is what Perci embeds) |
| 6272 | `apfel --serve` child, spawned and supervised by the harness |

Both are registered in `~/.config/agent-rules/PORTMASTER.md`. 6272 is independent
of the LFM Harness's apfel instance on 11435.
