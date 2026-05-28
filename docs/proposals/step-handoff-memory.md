# Step Handoff Memory (phương án Y)

## Cốt lõi
Agent tự ghi handoff TRƯỚC khi emit `DONE`, server verify bằng DB row. **1 dispatch, 1 process, không phá state machine.**

## Flow
```
prompt = job goal
       + ## Prior handoffs (inject từ memory, bỏ raw desc/plan tương ứng)
       + work body
       + ## Termination protocol (schema + "DONE only after MCP write")

agent: work → forge_memory_write(payload) → DB row → emit DONE → process exit

/complete handler:
  exitCode=0 + policy.enabled →
    SELECT memory_sources WHERE runId=$, step=$, attempt=$
    ├─ row exists + endsWith DONE → done
    ├─ endsWith DONE + no row     → fail(handoff_not_written)
    ├─ endsWith HANDOFF_GIVE_UP   → fail(handoff_validation_failed)
    └─ không khớp marker          → tùy missingMarkerPolicy
```

## DB (1 migration)
```sql
-- 0056_memory_step_handoff.sql
ALTER TYPE memory_source ADD VALUE 'step_handoff';
ALTER TABLE memory_sources
  ADD payload jsonb, ADD scope jsonb,
  ADD attempt int DEFAULT 1, ADD ttl_at timestamptz;
CREATE INDEX idx_memory_scope_step ON memory_sources
  ((scope->>'run_id'), (scope->>'step'), attempt)
  WHERE source = 'step_handoff';
```
KHÔNG đụng `jobs` table.

## Code touch
| File | Việc |
|---|---|
| `core/src/memory/step-handoff-schema.ts` | NEW — Zod union per step + `renderHandoffSchemaPrompt(step)` + `renderTerminationBlock({step, scope})` |
| `core/src/mcp/tools/forge-memory.ts` | Thêm `forge_memory_write` + `forge_memory_get` (cùng pattern `_search` hiện có) |
| `core/src/pipeline/pipeline-config-schema.ts` | Thêm `policy.handoffs: { enabled, injectFromSteps, fallbackToRawIssueFieldIfMissing, requireHandoffWrite, missingMarkerPolicy }` |
| `core/src/prompt/user.ts` | (1) Query memory inject `## Prior handoffs`; (2) bỏ raw field khi handoff hit; (3) append `## Termination protocol` cuối prompt |
| `core/src/jobs/lifecycle-routes.ts:120-122` | Chèn verification: load policy + `findHandoffRow` + branching done/fail |
| `~/.claude/skills/forge-*/SKILL.md` | Thêm 1 đoạn "Follow ## Termination protocol strictly" |

**KHÔNG đụng**: Rust runner, claude-code adapter, dispatcher, jobs schema.

## Schema payload (Zod discriminated union)
6 step: `triage / plan / code / review / test / fix`. Mỗi step ~5 field bounded length/enum.

## Rollout
| Phase | Scope | Effort |
|---|---|---|
| 0 | DB migration + schema.ts + MCP tools + Zod tests | 1-2 ngày |
| 1a | Triage only trên `pipeline-config-test`. `missingMarkerPolicy='warn'` | 2 ngày |
| 1b | Plan: inject triage handoff vào plan prompt, bỏ raw desc | 1 ngày |
| 1c | Code/review/test/fix tuần tự | 3 ngày |
| 2 | Bật toàn Anhome, đo cache hit + handoff_not_written rate | 1 ngày |
| 3 | `missingMarkerPolicy='fail'` toàn cục | — |

## Cache safety
Termination block đặt **cuối user prompt** (sau work body). Không đẩy schema vào system prompt — schema khác giữa các step sẽ invalidate system cache toàn cục. Cuối user prompt → prefix cache (system + handoffs) không bị động.
