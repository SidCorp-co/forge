# Proposal: Pipeline prompt SoT + per-state config + session groups

- **Status:** Draft (pre-RFC)
- **Date:** 2026-05-21
- **Depends on:** v0.1.34 Wave 1 (preamble + issueSnapshot + sessionContext)
- **Related:** [`pipeline-wave-2.md`](./pipeline-wave-2.md) Epic 1 (Inspector envelope)

Goal: 1 nơi build prompt; mọi tham số dispatch (systemPrompt, model, tools, mcp, timeout, sessionGroup) đều xem + config được từ project settings; cho phép group nhiều state share Claude CLI session.

## Issues to fix

- [ ] **A1 — Bug**: `claudeCodeAdapter` không forward `systemPrompt` qua WS → runner rơi vào `FORGE_SYSTEM_PREAMBLE_CHAT` thay vì pipeline preamble. (`core/src/runners/adapters/claude-code.ts:43`)
- [ ] **A2 — Scatter**: prompt logic ở 6 chỗ (server + dev + Rust). Sửa typo trong rules phải ship Tauri release.
- [ ] **A3 — Invisibility**: pipeline params (systemPrompt, model, allowedTools, timeout, mcp) hardcode/scatter, operator không xem/edit từ UI.
- [ ] **A4 — Fixed session model**: `claudeSessionId: null` cố định → mỗi state là CLI session mới, không config được.
- [ ] **A5 — Rust hardcode preamble**: `FORGE_SYSTEM_PREAMBLE_CHAT/_PIPELINE` ở `agent.rs:21-33`.
- [ ] **A6 — `--resume` flag behavior**: UNDOCUMENTED whether `--model`/`--append-system-prompt`/`--allowed-tools` honored on resume. Codebase assumption ở `agent.rs:217` chưa verified.
- [ ] **A7 — Command injection risk**: `buildSetupPreamble` nội suy `repoUrl`/`branch` chưa sanitize. (`dev/src/hooks/use-agent-commands.ts:97-113`)
- [ ] **A8 — Truncation cứng byte**: cắt giữa code fence / list → agent hiểu nhầm. (`prompt-string.ts:95-98`)
- [ ] **A9 — Timeout cứng 30 phút Rust**: không tune được theo skill / project. (`spawn.rs:11`)
- [ ] **A10 — Silent JSONL drop**: non-parse line nuốt mất → debug khó. (`spawn.rs:460`)
- [ ] **A11 — Dead code**: `contextPrefix = ""` và ternary vô nghĩa. (`use-agent-commands.ts:156,187`)

Dropped (đã đánh giá lại):
- ~~Cross-runner risk~~ — M×N có chủ đích, solo case không gặp.
- ~~`--allowed-tools` per skill conflict resume~~ — chỉ 3 skill có hard whitelist; skill self-grant cho phần lớn.
- ~~`--model` lock on resume~~ — user accept.

## Solution

### B1. Prompt SoT (collapse 6 chỗ → 2 module)

- [ ] Tạo `core/src/prompt/system.ts` (kế thừa `chat-preamble.ts`)
- [ ] Tạo `core/src/prompt/user.ts` (kế thừa `prompt-string.ts`)
- [ ] Endpoint `POST /api/prompts/preview` → `{ systemPrompt, userPrompt, blocks, hash, resolvedFlags }`
- [ ] Chat path gọi endpoint thay vì dev-side `buildAgentChatIssuePrompt` / `buildTaskPrompt`
- [ ] Xóa `dev/src/lib/prompt-builders.ts`, `dev/src/pages/project/agent-chat/agentChatPrompts.ts`
- [ ] Xóa `FORGE_SYSTEM_PREAMBLE_*` ở Rust `agent.rs`; Rust trở thành plumbing thuần

### B2. Per-state config + visibility

Schema mới `projects.appConfig.pipeline.states[<state>]` (jsonb, no migration):

```jsonc
{
  "skillName":      "forge-code",
  "model":          "sonnet",
  "allowedTools":   null,                // null = skill self-grant; array = hard whitelist
  "permissionMode": "bypassPermissions",
  "timeoutSeconds": 3600,
  "mcpServers":     { /* merged with project default */ },
  "systemPrompt": {
    "mode":   "append",                  // "append" (default, cache-friendly) | "replace" (advanced)
    "extras": "Project-specific rules..."
  },
  "userPromptPolicy": {
    "includeFields":       ["description", "plan", "acceptanceCriteria"],
    "sessionContext":      { "depth": 10, "fields": [...] },
    "fieldCaps":           { "description": 8000, "plan": 16000, "acceptanceCriteria": 4000 },
    "truncationStrategy":  "paragraph-boundary"
  },
  "budget": { "perRunUsd": 2.0, "perMonthUsd": 100 }
}
```

- [ ] Zod schema + validate ở `forge_config.update`
- [ ] Mọi field default = current hardcoded value (backwards-compat)
- [ ] Orchestrator + dispatcher đọc per-state override khi build prompt
- [ ] Rust `agent.rs` nhận `timeoutSeconds` qua IPC, không hardcode
- [ ] `systemPrompt.mode`: `append` (default, giữ cache prefix) hoặc `replace` (advanced — operator quản lý toàn bộ; cảnh báo UI mất cache hit)
- [ ] **Không** cap server-side `fieldCaps` — operator tự chịu trách nhiệm; UI hiển thị warning khi cap > 32k chars

### B3. Session groups

- [ ] Schema `pipeline.sessionGroups: { [groupName]: state[] }` + `onResumeFail: "fresh"|"abort"`
- [ ] Default = mỗi state 1 group riêng (= behavior hiện tại)
- [ ] Preset buttons: "Fresh per state" / "Whole pipeline" / "Custom"
- [ ] **Runner pinning đã đơn giản** nhờ D1: `defaultDeviceId` absolute pin → state cùng group tự nhiên cùng runner; không cần pin riêng theo agent_session
- [ ] Orchestrator lookup prior session in group → pass `claudeSessionId`
- [ ] Dispatcher: `selectRunnerForJob` ưu tiên `defaultDeviceId` online, fall back freshest
- [ ] Runner Rust: xóa `is_resume` short-circuit, luôn pass full flags
- [ ] Detect CLI resume error → emit `agent:resume-failed` → re-enqueue per `onResumeFail`
- [ ] Index `agent_sessions(issueId, sessionGroup, status)` cho fast lookup
- [ ] **Empirical test `--resume` flag-override behavior** (block trước khi merge B3)
- [ ] Nếu CLI ignore `--append-system-prompt` on resume → fallback: pre-pend systemPrompt vào user prompt body

### B4. Inspector UI

- [ ] **Live view**: extend `GET /api/jobs/:id/prompt` (Wave 2 Epic 1.2) cover toàn bộ `resolvedFlags`
- [ ] **Preview view**: `POST /api/projects/:id/pipeline/preview { state, issueId?, overrides? }`
- [ ] Project Settings → Pipeline → State Editor: **raw JSON editor only** (power-user oriented, ~50% LOC saved vs form)
- [ ] Monaco editor với JSON schema validation inline
- [ ] Nút "Preview prompt for issue X" → diff cũ/mới side-by-side trước khi save

### B5. Safety cleanups

- [ ] **A7**: sanitize `repoUrl` (URL parse + scheme allow-list) và `branch` (regex `^[a-zA-Z0-9._/-]+$`) trước khi nội suy
- [ ] **A8**: truncation strategy theo paragraph boundary `\n\n`; thêm hint `[truncated at N chars — call forge_issues.get for full]`
- [ ] **A10**: log non-JSON stdout với prefix `[stdout-non-json]`
- [ ] **A11**: xóa `contextPrefix` dead code

## Roadmap

| PR | Scope | Deps | LOC |
|---|---|---|---|
| PR-1 | A1 bug fix + tests | — | ~30 |
| PR-2 | A7+A8+A10+A11 cleanups | — | ~80 |
| PR-3 | B1 prompt SoT + endpoint | PR-1 | ~400 |
| PR-4 | B2 schema + per-state override engine | PR-3 | ~300 |
| PR-5 | A6 empirical test `--resume` | — | manual |
| PR-6 | B3 sessionGroups + Rust strip is_resume + fallback | PR-4, PR-5 | ~280 |
| PR-7 | B4 UI Pipeline State Editor + Inspector + Preview | PR-4 | ~600 |

**Recommended order**: PR-1 ∥ PR-2 → PR-3 → PR-4 → PR-5 (manual, parallel) → PR-6 → PR-7.

## Decisions (resolved 2026-05-21)

- [x] **D1**: `defaultDeviceId` **pin tuyệt đối** — `selectRunnerForJob` ưu tiên defaultDeviceId nếu online, fall back freshest khi offline. Bỏ random tie-break.
- [x] **D2**: `systemPrompt.mode = "append" | "replace"` — default `append` (cache-friendly); `replace` advanced toggle với UI warning về cache miss.
- [x] **D3**: **Không** cap server-side `fieldCaps` — operator tự quản lý; UI hiển thị warning khi cap > 32k chars.
- [x] **D4**: Raw JSON editor only (Monaco + schema validation) — không form-per-field; tiết kiệm ~50% LOC UI.
- [x] **D5**: Preview endpoint **chạy thực** với issueSnapshot từ DB (không dry-run fixture) — agree.
