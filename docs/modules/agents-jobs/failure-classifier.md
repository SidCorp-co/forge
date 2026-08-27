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
- **v7** — ISS-823 splits diagnosis from policy. `classifyFailure` now
  returns a required `action` (`terminal` | `quarantine` | `failover` |
  `retry`) alongside the unchanged 4-value `kind`, and the retry engine
  (`jobs/retry.ts`) decides retryability from `action` ONLY — no call site
  re-derives it from a kind, a regex or a job type. `action` is persisted on
  `jobs.failure_action`; historical rows (`NULL`) fall back to
  `deriveActionFromKind(kind)`, which reproduces today's behaviour exactly
  (`code`→terminal, `transient-cc`→failover, `infra`/`timeout`→retry).
  `quarantine` is reserved for ISS-825 (deterministic box-broken detection) —
  no rule in this classifier emits it yet; it rides the `failover` rotation
  path in `retry.ts` in the meantime.

  **Spend-cap classifies `failover`, not `terminal` — a spec correction.**
  The org/account monthly spend-cap string (`"You've hit your org's monthly
  spend limit"`, no `resets <time>` clause — structurally distinct from the
  time-windowed usage-limit path) was assumed org-wide and therefore
  non-retryable. Real job data on this fleet disproved that: issue `42ce58b2`
  failed 3× with the exact string on device `d8caf576`, then succeeded on
  device `0629f109` on the very next attempt — the limit is per-account, and
  rotating off the exhausted box recovers it. Shipping `terminal` here would
  have turned a self-recovering failure into a hard park. The fix
  (`isSpendLimitError` in `runners/limit-detect.ts`) stamps the exhausted box
  with `usage_limit` + a `rateLimitedUntil` 6h out (`SPEND_LIMIT_COOLDOWN_MS`
  — the string carries no parseable reset and the real boundary is monthly,
  so 1h would re-probe an exhausted box 24×/day) and fails over to another
  device immediately, with memory: `runners/select.ts`'s
  `onlineCapableDeviceIds` is now health-gated by default (previously the
  only selection path that did NOT filter `rate_limited_until`, so the retry
  rotation could pin a device that selection would then refuse). `retry.ts` reads
  the health-gated set apart from the unfiltered set to tell "every online
  box is exhausted" from "every box is merely offline".

  Since 2026-08-12 neither case parks on entry (owner call). An all-limited
  fleet **defers to the rotation**: `nextRotation` reads the health-gated set,
  so it yields `target: null`, the clone enqueues unpinned, and dispatch — which
  excludes limited runners — lands it on whichever box frees first. A
  seconds-long provider throttle therefore self-heals instead of becoming a
  human intervention. The round budget (10 × 60s) still bounds the wait, and a
  give-up that happened with the whole fleet limited reports
  `all_devices_exhausted` rather than the generic `retry_rounds_exhausted`, so
  the wedge notification still names the cap.

  The pre-dispatch monthly-budget gate (`jobs/dispatcher.ts`) also stopped
  being a private terminal path: it now stamps `failureAction: 'terminal'`
  with the real `CLASSIFIER_VERSION` (was hardcoded `1`) and routes through
  `finalizeFailedJob`, so a budget-exhausted job parks its issue at `waiting`
  and closes the open `pipeline_run` instead of leaving both stranded. Every
  no-retry park now also emits the existing `pipeline_wedge` notification
  (`emitPipelineWedge`, deduped per job) so a terminal failure reaches the
  project owner instead of halting silently.

- **v8** — the three structural preflight sub-variants stop lying about their
  cause. `origin_remote:` / `work_tree:` / `repo_path:` were labelled `code`
  purely to reach `terminal`, because v7's `action` was still derived from
  `kind` for every rule. They are now `kind: 'infra'` with an explicit
  `action: 'terminal'` — the diagnosis names the runner's workspace, the policy
  still refuses to retry. Measured 2026-08-14: ubuntu1's `/home/forge/projects/anhome`
  was not a git repo and 8 jobs died on `work_tree`, each one filed against the
  repository. `classifyKind` may now return an `action`, and `classifyFailure`
  prefers it over `deriveActionFromKind`; the fallback is untouched, so
  historical rows (`failure_action IS NULL`) keep the verdict they were written
  with. Nothing else changes bucket.
