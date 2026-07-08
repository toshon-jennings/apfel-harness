# Private web search for the on-device model

This gives the tiny on-device model **live web search without breaking its
private, on-device identity** — queries go to a SearXNG metasearch instance
running in a local container, not to any third-party API. Nothing leaves the Mac
except the anonymized outbound searches SearXNG itself makes.

```
model ──asks──▶ apfel ──runs──▶ mcp-websearch.js ──HTTP──▶ SearXNG (localhost:8888)
   ▲                                                              │
   └───────────────── grounded answer ◀── concise results ◀───────┘
```

## Footprint

One container: **~200 MB disk, ~150 MB RAM idle**, negligible CPU. No Redis/Caddy
— the limiter is off (single-user, localhost), which is what keeps it to a single
lightweight container. Runs inside your existing OrbStack VM, so no extra VM cost.

## Setup

1. **Config** — copy `settings.yml` to `~/searxng/settings.yml` and set a secret:
   ```bash
   mkdir -p ~/searxng && cp settings.yml ~/searxng/settings.yml
   sed -i '' "s/CHANGE_ME_run_openssl_rand_hex_32/$(openssl rand -hex 32)/" ~/searxng/settings.yml
   ```

2. **Run** — localhost-only, host 8888 → container 8080 (8080 is vLLM's):
   ```bash
   docker run -d --name searxng-apfel --restart unless-stopped \
     -p 127.0.0.1:8888:8080 \
     -v "$HOME/searxng:/etc/searxng" \
     searxng/searxng:latest
   ```

3. **Verify JSON** (must return JSON, not HTML):
   ```bash
   curl "http://127.0.0.1:8888/search?q=test&format=json" | head -c 200
   ```

4. **Attach the tool** — in the harness: Tune → MCP tools → Add
   `…/apfel-harness/examples/mcp-websearch.js`, then ask something current like
   "search the web: what's the latest LTS Node version?"

The MCP server reads `SEARXNG_URL` (default `http://127.0.0.1:8888`) and
`SEARX_RESULTS` (default 4). Port 8888 is registered in `PORTMASTER.md`.

## Managing the container

```bash
docker stop searxng-apfel      # pause
docker start searxng-apfel     # resume
docker rm -f searxng-apfel     # remove (config in ~/searxng is kept)
```
