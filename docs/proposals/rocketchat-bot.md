# Rocket.Chat bot integration

Two-way Forge ⇄ Rocket.Chat (self-hosted) via a **bot-user Realtime (DDP)** connection.
Status: **proposal** (not implemented). Tracking: ISS-602.

## Two chat systems — which one this uses

| System | Module | Reply engine | Session table | has `source='rocketchat'`? |
|---|---|---|---|---|
| Provider chat (light) | `packages/core/src/chat/` | LLM provider direct (gemini/litellm), Forge system-prompt | `chat_sessions` | ✅ `session.ts:22` (flag `chatProvider`) |
| Agent chat (heavy) | `agent-sessions/` + runner | Claude Code on a runner (`agent:start`) — consumes device cap | `agent_sessions` | ❌ |

**Lane A uses provider chat** (the `rocketchat` enum's real home): fast, no runner cap, no device
dependency. Full-agent-on-runner is out of scope for MVP (open decision below).

## Two lanes

```
        Rocket.Chat (self-hosted)  ── bot-user, ONE DDP websocket per org ──┐
                 ▲ reply / notify           │ user message                  │
                 │ (sendMessage)            ▼                               │
   Lane B outbound                    Lane A inbound                        │
   HooksBus ─► integration_deliveries  DDP msg ─► room→binding→projectId ──►│
   (outbox) ─► drain ─► sendMessage    loadOrCreateSession(source=          │
                                       'rocketchat') ─► runChatTurn ─► reply ┘
```

- **Lane A (conversational, in+out):** bot receives a room message → resolve room→project →
  provider chat turn → post reply on the same socket.
- **Lane B (pipeline notifications, out):** subscribe `HooksBus`, write a delivery row (outbox),
  worker drains → post to the bound channel. Configurable which events forward.

## Config scoping — reuse `integration_connections` + `integration_bindings`

Forge's integration model (coolify/sentry/postman/epodsystem) already answers org-vs-project.
New `provider = 'rocketchat'`:

| Tier | Table | Scope | Holds |
|---|---|---|---|
| Connection | `integration_connections` | **org** (`ownerType='org'`) | `config={ serverUrl }`; `secretsEnc={ botUserId, botAuthToken }` (one credential, rotate once) |
| Binding | `integration_bindings` | **project** (+env) | `config={ rcRoomId, forwardEvents:[...] }`; `integrationSecret` (inbound HMAC); `label` for multi-channel |

One bot-user + one DDP socket per org connection; N project bindings route rooms↔projects and pick
forwarded events. `ownerType='org'` is already in the enum — no migration to go org-scoped. No new table.

## Bot-user connection lifecycle

Outbound, long-lived, **stateful** socket (opposite of core's `/ws` inbound server). One per active
`rocketchat` connection. Managed by `RocketChatConnectionManager` (in-RAM `Map<connectionId, LiveConn>`),
bootstrapped in `index.ts` **after** HooksBus is wired (mirrors `bootstrapRunnerAdapters()`).

Per-connection state machine:

```
DISCONNECTED ─dial─► CONNECTING ─ws open─► AUTHENTICATING ─login ok─► SUBSCRIBED (LIVE)
     ▲                    │                     │                          │
     │ teardown           └── fail ──► BACKOFF ◄─┘        socket drop /     │
     │ (config off/del)              (exp+jitter,  ◄──────ping timeout──────┘
     └───────────────────────────────breaker on repeat)
```

1. **Boot** — load `integration_connections WHERE provider='rocketchat' AND active=true`, dial each.
2. **Auth** — DDP `login` with decrypted bot token (resume-token first); re-login in-socket on expiry.
3. **Subscribe** — `stream-room-messages` for the bot's rooms; reconcile against bindings → LIVE.
4. **Inbound (Lane A)** — msg → dedupe (drop bot's own/edits/system) → room→binding→project →
   typing indicator → `loadOrCreateSession(source='rocketchat', key=room+user)` → `runChatTurn` →
   `sendMessage` reply on the same socket.
5. **Outbound (Lane B)** — HooksBus subscriber writes to `integration_deliveries` (NOT posting in the
   hook — keep transitions succeeding even if notify fails); `registerOutboxWorker` drains → post via
   the LIVE socket. Socket in BACKOFF → outbox retries later, no event lost. Idempotency: delivery
   `requestId` (e.g. `issue:<id>:status:<to>`) + the `(bindingId, requestId)` unique index.
6. **Reconnect / breaker** — drop/ping-timeout → BACKOFF, re-dial→re-login→re-subscribe; repeated
   failure sets `breakerOpenedAt` + `lastHealthStatus` (columns already on the table).
7. **Config hot-reload** — connection/binding CRUD applies live via `manager.reload(connectionId)`
   (dial / teardown / re-login) — no core restart. Binding-only change = route-table update, socket untouched.
8. **Shutdown** — close sockets in `runShutdown` alongside `closeWs` / `stopBoss`.

### Single-owner invariant — advisory lock, in-process

Two processes opening the same socket ⇒ **every user message answered twice**. Core is effectively
single-instance today (sweeper/dispatcher/outbox already assume single-owner). Safety belt for future
scale-out: each process races `pg_advisory_lock(hash(connectionId))`; only the lock holder dials that
connection. No dedicated worker process — same in-process single-owner model as the existing background workers.

## File touchpoints (planned)

| Concern | File |
|---|---|
| Connection manager + state machine | `chat/rocketchat/connection-manager.ts` |
| DDP client wrap (`@rocket.chat/sdk`) | `chat/rocketchat/ddp-client.ts` |
| Room→project routing | resolve via `integration_bindings` |
| Lane B subscriber → outbox | `notifications/notify-rocketchat.ts` (mirror `notify-transitions.ts`) |
| Bootstrap | call in `index.ts` after HooksBus wiring |
| Schema | new `provider='rocketchat'` rows only — reuse connections/bindings/deliveries (no new table) |
| Feature flag | `rocketchatBot` (mirror `chatProvider`) |

## Open decisions

1. **Lane A engine** — provider chat (recommended MVP) vs full Claude-Code agent on runner.
2. **Forward-event catalogue** — which HooksBus events/issue-statuses are offered in binding `config.forwardEvents`.
3. **DDP library** — `@rocket.chat/sdk` vs a thin raw-DDP client.

## Phasing

1. Lane B outbound. 2. Lane A inbound + reply on the bot socket. 3. threads / typing / rich formatting.
