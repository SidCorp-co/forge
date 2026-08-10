# Failure classifier version history

`CLASSIFIER_VERSION` in `packages/core/src/pipeline/failure-classifier.ts` is
persisted on `jobs.classifier_version` so a re-classified historical row keeps
its original verdict — the sweeper reads `jobs.failure_kind`, it never re-runs
the classifier on archived rows. Bump the version on any pattern change.

- **v1** — initial release.
  - `permanent`: content-filter / 4xx invalid_request_error / auth /
    validation / quota_exceeded
  - `transient`: timeout / network errors / 5xx / 429 / runner stale
  - `unknown`: anything else (default; gets one cautious retry then the
    sweeper treats it as permanent)
- **v2** — ISS-197 split `permission` / `timeout` out of `permanent` /
  `transient`.
  - `permission`: 401/403, authentication_error, permission_error,
    permission_denied. Non-retryable like `permanent`.
  - `timeout`: timeout / ETIMEDOUT / heartbeat stale / no progress.
    Retryable like `transient`.
  - `retryAfter`: `Date | null` extracted from
    `meta.headers['retry-after']` (RFC 7231) for the retry engine to honour
    rate limits before scheduling.
- **v3** — ISS-450 (ISS-442 C4 / I4) taxonomy rebuild. The `unknown` class is
  ELIMINATED — every failure maps to exactly one of four kinds, each with its
  own retry policy (see `jobs/retry.ts`):
  - `code` — the work itself is wrong (old `permanent`: content filter,
    invalid_request, validation, billing/quota, unsupported type). Retrying
    burns spend without changing the outcome → no retry.
  - `infra` — the environment failed, not the work (old `permission` + old
    `transient`: auth/403, network, 5xx, rate limits, runner offline,
    preflight failures). Bounded round-robin retry.
  - `transient-cc` — Claude-CLI startup death (ISS-402 class: the session
    died with ≤3 messages and no tool use, e.g. the skill-registration
    "Unknown command" glitch). Same-device retries burn the whole budget
    against a wedged CLI install → immediate different-device failover.
  - `timeout` — no progress past threshold. Bounded retry.
  - The pattern→bucket fallthrough (`unknown`) now lands on `infra` with
    `meta.needsReview=true` so unclassified rows surface in the operator UI
    instead of hiding behind a fifth class.
- **v4** — ISS-479 explicit runner failureReason tokens. `forge-runner-core`
  now emits a bracketed token for previously-opaque abnormal exits (the old
  "Agent completed with errors" catch-all). These tokens are AUTHORITATIVE —
  checked before the cc-startup message-count heuristic — because the runner
  observed the actual exit:
  - `[MCP_INIT_FAILED]` / `[SIGNAL_KILLED]` → `infra` (environment / OOM /
    host, not the work).
  - `[NO_RESULT_CLEAN_EXIT]` / `[NO_RESULT_EXIT]` → `transient-cc` (the CLI
    exited before producing a result — startup-death class → immediate
    different-device failover).
  - `[RESULT_ERROR]` → falls through to the message patterns below so a real
    provider error in the detail still routes to `code`/`infra`.
- **v5** — ISS-596 usage/session limit → `transient-cc`. Claude CLI usage
  limits ("You've hit your session limit · resets …") and the runner's
  explicit `[USAGE_LIMIT]` token now classify as `transient-cc` (immediate
  cross-device failover) instead of falling through to `infra` (same-device
  round-robin). Same-device retries against a time-locked window exhaust the
  retry budget uselessly; the correct action is to rotate to a device whose
  account is not limited. Detection reuses `isUsageLimitError` from
  `runners/limit-detect.ts`. Checked after the explicit runner token (so
  `[MCP_INIT_FAILED]`/`[SIGNAL_KILLED]` still win) but before cc-startup.
- **v6** — ISS-808 structural preflight sub-variants → `code`. A
  `reconcile`/`verify_skill` job that fails preflight with `origin_remote:`,
  `work_tree:`, or `repo_path:` has a project that is not (and was never
  meant to be) a git checkout — no retry will fix that. These three
  sub-variants now win over the generic `preflight_failed` transient
  catch-all, which stays `infra` for genuinely fixable environment failures
  (`push_credentials:`, `hooks_path:`).
