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
  Dispatched to active device (if pairing-backed)
  OR run directly via LiteLLM (if LLM-only mode)
           ▼
  Streaming response
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
| `source` | Origin channel (default `web`) |
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
3. Pairing-backed: routed to device; device runs `claude` in chat mode
4. LLM-only: direct LiteLLM call
5. Response streams back via WebSocket
6. Conversation appended inline to `chat_sessions.messages`; one `chat_logs` row written for the query→reply turn

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
| `POST` | `/api/chat` | user / agent via MCP | Send message, get streamed response |
| `GET` | `/api/chat-logs` | user | List per-turn audit rows (also `/recent`, `/flagged`, `/:id`) |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Read from | [memory-knowledge](../memory-knowledge/README.md) | Context retrieval | Every turn |
| Read from | [skills](../skills/README.md) | Available tool list (project-scoped) | At session start |
| Receives from / emits to | [devices](../devices/README.md) | Runs `claude` in chat mode (if device-backed) | On user message |

## Commands / Jobs

_No chat-specific crons or background jobs are registered._

## Distinction from Jobs

| | Chat | Job |
|---|------|-----|
| Trigger | User message | Pipeline transition / manual dispatch |
| Interface | Conversational | Structured skill execution |
| Runs on | Device (if paired) or LiteLLM direct | Always a paired device |
| Outcome | Answer / discussion | Status change / code change |
| Captured | chat_logs (per query→reply turn, audit) | JobEvents (per stdout chunk) |
| Related to issue | Optional | Always |
