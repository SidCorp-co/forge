# Chat

Interactive conversational sessions with project agents — conversation, not pipeline execution.

## Overview

- Open a chat session with an agent inside a project; agent has project memory, skills, MCP tools.
- Free-form — not routed through the 14-status pipeline.
- Use for "what's the state of ISS-42?", brainstorming, exploration before creating an issue.

## Data Flow

```
  User opens chat in web UI
        │
        ▼
  New ChatSession created
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
  Each turn logged as ChatLog
```

### Input Sources

| Data | Source | Notes |
|------|--------|-------|
| User message | Web UI | Text input |
| Project context | `project.documentId` | Scopes memory, skills, devices |
| Session memory | Previous messages in session | Accumulates |

## Core Entities

### `ChatSession`

| Field | Description |
|-------|-------------|
| `documentId` | Canonical ID |
| `project` | Belongs to one project |
| `createdBy` | User who started it |
| `status` | `active` \| `ended` |
| `lastMessageAt` | For inactivity cleanup |

### `ChatLog`

| Field | Description |
|-------|-------------|
| `session` | Parent ChatSession |
| `role` | `user` \| `agent` \| `tool` |
| `content` | Message body |
| `toolCalls` | If the agent invoked tools |
| `ts` | Timestamp |

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
6. Each chunk logged as ChatLog

### End a session

1. Auto-ends after 1h inactivity, or user explicitly ends
2. `ChatSession.status = 'ended'`

## API Endpoints

| Method | Endpoint | Principal | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/chat/sessions` | user | Start |
| `POST` | `/api/chat` | user / agent via MCP | Send message, get response |
| `GET` | `/api/chat/sessions/:id/logs` | user | History |
| `DELETE` | `/api/chat/sessions/:id` | user | End |

## Cross-Module Touchpoints

| Direction | Module | What | When |
|-----------|--------|------|------|
| Read from | [memory-knowledge](../memory-knowledge/README.md) | Context retrieval | Every turn |
| Read from | [skills](../skills/README.md) | Available tool list (project-scoped) | At session start |
| Emits to | [memory-knowledge](../memory-knowledge/README.md) | Chat content for embedding | On session end |
| Receives from / emits to | [devices](../devices/README.md) | Runs `claude` in chat mode (if device-backed) | On user message |

## Commands / Jobs

| Command/Job | Description |
|-------------|-------------|
| `chat-session-ender` (cron 15m) | Auto-end sessions idle >1h |
| `chat-memory-digester` (cron hourly) | Extract salient content from ended sessions, embed for future retrieval |

## Distinction from Jobs

| | Chat | Job |
|---|------|-----|
| Trigger | User message | Pipeline transition / manual dispatch |
| Interface | Conversational | Structured skill execution |
| Runs on | Device (if paired) or LiteLLM direct | Always a paired device |
| Outcome | Answer / discussion | Status change / code change |
| Captured | ChatLogs (per message) | JobEvents (per stdout chunk) |
| Related to issue | Optional | Always |
