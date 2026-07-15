# Schedules

Cron-driven automation for a project: fire either a Claude agent session (`kind: 'prompt'`) or a sandboxed Node.js script (`kind: 'script'`) on a recurring cadence — no manual trigger required.

## 1. Overview

- REST surface `/api/schedules` (`packages/core/src/schedules/routes.ts`) is **JWT-only** — every route runs `requireAuth()` + `assertEmailVerified()`, which accept a user session token (`verifyUserToken`), never a device token. Devices don't create or list schedules; they only receive the resulting agent session over `/ws` (see below).
- A pg-boss cron queue (`schedule.tick`, `* * * * *`, registered in `packages/core/src/schedules/runner.ts`) fires every minute and calls `runScheduleTickOnce()` (`routes.ts`), which atomically claims every `schedules` row whose `nextRunAt` is due and dispatches it. The atomic claim (conditional `UPDATE ... WHERE nextRunAt = <observed>`) means a redelivered tick or a second app instance skips rows another ticker already won — no duplicate dispatch.
- Every dispatch (tick or manual `POST /:id/run`) publishes a `schedule.run` WebSocket event to room `project:<projectId>` (`packages/core/src/ws/broadcast-subscribers.ts`, subscribing on `bus.on('scheduleRun', ...)`) — fired for **both** kinds. See [../../architecture/websocket.md](../../architecture/websocket.md) for the envelope shape and room model.
- A schedule is exactly one of two kinds, set at creation and immutable-by-convention thereafter (switching kind mid-life is allowed by the API but the plan/UX assumes a schedule "is" one kind): [`kind: 'prompt'`](#2-kindprompt) or [`kind: 'script'`](#3-kindscript-no-agentllm).

## 2. `kind: 'prompt'`

The pre-existing behavior (default when `kind` is omitted). The schedule's `prompt` (or a `templateKey`-built prompt — see the skill-improve / steward templates in `packages/core/src/schedules/messages/`) is delivered to a **desktop runner** over the same interactive rails as `POST /api/agent-sessions/start`:

- `dispatchScheduleRun()` (`packages/core/src/schedules/dispatch.ts`) resolves an available device (`resolveChatDevice`), opens a `system`-kind `agent_sessions` row (`createChatSessionRow`), and delivers the prompt via `dispatchChatTurn` — publishing `agent:start` to that device.
- This is a full Claude Code agent session: multi-turn, tool use, the works. It shows up in `/settings/sessions` indistinguishable from a user-initiated chat except for `metadata.source === 'schedule.run'` (+ `metadata.tick === true` for cron-driven runs, absent for manual `/run`).
- Run history is derived from `agent_sessions` (joined to `pipeline_runs`) filtered by `metadata->>'scheduleId'` — there is no separate history table for this kind.
- No device online → the tick skips quietly (`lastStatus` reflects it, next cron tick retries); a manual `/run` surfaces this synchronously as `409 SCHEDULE_DISPATCH_FAILED`.
- Cross-runner failover (`redispatchScheduleSessionOnFailover`, same file): if the loop-monitor detects a session that never attached to a device (`no_client_ack`), it is re-dispatched — with the exact same prompt — to a different online device, up to `MAX_SCHEDULE_FAILOVERS = 2` additional attempts. A session that *did* attach and then died (`heartbeat_timeout`) is never retried this way, since it may have already run side effects.

## 3. `kind: 'script'` (no agent, no LLM)

The schedule's `script` (a Node.js source string) runs directly inside `packages/core`, on the cron cadence, with **no device, no agent session, and no Claude/LLM call of any kind**:

- `dispatchScheduleRun()` branches to `dispatchScheduleScriptRun()` (`dispatch.ts`) before the desktop-runner device guard even applies.
- A `schedule_runs` row is inserted up front (`status: 'running'`), then `runScheduleScript()` (`packages/core/src/schedules/script/executor.ts`) executes the script and the row is updated with the final `status` / `output` / `error`.
- Run history for script-kind schedules comes from `schedule_runs`, not `agent_sessions` — `listScheduleRuns()` (`packages/core/src/schedules/service.ts`) branches on `schedule.kind` to pick the right table. `GET /api/schedules/:id/runs` returns the same shape either way.
- `ctx.notify()` calls made by the script are delivered as `type: 'schedule_report'` notifications (`emitNotification`, best-effort — a failed delivery doesn't flip a successful run to failed).
- Introduced in migration `0147_script_schedules.sql` (ISS-618) — fully additive; every pre-existing row defaults `kind='prompt'` and reads unchanged.

## 4. Sandbox execution model

The script never runs in the same process/thread as the request handler, and never gets a real Node.js environment:

- **Isolation:** `runScheduleScript()` spawns a dedicated `node:worker_threads` `Worker` per run (`executor.ts`), pointed at a leaf entry module `script/worker-entry.ts` that imports nothing from the rest of `core` — anything reachable from inside the sandbox is exactly what that one file attaches to the `vm` context, on purpose.
- **Execution:** inside the worker, the script body is wrapped as `(async () => { <script> })()` and run via Node's `vm.Script` / `vm.createContext` (NOT a subprocess, NOT a container) against a sandbox object exposing only `console` and `ctx` (§5).
- **Codegen lockdown:** the `vm` context is created with `codeGeneration: { strings: false, wasm: false }` — this blocks `eval()` and `new Function(<string>)` escape attempts from within the script, and blocks WASM compilation.
- **Timeout:** `SCRIPT_TIMEOUT_MS = 30_000` (30s). If the worker hasn't posted a result by then, the executor terminates it and resolves `{ status: 'failed', error: 'timeout' }`.
- **Output cap:** combined `ctx.log()`/`console.*` output is truncated at `MAX_OUTPUT_CHARS = 16_000` chars (16k), with a `…[truncated]` suffix — this is what's persisted to `schedule_runs.output`.
- **Failure modes always resolve** (never hang the caller): a worker `error` event, a timeout, or the worker exiting without ever posting a result message are all normalized to `{ status: 'failed', ... }`.

## 5. `ctx` API (exposed inside the sandbox)

The only capabilities a script can reach are the `ctx` object below (plus `console.log`/`warn`/`error`, all aliased to the same log sink):

| Member | Signature | Notes |
|---|---|---|
| `ctx.log(...args)` | `(...args: unknown[]) => void` | Appends to the run's output buffer (subject to the 16k cap, §4). Non-string args are `JSON.stringify`'d. |
| `ctx.params` | frozen object | The schedule's `params` JSONB column, deep-cloned via `JSON.parse(JSON.stringify(...))` and then `Object.freeze`'d recursively — read-only, no reference back to the real DB value. |
| `ctx.notify(payload)` | `({ title: string, body?: string, severity?: string }) => void` | Queues a notification delivered as `type: 'schedule_report'` after the run finishes (§3). Throws synchronously inside the sandbox if `title` is missing/empty. |
| `ctx.http.fetch(url, init?)` | `(url, init?) => Promise<Response>` | **https-only** — throws if the URL isn't `https:`. Hard 25s timeout (`HTTP_TIMEOUT_MS`) via `AbortController`. `init` is sanitized to only `{ method, headers, body }` before being passed to the real `fetch`. |

## 6. `/api/schedules` kind-validation rules

Enforced with `zod` `superRefine` at the API boundary (`routes.ts`) and re-checked against the persisted row on update (`service.ts`, since a patch that only touches `enabled` must never leave a row in an inconsistent state):

- **Create** (`POST /api/schedules`): if `kind === 'script'` (or omitted → defaults `'prompt'`):
  - `kind: 'script'` → `script` is **required**; `prompt` and `templateKey` must be **omitted**.
  - `kind: 'prompt'` (default) → `prompt` is **required** (unless a `templateKey` is set, which builds the prompt server-side).
- **Update** (`PUT /api/schedules/:id`): the request-level check only catches the patch setting `kind: 'script'` together with `prompt`, or `kind: 'prompt'` together with `script`, in the *same* patch. `updateSchedule()` additionally computes the row's *effective* kind/script/prompt (patch value falling back to the persisted value) and rejects a result that would leave `kind='script'` with no script, or `kind='prompt'` with no prompt — this is what prevents a schedule from silently becoming un-dispatchable.
- These rules are DB-adjacent but not DB-enforced: the `schedules` table itself allows `script` and `prompt` to both be NULL or both be set — the API layer is the only place this is guarded.

## 7. Source-location drift anchors

If this doc and the code disagree, the code wins — re-verify against these locations:

| Concern | File : symbol |
|---|---|
| `kind` enum + `schedules`/`schedule_runs` tables | `packages/core/src/db/schema.ts` — `scheduleKinds`, `schedules`, `scheduleRuns` |
| API validation (`kind`-conditional required/forbidden fields) | `packages/core/src/schedules/routes.ts` — `createSchema`/`updateSchema` `superRefine` |
| Cross-field consistency against the persisted row on update | `packages/core/src/schedules/service.ts` — `updateSchedule()` |
| Run-history table selection by kind | `packages/core/src/schedules/service.ts` — `listScheduleRuns()` |
| Dispatch branching (prompt vs script) | `packages/core/src/schedules/dispatch.ts` — `dispatchScheduleRun()`, `dispatchScheduleScriptRun()` |
| Cron ticker registration | `packages/core/src/schedules/runner.ts` — `registerScheduleTicker()` |
| Sandbox host process (worker spawn, timeout, output cap) | `packages/core/src/schedules/script/executor.ts` |
| Sandbox `vm` context + `ctx` API surface | `packages/core/src/schedules/script/worker-entry.ts` |
| Additive migration introducing `kind`/`script`/`schedule_runs` | `packages/core/drizzle/migrations/0147_script_schedules.sql` (ISS-618) |
| `schedule.run` WebSocket broadcast | `packages/core/src/ws/broadcast-subscribers.ts` — `bus.on('scheduleRun', ...)` |
