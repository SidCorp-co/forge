---
name: forge-test
description: "PROJECT-LOCAL OVERRIDE for jarvis-agents — no preview URL. QA testing is local (forge-code/forge-fix already ran build + unit tests). Skill is a no-op."
user_invocable: false
---

# Forge Test — jarvis-agents (no-op)

This project has no preview deployment URL — Coolify isn't used. Build + unit tests run inside `forge-code` and `forge-fix` already, so there's no remote QA target for this skill to hit.

## Workflow

If invoked:

1. Fetch issue.
2. Post comment via `forge_comments → create`:
   ```
   **QA skipped** — jarvis-agents has no preview deployment URL.
   Build + unit tests were executed inside forge-code / forge-fix.
   For staging QA, deploy `main` to a staging environment with the relevant
   `FEATURE_*=true` flags enabled, then validate manually.
   ```
3. Do NOT change status.

This skill should not normally be invoked in this project. If pipeline auto-routed an issue to `testing` status, manually move it back to `developed` so `forge-release` picks it up.
