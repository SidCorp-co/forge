# WebSocket

Real-time channel between `forge/core` and clients (`forge/web`, `forge/dev`,
embeddable widget). One endpoint, room-scoped, JSON envelopes.

## Endpoint & connection

- **URL:** `/ws` on the same host/port as the HTTP API. `WS_URL` is derived
  from `NEXT_PUBLIC_API_URL` (e.g. `http://api/api` → `ws://api/ws`).
- **Auth at upgrade:** required. Three accepted forms, in order:
  1. `Authorization: Bearer <jwt|deviceToken>` — used by native clients
     that can set arbitrary headers (Tauri).
  2. `Sec-WebSocket-Protocol: forge.bearer.<jwt>` — used by browsers that
     can't set Authorization on a WS upgrade. The server echoes the matched
     subprotocol back so the handshake completes (ISS-286).
  3. `forge_auth` cookie (same-origin browser path) — Web's default.
- The legacy `?token=<jwt>` query path was removed in ISS-315 (leaked into
  access logs / Referer / history).
- Failed auth → `HTTP/1.1 401 Unauthorized` and the socket is destroyed.
  A `404` from any layer means routing is broken, not auth.
- **Heartbeat:** server pings every 30s; missing pong → terminate.

## Subscription model

A connection is an authenticated principal (`user` or `device`). Principals
join *rooms* to receive a stream of events scoped to that room. The server
authorizes every subscribe via `canSubscribe(principal, room)`; an
unauthorized subscribe gets a `subscribe.denied` event back, not a
disconnect.

| Room | Membership rule |
|---|---|
| `project:<projectId>` | user is a project member, or device owned by such user |
| `user:<userId>` | the principal IS that user (or its owning user, for devices) |
| `device:<deviceId>` | principal owns the device, or IS the device |
| `runner:<runnerId>` | runner's device or a member of runner's project |

**Client → server messages** (JSON, one frame each):

```json
{ "type": "subscribe",   "room": "project:abc" }
{ "type": "unsubscribe", "room": "project:abc" }
```

Runner control adds `{"type":"runner:register|unregister|update", ...}` —
device-only, gated by the `runnerFramework` feature flag.

**Server → client envelope** (every published event):

```json
{ "event": "issue.updated", "data": { ... }, "timestamp": "2026-04-28T..." }
```

## Events

Event names are dot-cased (`issue.updated`, not `issue:updated`). Categories
and the rooms they publish to:

| Category | Room | Source |
|---|---|---|
| `issue.*`, `task.*`, `schedule.*`, `skill.*` | `project:<id>` | `forge/core/src/ws/broadcast-subscribers.ts` |
| `notification.*`, `user.preferencesChanged`, `chat.message` | `user:<id>` | `chat-sessions/routes.ts`, `chat/routes.ts`, broadcast-subscribers |
| `job.*` (incl. `job.event` with `seq`) | `project:<id>` (and `device:<id>` for assignment) | `jobs/lifecycle-routes.ts`, `jobs/events-routes.ts`, `jobs/dispatcher.ts` |
| `runner.*`, `device.status`, `pipeline.*` | `project:<id>` / `device:<id>` / `runner:<id>` | `runners/`, `devices/` |
| `agent:*` (legacy colon names — agent runner internal) | `device:<id>` | `runners/adapters/claude-code.ts` |

For the authoritative list, grep `roomManager.publish` in `forge/core/src/`.
Event payloads are typed by the publishing module — do not derive shapes
from this doc, read the call site.

`job.event` carries a monotonic `seq` per `jobId` so clients can request
missed events from the REST endpoint on reconnect (replay semantics).
Project-room events are best-effort: the client invalidates broad React
Query keys on reconnect to refetch anything visible.

## Server primitives

`forge/core/src/ws/server.ts` exports the lifecycle:

- `attachWs(server)` — bind to the existing HTTP server, mount `/ws`.
- `closeWs()` — graceful shutdown (sends 1001, falls back to terminate).
- `roomManager` — singleton `RoomManager` from `ws/rooms.ts`.

`RoomManager` exposes:

- `subscribe(sub, room)` / `unsubscribe(sub, room)` — manual membership.
- `publish(room, { event, data })` — fan out to all OPEN sockets in a
  room. Returns delivered count.
- `removeAll(sub)` — invoked on socket close.

There is **no** session-targeted send and **no** `waitForSubscriber()` —
both removed. To target a single user, publish to `user:<userId>`.

## Client integration (forge/web)

`forge/web/src/lib/ws/`:

- **`client.ts`** — `wsClient` singleton. One connection per tab. Resends
  all room subscriptions on every reopen. Reconnect is jittered exponential
  backoff (1s base, 30s cap). Browsers authenticate via the `forge_auth`
  cookie automatically; cross-origin embeds call `setBearerToken(jwt)`
  before `connect()` to use the subprotocol path.
- **`use-websocket.ts`** — `useWebSocket()` mounts the singleton once under
  the auth provider. Listens via `event-router.ts` which maps event names
  to React Query `invalidateQueries` calls.
- **`use-room.ts`** — `useRoom(room)` subscribes a component to a room for
  its lifetime; pass null while data is loading.
- **`event-router.ts`** — single dispatch table. Cache keys here MUST match
  the keys in feature hook modules — renaming one side silently breaks
  realtime updates.
- **`seq-tracker.ts`** — tracks last-seen `seq` per job for replay.

The widget (`forge/web/src/widget/widget-root.tsx`) consumes `chat.message`
events directly for streaming AI chat UI.

## Design decisions

1. **Auth at upgrade, not in payloads.** The connection identifies the
   principal once; every published event carries only IDs. Sensitive data
   is fetched via authenticated REST after a cache-invalidation event.
2. **Room-scoped, not session-scoped.** A "session" is a principal +
   rooms-of-interest. Unicast = publish to that user's room.
3. **Cache invalidation, not state push.** WS events trigger React Query
   refetches rather than carry domain state. Keeps REST as source of truth
   and avoids stale-data races.
4. **Jittered exponential backoff** prevents reconnect stampedes after
   server restart. Project events are replayed best-effort by invalidating
   `['issues'|'jobs'|'projects']` on reopen; job events use `seq` for exact
   replay via REST.
5. **Subscribe authorization on every join.** Membership changes (project
   removed, device unbound) are enforced at subscribe-time; existing
   subscriptions are not retroactively pruned.

## Reverse proxy / Cloudflare

WS upgrade only survives if every hop preserves it.

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

Without `proxy_http_version 1.1` and the upgrade headers, nginx downgrades
the request to plain HTTP GET and the catch-all returns 404.

**Cloudflare:** *Network → WebSockets* must be **On** at the zone level
(default off on some plans). SSL/TLS mode must be `Full` or `Full (strict)`
— `Flexible` breaks WS. CF only proxies WS over HTTP/1.1; browsers and
`wscat` negotiate it automatically, `curl` does not.

**Diagnostic ladder** when upgrades fail in production:

1. `curl --http1.1 -H "Upgrade: websocket" -H "Connection: upgrade" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -i https://your-host/ws` — expect `101` after auth, or `401` if routing OK but auth missing. `404` = routing broken.
2. Same against the origin host:port directly — bypasses nginx.
3. Same against the upstream container — bypasses Cloudflare.
4. Tail core logs for `[ws]` entries.
