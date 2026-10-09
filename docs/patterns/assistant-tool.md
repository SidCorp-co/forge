# Assistant tool

**Change kind:** Assistant tool
**Introduced by:** ISS-466

A tool the chat assistant's model may call in a turn, or an MCP tool an agent session reaches. The
REST API is the primary door and the `forge` CLI is built over it, so a tool is added only for what
an agent needs and neither covers (BC-21); a tool that re-wraps a route the CLI already reaches is
not added. A change takes this entry when it adds a tool, widens what one may do, or changes the
input a model sends it. It builds on [API route](api-route.md): a tool calls the same service and
read functions as the route, and [Core module](core-module.md) (Doors) for where it is registered.

## Reference

- `packages/core/src/assistant/tools/registry.ts` — `CHAT_TOOL_ALLOWLIST`, the curated set the chat model sees, and `provideChatTools` for tools of modules it may not import
- `packages/core/src/assistant/tools/forge-memory-note-tool.ts` — one tool: a `z.strictObject` input, `name`, `reach`, `route`, `grant`, a description the model reads, a handler that asks `requireCan` and calls the module's service
- `packages/core/src/memory/tool.ts` — a module's MCP door in its own **tool.ts**, imported only by the tool registries
- `packages/core/src/mcp/registry.ts` — `MCP_TOOLS`, keyed by `packages/contracts/src/mcp-tools.ts:MCP_TOOL_NAMES`
- `packages/core/src/mcp/chat-read-tools.ts` — `CHAT_READ_MODEL_TOOLS`, read-model tools composed into the chat toolset at boot
- `packages/core/src/lib/tool-call-guard.ts` — `toolCallRefusal`, the refusal both doors give a call its grant or reach does not cover
- `packages/core/src/lib/tool.ts` — the factory and context types every tool is built on
- `packages/core/contracts/forge-mcp.tools.json` — the published tool contract, regenerated with `pnpm --filter @forge/core contracts:generate`

## Test shape

- `packages/core/src/assistant/tools/await-reply-tool.test.ts` — a tool driven through its toolset's `execute` as the model calls it: a valid call takes effect, bad arguments are refused by name and change nothing, an unknown name is answered as unknown
- `packages/core/src/assistant/tools/forge-memory-note-tool.test.ts` — what the model is told: the description carries the instruction the tool depends on
- `packages/core/tests/integration/ba-suggest-base-e2e.test.ts` — tools run in a real turn's toolset on a throwaway Postgres, asserting the record a call writes and the refusal a wrong call answers

A new tool gets a vitest file beside it (`pnpm --filter @forge/core test`) that calls the toolset's
`execute` with the JSON a model would send and asserts the answer: the effect of a valid call, and
`isError` with the refusal's code for each wrong input it plants, the unknown key among them. A tool
that writes gets an `*-e2e.test.ts` under `packages/core/tests/integration/` asserting the row it
wrote and that a caller without the permission is refused. The direct tests of a tool change are
the tool's own test and the integration tests of the module it calls.

## Review checklist

1. Neither a REST route nor a CLI verb already serves what the tool does; the change says why an agent needs the tool.
2. The input is one `z.strictObject` whose fields carry descriptions; the tool declares `grant`, `reach` and `route`.
3. The handler calls the same service or read function as the route and re-implements no rule.
4. Permission is asked through `requireCan`/`can()` as the turn's principal, never assumed from the session.
5. The tool sits in its module's **tool.ts** (or **assistant/tools/** for an assistant-only one) and is registered only in the tool registries.
6. The description tells the model when to call it and when not to, in English, and names no internal file.
7. Wrong arguments are refused by name with the valid shape; nothing is written on a refusal.
8. `forge-mcp.tools.json` is regenerated in the same change where an MCP tool changed.
