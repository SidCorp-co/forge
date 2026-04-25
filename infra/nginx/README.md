# `infra/nginx`

Reference snapshots of the nginx site configs that front the Jarvis Agents
deploys. These files are committed for traceability and to make ingress
problems debuggable from the repo. **They are not deployed automatically** —
the live source of truth is the VPS at `root@165.22.96.128:/etc/nginx/sites-enabled/`.

When the live site changes, `scp` it back into this folder and commit.

## Hosts

| File | Hostname | Upstreams |
|------|----------|-----------|
| `stg-jarvis-a2.thejunix.com.conf` | staging | `core` on `:19450`, `web` on `:19451` |

## WebSocket routing (ISS-238 reference)

`/ws` requires three things to work end-to-end through the public edge:

1. **Core process** mounts the WebSocket server at `/ws` and shares the
   main HTTP server. See `forge/core/src/ws/server.ts`. `/health` reports
   `ws.ok: true` when the server is attached.

2. **nginx site** has a dedicated `location /ws` block with
   `proxy_http_version 1.1` and the `Upgrade` / `Connection` headers, so
   the upgrade handshake is preserved across the proxy. Without these,
   nginx forwards the request as a plain HTTP GET and core's Hono catch-all
   returns `{"code":"NOT_FOUND","message":"Not Found: GET /ws"}`.

3. **Cloudflare zone** (`thejunix.com`) has `Network -> WebSockets` set to
   **On**. CF supports WebSockets only over HTTP/1.1 between client and
   edge; with the toggle off, requests for `/ws` are downgraded to plain
   HTTP/2 GETs and origin returns the same 404 envelope. RFC-compliant
   WebSocket clients (browsers, `wscat`, `ws` npm) negotiate HTTP/1.1
   automatically — so verifying with `curl` requires `--http1.1`,
   otherwise curl uses HTTP/2 by default and you'll see the 404 even
   when WebSockets are working for real clients.

### Verifying

```bash
# 1. Loopback inside the VPS — exercises core only
ssh root@165.22.96.128 'curl -sS -i \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:19450/ws | head -5'
# Expect: HTTP/1.1 401 Unauthorized   (auth required = upgrade reached core)

# 2. nginx in the VPS, bypassing Cloudflare
ssh root@165.22.96.128 'curl -sS -i -k \
  -H "Host: stg-jarvis-a2.thejunix.com" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://127.0.0.1/ws | head -5'
# Expect: HTTP/1.1 401 Unauthorized   (upgrade preserved across nginx)

# 3. Through Cloudflare with explicit HTTP/1.1 — mimics a browser
curl -sS -i --http1.1 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://stg-jarvis-a2.thejunix.com/ws | head -5
# Expect: HTTP/1.1 401 Unauthorized   (CF preserves upgrade -> origin)
# If you see HTTP/1.1 404, CF -> Network -> WebSockets is OFF for the zone.

# 4. End-to-end with a real WebSocket client (matches browser behaviour)
node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket("wss://stg-jarvis-a2.thejunix.com/ws");
  ws.on("open", () => { console.log("OPEN 101 OK"); ws.close(); });
  ws.on("unexpected-response", (_, r) => console.log("HTTP", r.statusCode));
  ws.on("error", (e) => console.log("ERROR", e.message));
'
# Without auth: "HTTP 401" -- routing OK, awaiting credentials.
# With a valid forge_auth cookie or Bearer token: "OPEN 101 OK".
```

`401 Unauthorized` from steps 1-4 is the **expected** status for an
unauthenticated handshake — the WS server requires a Bearer token or
`forge_auth` cookie on upgrade (see `forge/core/src/ws/server.ts` and
`docs/architecture/websocket.md`). It confirms routing is healthy.

`404` from any of those steps means routing is broken at that layer:

| Step that returns 404 | Likely cause |
|---|---|
| 1 (loopback) | `core` is not attaching the WS server (check `/health` `ws.ok`) |
| 2 (nginx) | `/ws` location missing or lacking `Upgrade`/`Connection` headers |
| 3 (CF, --http1.1) | Cloudflare zone `Network -> WebSockets` is OFF |
| 4 (real WS client) | Same as 3 — browsers will also fail |

## Cloudflare action item

The Cloudflare zone toggle cannot be flipped from the repo or via SSH —
it requires dashboard access:

1. Cloudflare dashboard -> `thejunix.com` -> **Network**.
2. Enable **WebSockets**.
3. Optionally check **Rules -> Configuration Rules** to make sure no rule
   matches `*stg-jarvis-a2.thejunix.com/ws*` with cache or transform
   actions that would strip `Upgrade` / `Connection` headers.
4. SSL/TLS mode must be `Full` or `Full (strict)` — `Flexible` breaks WS.

After enabling, re-run verification step 3 above; it should return 401,
not 404.
