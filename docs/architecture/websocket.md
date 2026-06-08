# WebSocket

Real-time channel: `packages/core` ↔ clients (`packages/web-v2`, `packages/dev`). One endpoint, room-scoped, JSON envelopes.

## Endpoint & connection

- **URL:** `/ws`, same host/port as HTTP API. `WS_URL` derived from `NEXT_PUBLIC_API_URL` (e.g. `http://api/api` → `ws://api/ws`).
- **Auth at upgrade** (required), accepted forms in order:
  1. `Authorization: Bearer <jwt|deviceToken>` — native clients that set arbitrary headers (Tauri).
  2. `Sec-WebSocket-Protocol: forge.bearer.<jwt>` — browsers (can't set Authorization on WS upgrade); server echoes matched subprotocol to complete handshake (ISS-286).
  3. `forge_auth` cookie — same-origin browser; Web's default.
- `?token=<jwt>` query path removed in ISS-315 (leaked into access logs / Referer / history).
- Failed auth → `HTTP/1.1 401 Unauthorized`, socket destroyed. `404` from any layer = routing broken, not auth.
- **Heartbeat:** server pings every 30s; missing pong → terminate.

## Subscription model

Connection = authenticated principal (`user` or `device`). Principals join *rooms* for room-scoped event streams. Server authorizes each subscribe via `canSubscribe(principal, room)`; unauthorized subscribe → `subscribe.denied` event (no disconnect).

| Room | Membership rule |
|---|---|
| `project:<projectId>` | user is a project member, or device owned by such user |
| `user:<userId>` | the principal IS that user (or its owning user, for devices) |
| `device:<deviceId>` | principal owns the device, or IS the device |
| `runner:<runnerId>` | runner's device or a member of runner's project |

**Client → server** (JSON, one frame each):

```json
{ "type": "subscribe",   "room": "project:abc" }
{ "type": "unsubscribe", "room": "project:abc" }
```

Runner control adds `{"type":"runner:register|unregister|update", ...}` — device-only (handled in `ws/server.ts` for device principals).

**Server → client envelope** (every published event):

```json
{ "event": "issue.updated", "data": { ... }, "timestamp": "2026-04-28T..." }
```

## Events

Event names dot-cased (`issue.updated`, not `issue:updated`). Categories and rooms:

| Category | Room | Source |
|---|---|---|
| `issue.*`, `task.*`, `schedule.*`, `skill.*` | `project:<id>` | `packages/core/src/ws/broadcast-subscribers.ts` |
| `notification.*`, `user.preferencesChanged` | `user:<id>` | broadcast-subscribers |
| `job.*` (incl. `job.event` with `seq`) | `project:<id>` (and `device:<id>` for assignment) | `jobs/lifecycle-routes.ts`, `jobs/events-routes.ts`, `jobs/dispatcher.ts` |
| `runner.*`, `device.status`, `pipeline.*` | `project:<id>` / `device:<id>` / `runner:<id>` | `runners/`, `devices/` |
| `agent:*` (legacy colon names — agent runner internal) | `device:<id>` | `runners/adapters/claude-code.ts` |

- Authoritative list: grep `roomManager.publish` in `packages/core/src/`.
- Payloads typed by publishing module — read the call site, don't derive from this doc.
- `job.event` carries monotonic `seq` per `jobId` → clients request missed events from REST on reconnect (replay).
- Project-room events best-effort: client invalidates broad React Query keys on reconnect to refetch visible data.

## Server primitives

`packages/core/src/ws/server.ts` exports lifecycle:

- `attachWs(server)` — bind to existing HTTP server, mount `/ws`.
- `closeWs()` — graceful shutdown (sends 1001, falls back to terminate).
- `roomManager` — singleton `RoomManager` from `ws/rooms.ts`.

`RoomManager`:

- `subscribe(sub, room)` / `unsubscribe(sub, room)` — manual membership.
- `publish(room, { event, data })` — fan out to all OPEN sockets in room; returns delivered count.
- `removeAll(sub)` — invoked on socket close.

**No** session-targeted send, **no** `waitForSubscriber()` (both removed). Target a single user via `publish` to `user:<userId>`.

## Client integration (packages/web-v2)

`packages/web-v2/src/lib/ws/`:

- **`client.ts`** — `wsClient` singleton, one connection per tab. Resends all room subscriptions on every reopen. Reconnect = jittered exponential backoff (1s base, 30s cap). Browsers auth via `forge_auth` cookie automatically; cross-origin embeds call `setBearerToken(jwt)` before `connect()` for the subprotocol path.
- **`use-websocket.ts`** — `useWebSocket()` mounts the singleton once under the auth provider; listens via `event-router.ts` (maps event names → React Query `invalidateQueries`).
- **`use-room.ts`** — `useRoom(room)` subscribes a component to a room for its lifetime; pass null while loading.
- **`event-router.ts`** — single dispatch table. Cache keys MUST match feature hook modules — renaming one side silently breaks realtime updates.
- **`seq-tracker.ts`** — tracks last-seen `seq` per job for replay.

## Design decisions

1. **Auth at upgrade, not in payloads.** Principal identified once; events carry only IDs. Sensitive data fetched via authenticated REST after a cache-invalidation event.
2. **Room-scoped, not session-scoped.** A "session" = principal + rooms-of-interest. Unicast = publish to that user's room.
3. **Cache invalidation, not state push.** Events trigger React Query refetches, not domain state. Keeps REST as source of truth, avoids stale-data races.
4. **Jittered exponential backoff** prevents reconnect stampedes after restart. Project events replayed best-effort by invalidating `['issues'|'jobs'|'projects']` on reopen; job events use `seq` for exact REST replay.
5. **Subscribe authorization on every join.** Membership changes (project removed, device unbound) enforced at subscribe-time; existing subscriptions not retroactively pruned.

## Reverse proxy / Cloudflare

WS upgrade survives only if every hop preserves it.

**nginx — minimal `location` block:**

```nginx
location /ws {
    proxy_pass http://core_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;
}
```

Without `proxy_http_version 1.1` + upgrade headers, nginx downgrades to plain HTTP GET → catch-all returns 404.

**Cloudflare:** *Network → WebSockets* must be **On** at zone level (default off on some plans). SSL/TLS mode must be `Full` or `Full (strict)` — `Flexible` breaks WS. CF only proxies WS over HTTP/1.1; browsers and `wscat` negotiate automatically, `curl` does not.

**Diagnostic ladder** when upgrades fail in production:

1. `curl --http1.1 -H "Upgrade: websocket" -H "Connection: upgrade" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -i https://your-host/ws` — expect `101` after auth, `401` if routing OK but auth missing, `404` = routing broken.
2. Same against origin host:port directly — bypasses nginx.
3. Same against upstream container — bypasses Cloudflare.
4. Tail core logs for `[ws]` entries.
