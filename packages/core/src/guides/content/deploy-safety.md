## Deploy safety

Deploys via `forge_coolify_deploy` are hard to reverse and affect a shared, externally-visible environment — treat every call with the same care as a production push.

### Before you deploy
- Confirm you're targeting the intended environment. An explicit integration/service scope is a hard filter — don't rely on defaults picking the right one, especially near a release, when it's easy to accidentally redeploy production mid-pipeline instead of a staging target.
- A production deploy outside the release stage's human-confirm gate is a red flag, not a shortcut — don't bypass it just because you're blocked.

### While it runs — poll in the foreground
A pipeline step is a single, one-shot turn: when it ends, the whole process group is killed, including anything you backgrounded. If you background the deploy-status poll and then end your turn, the job may report success or failure and you will never see it — the issue is left parked with no verification. Poll in the foreground so the turn blocks until you actually have the answer. If the wait would blow your time budget, hand off cleanly (comment + status) rather than backgrounding and exiting.

### After it lands
Verify liveness on the deployed environment before declaring success — a deploy that "succeeded" per the platform can still serve a broken app. On a failed deployment: report it, do not silently retry into a loop, and do not leave the issue in a state that implies success.