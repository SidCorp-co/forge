# Chat provider standardization + tool-calling

Refactor the **provider-chat** subsystem (`packages/core/src/chat/`) from a built-but-unconsumed
surface into a complete, standardized, tool-calling assistant engine — the non-agentic external
channel (distinct from agent-chat on runners). Status: **proposal** (not implemented). Tracking: ISS-604.
First consumer: Rocket.Chat bot Lane A (ISS-602).

## Why

Provider-chat is clean but **dead**: `/api/chat` + `/api/chat/sessions` are mounted (flag `chatProvider`,
ON) yet **no client and no internal caller** drive `runChatTurn` / `resolveForProject`. Forge's real
"chat" UI uses the **agent-sessions + runner** path (`agent:start`), not this. So we refactor freely —
no backward-compat.

**Two chat stacks stay deliberately separate:**

| | provider-chat (this) | agent-chat |
|---|---|---|
| Engine | LLM provider (OpenAI-compat via LiteLLM) | Claude Code on a runner |
| Can touch code/runner | ❌ | ✅ |
| Tools | curated Forge read tools (this proposal) | full Claude Code toolset |
| Store | `chat_sessions` | `agent_sessions` |
| Use | external channels (RC bot, widget, telegram) | in-app dev agent |

## Confirmed direction

| Axis | Decision |
|---|---|
| Wire standard | **OpenAI Chat Completions** (LiteLLM already speaks it) — the official contract |
| Primary provider | **litellm** (proxies to Claude/Gemini/…; no hand-written Anthropic adapter). Gemini adapter: keep optional or drop |
| Tool calling | **Build for real** per OpenAI `tools`/`tool_calls` — `tool_call`/`tool_result` events become live paths, not reserved |
| Tool surface | **Reuse the `forge_*` MCP tool catalog** via a thin adapter + curated allowlist (decision A) |
| Tool principal | **read-only, project-scoped** for MVP (decision B); write tools are a later phase |
| Role | non-agentic external assistant, separate from agent-chat |

## Tool-calling loop

```
messages[] + tools[] ─► provider.stream() ─► chunk | tool_call{id,name,args} | usage | done
                                                    │ (if tool_call)
run-turn loop:  ToolRegistry.resolve(name).handler(args, ctx)
                ─► append {role:'tool', tool_call_id, content}
                ─► re-invoke provider  (loop, guard maxToolIterations)
                done w/ no tool_call ─► final assistant text ─► SSE + persist
```

## Contract changes (OpenAI standard)

1. `types.ts` — `ChatMessage` gains `role:'tool'` + `tool_call_id`; assistant messages carry
   `tool_calls[]`. `ChatStreamRequest` gains `tools?`. `tool_call`/`tool_result` events kept (now emitted).
2. `litellm.ts` — send `tools` in the request body; parse streamed `delta.tool_calls` (reassemble
   fragments by `index`); emit `tool_call` events. (Today it only parses `delta.content`.)
3. `run-turn.ts` — add the execute-tool + re-invoke loop with `maxToolIterations` guard.
4. **`ToolRegistry`** (new, `chat/tools/registry.ts`) — mirror the provider registry pattern
   (register factory by id, resolve-per-project). Holds the curated tool set.

## MCP reuse adapter (the standardization win)

`forge_*` tools are already `ContextScopedMcpToolFactory = (ctx) => ({ name, description, inputSchema, handler })`
where `inputSchema` is JSON Schema from `zodToMcpSchema()`. Adapter is thin:

```
forgeXxxTool(ctx) → { name, description, inputSchema, handler }
   ─► OpenAI tool: { type:'function', function:{ name, description, parameters: inputSchema } }
   ─► on tool_call(name,args): tool.handler(args) → JSON → {role:'tool', tool_call_id, content}
```

- **Allowlist (read-only MVP):** `forge_issues` (list/get), `forge_projects_get`,
  `forge_project_pipeline_runs` / `forge_pipeline_runs_get`, `forge_knowledge` (search/get),
  `forge_comments` (list), `forge_metrics`. Curated const, not the whole catalog.
- **Principal:** build the MCP `ctx` scoped to the session's project (from the RC binding) with a
  read-only capability; the allowlist enforces read-only regardless of principal caps.

## Session / persist

Persist only `user` + **final** assistant text to `chat_sessions.messages` (clean transcript);
intra-turn tool round-trips are ephemeral + audited to `chat_logs`. `session.ts asMessages` unchanged.

## File touchpoints

| Concern | File |
|---|---|
| Contract + tool message shape | `chat/providers/types.ts` |
| OpenAI tool request + `delta.tool_calls` parse | `chat/providers/litellm.ts` |
| Tool loop + iteration guard | `chat/run-turn.ts` |
| Tool registry | `chat/tools/registry.ts` (new) |
| MCP→OpenAI tool adapter + allowlist | `chat/tools/mcp-adapter.ts` (new) |
| Read-only project-scoped ctx builder | `chat/tools/principal.ts` (new) |
| Gemini adapter | `chat/providers/gemini.ts` — keep optional or drop |

## Phasing

1. **P1 — standardized tool contract**: types + litellm `tools`/`tool_calls` + `ToolRegistry` +
   MCP adapter (read-only allowlist) + run-turn loop. Verifiable via `POST /api/chat` with a tool prompt.
2. **P2 — RC bot Lane A** (ISS-602) consumes it: `rcRoom → projectId → runChatTurn` with the tool set.
3. **P3 — extend**: write tools (with confirmation), widget/telegram consumers.

## Open decisions

1. Exact allowlist membership (start read-only set above; adjust from RC-bot usage).
2. Gemini adapter — keep as secondary or drop (litellm covers all upstreams).
3. Whether to expose `chat_provider_id` per project or hardwire litellm now (env + `app_config` stays).
