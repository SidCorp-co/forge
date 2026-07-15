# Chat

Interactive conversational sessions with project agents — conversation, not pipeline execution.

## Overview

- Open a chat session with an agent inside a project; agent has project memory, skills, MCP tools.
- Free-form — not routed through the 15-status pipeline.
- Use for "what's the state of ISS-42?", brainstorming, exploration before creating an issue.

## Data Flow

```
  User opens chat in web UI
        │
        ▼
  ChatSession created (POST /api/chat/sessions)
        │
        ▼
  User sends message
        │
        ▼ POST /api/chat
  ┌──────────────────┐
  │ Build system     │
  │ prompt with:     │
  │ - project memory │ (see memory-knowledge)
  │ - available tools│
  │ - recent messages│
  └────────┬─────────┘
           ▼
  Resolved LLM provider runs the turn (runChatTurn → runTurnEvents)
  — an OpenAI-style tool-calling loop (buildProjectToolset,
    up to MAX_TOOL_ITERATIONS=8; ISS-604). Never dispatched to a device.
           ▼
  Streaming SSE response
           ▼
  Conversation appended inline to chat_sessions.messages
           ▼
  One chat_logs audit row written per query→reply turn
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| User message | Web UI | Text input |
| Project context | `project.documentId` | Scopes memory, skills, devices |
| Session memory | Previous messages in session | Accumulates |

## Core Entities

### `ChatSession` (`chat_sessions`)

| Field | Description |
|-------|-------------|
| `id` | Canonical UUID |
| `projectId` | Belongs to one project |
| `userId` | Authenticated owner (nullable; set for Bearer-JWT requests) |
| `userKey` | Audit key propagated to `chat_logs.userKey` |
| `title` | Session title (nullable) |
| `source` | `web` \| `widget` \| `rocketchat` \| `telegram` (default `web`) |
| `messages` | jsonb — inline conversation history |
| `createdAt` / `updatedAt` | Timestamps |

There is no session `status` or lifecycle column — a session exists until it is deleted.

### `ChatLog` (`chat_logs`)

A per-turn audit/analytics row — **one row per query→reply turn**, not a per-message log. The conversation itself lives inline in `chat_sessions.messages`; `chat_logs` is the separate audit trail.

| Field | Description |
|-------|-------------|
| `id` | Canonical UUID |
| `sessionId` | Parent chat session id |
| `projectSlug` | Project the turn ran under |
| `userKey` | Audit key (nullable) |
| `query` / `reply` | The user query and agent reply for the turn |
| `model` | Model used |
| `ragContext` | Retrieved context for the turn (jsonb) |
| `toolCalls` | Tools the agent invoked (jsonb) |
| `usage` | Token/cost usage (jsonb) |
| `iterations` | Agent loop iterations |
| `durationMs` | Turn duration |
| `error` | Turn error message, null on success |
| `queryIntent` | Classified intent of the user query |
| `condensedQuery` | Condensed/normalized form of the query used for retrieval |
| `source` | Origin channel (default `web`) |
| `qualitySignals` | Auto-derived quality signals for the turn (jsonb) |
| `qaRating` / `qaNotes` | Manual QA rating (`good` \| `bad` \| `flagged`) and notes |
| `createdAt` | Timestamp |

## Key Business Flows

### Start a chat

1. User navigates **Project → Chat**
2. `POST /api/chat/sessions` → new `ChatSession`
3. WebSocket subscription opens for streaming

### Send a message

1. User types message → `POST /api/chat`
2. System prompt built (project context + recent history)
3. The resolved LLM provider runs the turn via `runChatTurn` → `runTurnEvents` — an OpenAI-style tool-calling loop over the project toolset (`buildProjectToolset`, `chat/tools/registry.ts`), up to `MAX_TOOL_ITERATIONS=8` (ISS-604). The turn is **never** dispatched to a device — device-backed agent runs are the separate `agent-sessions/` path.
4. Response streams back to the browser via SSE
5. Only the FINAL assistant text is appended inline to `chat_sessions.messages`; intra-turn tool round-trips are ephemeral. One `chat_logs` row written for the query→reply turn

### Role-aware lenses

The system prompt's tone/depth is shaped by the reader's assigned working lens(es), not by permissions or tool access:

- `memberLenses = ['technical', 'product']` (`schema.ts:218`), stored on `organizationMembers.lenses` (migration `0149_member_lenses.sql`).
- `resolveMemberLenses()` reads the member's lenses; `buildChatRoleSection()` / `buildChatNudge()` turn them into an orientation nudge injected into the system prompt (`prompt/system.ts:88-160`).
- Lenses are **soft** — they change tone/depth only. `product` (or no lens) is the historical default; security guardrails apply regardless of lens.
- A session's durable `metadata.lensOverride` marker (ISS-674) can pin the chat voice regardless of the principal's assigned lens — see `agent-sessions/chat-turn.ts`.

### Delete a session

1. User deletes the session → `DELETE /api/chat/sessions/:id`
2. The row is hard-deleted (204). There is no status column and no auto-end mechanism.

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `GET` | `/api/chat/sessions` | user | List caller's sessions |
| `POST` | `/api/chat/sessions` | user | Create session |
| `GET` | `/api/chat/sessions/:id` | user | Fetch one session (includes inline `messages`) |
| `PATCH` | `/api/chat/sessions/:id` | user | Rename (title only) |
| `DELETE` | `/api/chat/sessions/:id` | user | Hard-delete session |
| `POST` | `/api/chat` | user | Send message, get streamed response |
| `GET` | `/api/chat-logs` | user | List per-turn audit rows (also `/recent`, `/flagged`, `/:id`) |
| `PATCH` | `/api/chat-logs/:id` | user | Set manual QA rating/notes (`qaRating`/`qaNotes`) |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Read from | [memory-knowledge](../memory-knowledge/README.md) | Context retrieval | Every turn |
| Read from | [skills](../skills/README.md) | Available tool list (project-scoped) | At session start |
| Read from | [skills](../skills/README.md) / MCP | Project toolset for the tool-calling loop | Every turn |

## Commands / Jobs

_No chat-specific crons or background jobs are registered._

## Distinction from Jobs

| | Chat | Job |
|---|------|-----|
| Trigger | User message | Pipeline transition / manual dispatch |
| Interface | Conversational | Structured skill execution |
| Runs on | Resolved LLM provider (in-core tool-calling loop) | Always a paired device |
| Outcome | Answer / discussion | Status change / code change |
| Captured | chat_logs (per query→reply turn, audit) | JobEvents (per stdout chunk) |
| Related to issue | Optional | Always |

## Ask Agent (device-backed chat)

A second, distinct chat path — the "Ask Agent" dock in web-v2 — that dispatches the turn to a **paired device** instead of running the in-core tool-calling loop:

- Frontend: `packages/web-v2/src/features/session/components/{chat-dock.tsx,chat-screen.tsx,runner-picker.tsx}` + `use-chat-dock.ts`; wired into `app/(workspace)/layout.tsx`.
- Backend: `packages/core/src/agent-sessions/chat-turn.ts` (`dispatchChatTurn`) + `lifecycle-routes.ts` (`/start`, `/send`) + `turns-routes.ts` (per-turn edit/regenerate/fork/rerun).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/agent-sessions/start` | Create a session and dispatch its first turn |
| `POST` | `/api/agent-sessions/send` | Send a follow-up message on an existing session (`sessionId` in body) |
| `GET` | `/api/agent-sessions/:id/turns` | List turns |
| `PATCH` | `/api/agent-sessions/:id/turns/:turnId` | Edit a user turn |
| `POST` | `/api/agent-sessions/:id/turns/:turnId/regenerate` | Regenerate from a turn |
| `POST` | `/api/agent-sessions/:id/fork` | Fork the session from a turn |
| `POST` | `/api/agent-sessions/:id/rerun` | Rerun the session |

**vs `/api/chat`:**

- Runs `claude` on the paired device (or locally for desktop) against that runner's repo path — unlike `/api/chat`, which always runs the resolved LLM provider in-core and is **never** dispatched to a device.
- Supports attachments, page-context headers, and fork/regenerate/rerun of individual turns.
- Session-scoped `metadata.lensOverride` (ISS-674) can pin the chat voice for the session, similar to the role-aware lenses described above.

## RocketChat inbound flow

External-channel messages (Rocket.Chat rooms) are a third entry point, distinct from both `/api/chat` and Ask Agent:

```
RocketChat room message
        │
        ▼
startRocketChatManager() (index.ts) → RocketChatConnectionManager
        │ (one long-lived DDP connection per configured integration)
        ▼
runExternalChatTurn (chat/external-chat.ts)
        │ — runs the shared runTurnEvents loop as an agentic worker:
        │   temperature 0.2, requireInitialToolUse when tools are given
        ▼
Reply posted back to the RC room + one chat_logs row (source='rocketchat')
```

- One session per RC room, never rotated. Bounded so a chatty room can't grow the prompt unboundedly: provider-visible history window capped at 30 messages, persisted transcript capped at 200.
- `requireInitialToolUse` forces the first round to call a tool when tools are provided, so the model can't invent an answer without investigating.
- Persona is built via `rocketChatPersona()` (`integrations/rocketchat/connection-manager.ts`) and passed into the system prompt (ISS-609).
- Writes a `chat_logs` row with `toolCalls` captured, so callers can verify reply claims against what actually ran.
