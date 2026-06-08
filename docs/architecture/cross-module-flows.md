# Cross-Module Flows

How modules chain for primary journeys. Module detail: [../modules/{module}/README.md](../modules/).

## Flow: Webhook issue → pipeline → release

Trigger: external system (GitHub, Sentry, custom) POSTs to `/api/webhooks/in/<project-slug>` (web origin). Route resolves project by **slug**, not id — see [`packages/core/src/webhooks/inbound-routes.ts`](../../packages/core/src/webhooks/inbound-routes.ts) (`POST /in/:slug`).

1. **[webhooks]** authenticates via project webhook secret, creates issue in status `open`.
   → [../modules/issues-pipeline/README.md](../modules/issues-pipeline/README.md)
2. **[issues-pipeline]** `issue:created` hook fires; if `autoTriage` enabled, enqueues a `forge-triage` job.
   → [../modules/agents-jobs/README.md](../modules/agents-jobs/README.md)
3. **[agents-jobs]** dispatcher picks an eligible runner, sends `job.assigned` over WebSocket to that device's room.
   → [../modules/devices/README.md](../modules/devices/README.md)
4. **[devices]** agent spawns `claude` CLI locally with the triage skill prompt.
   → [../modules/skills/README.md](../modules/skills/README.md)
5. **[agents-jobs]** device POSTs JobEvents in 500ms batches as Claude emits stdout / tool calls / diffs.
6. **[issues-pipeline]** on job `complete`, if triage checks pass, issue advances to `confirmed`; if `autoPlan` enabled, next job enqueued.
7. Loop the registry steps: triage → (clarify if needed) → plan → code → review → test (auto-walks tested → pass → staging → released) → release.
8. **[issues-pipeline]** on `released`, final status. Webhook-out fires if configured.

Cross-cutting:
- Each job creates `agent-session` → `audit-log` entries.
- Memory embeddings (issue description, job output) indexed to Postgres `pgvector` for retrieval.

## Flow: Pair a new device

Trigger: user clicks **Account → Devices → Add device** in web UI.

1. **[devices]** server generates pairing code (5-min TTL), returns to web UI.
2. User runs `forge-runner login --code F9-3K7T-92XA`, or pastes code into Tauri app.
3. **[devices]** device POSTs code + capabilities (`{ claudeCode.version, git.version, node.version }`) to `/api/devices/pair`.
4. Server verifies code, issues device token (argon2-hashed), returns it.
5. Device stores token in OS keychain (macOS / Windows / Linux Secret Service).
6. Device opens WebSocket with token; server authenticates and subscribes socket to its rooms.
7. Device card appears in web UI with status `online`.

Cross-cutting:
- `auth` module creates token record.
- WebSocket rooms updated for both device and user principals.

## Flow: Run a custom user-authored skill

Trigger: issue advances to a stage with a registered custom skill.

1. **[issues-pipeline]** transition enqueues job with the custom skill name.
2. **[skills]** resolver finds the skill in the project's skill registry (not built-in).
3. **[agents-jobs]** dispatcher routes job to an eligible runner.
4. **[devices]** agent runs `claude` with the custom skill (from project `.claude/skills/`).
5. JobEvents stream back; pipeline advances normally.

Cross-cutting:
- Skill sync is hash/report-based (no pinning column) via `GET /api/projects/:projectId/skill-sync-status` ([`devices/skills-routes.ts`](../../packages/core/src/devices/skills-routes.ts)).
- Skill install/update propagates via WebSocket `skill.updated` (and `skill.sync` to push a pull to targeted devices) — see [`ws/broadcast-subscribers.ts`](../../packages/core/src/ws/broadcast-subscribers.ts).

## Flow: Device revocation

Trigger: user clicks **Revoke** on a device card.

1. **[devices]** server marks device token `revoked` in DB.
2. Server closes the device's WebSocket.
3. In-flight jobs on that device's runners are cancelled; runners go `offline`.
4. On reconnect attempt, agent receives 401 and surfaces "Device revoked, please re-pair."

Cross-cutting:
- Affected runners swept to `offline`, broadcast to user rooms.
- Queued jobs for that device moved to `cancelled` with reason `device_revoked`.
