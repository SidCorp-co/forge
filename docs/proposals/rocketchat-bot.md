# Rocket.Chat bot integration

Two-way Forge ⇄ Rocket.Chat (self-hosted) via a **bot-user Realtime (DDP)** connection.
Status: **Lane A shipped + live** (chat.sidcorp.co, RC 8.0.1; commits under ISS-604 P2a–P2d) —
config via standard `integration_connections`/`bindings`; bot answers @-mentions in-channel.
Tracking: ISS-602 (bot) · ISS-604 (chat engine). Section "Lane A intelligence" below = next design.

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

---

## As-built (Lane A, shipped + live — supersedes the planned touchpoints above)

| Concern | Actual |
|---|---|
| Chat engine | `chat/` provider-chat, OpenAI/LiteLLM tool-calling (ISS-604 P1); non-SSE entrypoint `chat/external-chat.ts::runExternalChatTurn` (P2a) |
| RC config | standard `integration_connections`(org: serverUrl + vault secrets{authToken,userId}) + `integration_bindings`(project: `config.rid`); provider adapter `integrations/rocketchat/adapter.ts` (connection-only, healthcheck `/api/v1/me`) |
| DDP | **raw client over `ws`** — NOT `@rocket.chat/sdk` — `integrations/rocketchat/ddp-client.ts` (login{resume}, sub `stream-room-messages __my_messages__`, sendMessage, ping) |
| Manager | `integrations/rocketchat/connection-manager.ts` — `pg_advisory_lock` single-owner, exp-backoff reconnect, bootstrap after `attachWs`, teardown in `runShutdown` |
| Inbound gate | `integrations/rocketchat/inbound-gate.ts` — drop own/system/edit/empty + **@-mention-gated** |
| Tool principal | project org owner (read-only toolset, fenced to the room's project) |
| No feature flag | config-driven: manager idle when no active `rocketchat` connections |

Verified live on `chat.sidcorp.co` (RC 8.0.1): @-mention → reply in-channel, `chat_logs.source='rocketchat'`.

## Lane A intelligence — conversation context + write-to-Forge (SHIPPED 2026-07-03, ISS-609)

As-built deltas vs the design below: `rocketchat_search` deferred (phase-2); threaded mentions reply
in-thread; RC config now has full web-v2 UI (project settings → Integrations → Rocket.Chat card:
connect/rid/rotate/test; workspace drawer: serverUrl + token) backed by real REST provider schemas
(`rid` binding-tier) + `manager.reload()` hot-reload on every rocketchat CRUD. Key files:
`integrations/rocketchat/{rest-client,context}.ts`, `chat/tools/{guards,mcp-adapter,registry}.ts`,
`web-v2 features/integrations/components/rocketchat-section.tsx`.

Goal: a discussion happens in-channel → user @-mentions the bot → bot reads the discussion, understands
the problem, and uses tools to answer OR act on Forge (e.g. capture the discussion as an issue).

Three pieces (system prompt alone is insufficient):

- **A — conversation context (agentic-retrieval, seed + expand).** On mention, seed the prompt with the
  last **~20** room messages (+ the full **thread** if the mention is threaded), formatted `[user]: text`
  (drop system/bot-own). Do NOT hardcode recursion for references to older topics — instead give the model
  bounded RC tools and let it decide depth:
  - `rocketchat_history(rid, before?, count?)` — page back. Cap **50 msg/call, 3 calls/turn**.
  - `rocketchat_search(rid, query)` — for vague references ("cái tuần trước"). *(phase-2, optional.)*
  - Overall bounded by the existing tool-loop `maxToolIterations` (=5).
  - Prompt: "recent context below; if the discussion references older matter, call `rocketchat_history`/`search` before concluding."
- **B — system prompt.** `buildSystemPrompt` gains an optional `conversationContext` block + a Forge-assistant
  persona: read the discussion, prefer `forge_*` tools over guessing, create issues from discussion when asked
  (draft-first + summarize for confirmation), reply concisely in Vietnamese. `systemPromptOverride` still wins.
- **C — write tools.** Extend the allowlist with `forge_issues` create/update + `forge_comments` create, run as
  the project org owner (writer). **Safety: bot-created issues default to `draft`** (never `open` — an `open`
  issue auto-triages → spawns a pipeline run); a human flips to `open` to start the pipeline.

RC history/search tools are RC-scoped (read from Rocket.Chat), added to the same per-turn toolset alongside
the Forge tools.

### Decisions to lock (before build)
1. Seed depth ~20 + thread inclusion (recommended).
2. Write scope: `forge_issues` create/update + `forge_comments` create.
3. Issue-creation safety: **draft-first + confirm** (recommended) vs direct `open`.
4. Authz: tools run as project org owner (any channel member mentioning the bot acts under that principal) — RC-user→Forge-user mapping deferred.
