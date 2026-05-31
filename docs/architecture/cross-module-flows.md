# Cross-Module Flows

How modules chain together for primary user journeys. Canonical module detail lives in [../modules/{module}/README.md](../modules/).

## Flow: Webhook issue → pipeline → release

Trigger: external system (GitHub, Sentry, custom) POSTs to `/api/webhooks/in/<project-slug>` (web origin). The route resolves the project by **slug**, not id — see [`packages/core/src/webhooks/inbound-routes.ts`](../../packages/core/src/webhooks/inbound-routes.ts) (`POST /in/:slug`).

1. **[webhooks]** receives payload, authenticates via project webhook secret, creates an issue in status `open`.
   → See [../modules/issues-pipeline/README.md](../modules/issues-pipeline/README.md)
2. **[issues-pipeline]** lifecycle hook fires on `issue:created`. If the project's `autoTriage` is enabled, enqueues a `forge-triage` job.
   → See [../modules/agents-jobs/README.md](../modules/agents-jobs/README.md)
3. **[agents-jobs]** dispatcher picks an eligible runner for the project and sends `job.assigned` over WebSocket to that device's room.
   → See [../modules/devices/README.md](../modules/devices/README.md)
4. **[devices]** agent receives job, spawns `claude` CLI locally with the triage skill prompt.
   → See [../modules/skills/README.md](../modules/skills/README.md)
5. **[agents-jobs]** device POSTs JobEvents in 500ms batches as Claude emits stdout / tool calls / diffs.
6. **[issues-pipeline]** on job `complete`, if all triage checks pass, issue advances to `confirmed`. If `autoPlan` is enabled, next job enqueued.
7. Loop through the registry steps: triage → (clarify if needed) → plan → code → review → test (auto-walks tested → pass → staging → released) → release.
8. **[issues-pipeline]** on `released`, final status. Webhook-out fires if configured.

Cross-cutting:
- Every job creates `agent-session` → `audit-log` entries
- Memory embeddings (issue description, job output) indexed to Postgres `pgvector` for future retrieval

## Flow: Pair a new device

Trigger: user clicks **Account → Devices → Add device** in web UI.

1. **[devices]** server generates pairing code (5-min TTL), returns to web UI.
2. User runs `forged pair F9-3K7T-92XA` on their machine, or pastes code into Tauri app.
3. **[devices]** device POSTs code + capabilities (`{ claudeCode.version, git.version, node.version }`) to `/api/devices/pair`.
4. Server verifies code, issues device token (argon2-hashed), returns it.
5. Device stores token in OS keychain (macOS / Windows / Linux Secret Service).
6. Device opens WebSocket connection with token; server authenticates and subscribes socket to its rooms.
7. Device card appears in web UI with status `online`.

Cross-cutting:
- `auth` module creates token record
- WebSocket rooms updated for both device and user principals

## Flow: Run a custom user-authored skill

Trigger: user has registered a custom skill to a pipeline stage; issue advances to that stage.

1. **[issues-pipeline]** transition triggers job enqueue with the custom skill name.
2. **[skills]** resolver finds the skill in the project's skill registry (not built-in).
3. **[agents-jobs]** dispatcher routes job to an eligible runner for the project.
4. **[devices]** agent runs `claude` with the custom skill (loaded from project `.claude/skills/`).
5. JobEvents stream back; pipeline advances normally.

Cross-cutting:
- Skill version pinning tracked in `project.skillsSyncedAt`
- Skill install/update propagates via WebSocket `skills:updated`

## Flow: Device revocation

Trigger: user clicks **Revoke** on a device card.

1. **[devices]** server marks device token as `revoked` in DB.
2. Server closes the device's WebSocket.
3. In-flight jobs assigned to that device's runners are cancelled; the device's runners go `offline`.
4. The next time the agent tries to reconnect, it receives 401 and surfaces "Device revoked, please re-pair."

Cross-cutting:
- Affected runners are swept to `offline` and broadcast to user rooms
- Any queued jobs for that device are moved to `cancelled` with reason `device_revoked`
