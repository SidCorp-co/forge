/* Forge UI Kit — RichIssueData.jsx
   A real, complex issue (ISS-273) used to demonstrate how the Issue view
   renders long markdown, an agent-written plan, acceptance criteria, a full
   lifecycle comment thread with status badges + image attachments, and activity. */

const RICH_ISSUE = {
  id: 'ISS-273',
  title: 'Device-centric runner management (per-device path) + onboarding UX fixes',
  status: 'closed', stage: 'release', priority: 'High', category: 'web', complexity: 'L',
  branch: 'ISS-273-device-centric-runner-mgmt', mergeCommit: '9d00232f',
  created: 'May 30, 03:30', updated: 'May 30, 05:02', reopenCount: 0, cost: '$4.20',
  assignee: 'SK', members: ['SK', 'AR', 'MJ'], labels: ['web', 'onboarding'],

  description: `Web is currently project-centric; we need to surface **device-centric management** — each device assigns its own path per project (what the maintainer actually wants).

## Work items
1. **Per-device management page:** Settings → Devices → [a device] → list the projects this device is assigned to, **each row with an editable path (+ branch)** (typed absolute path — the browser can't browse the device FS). Assign a project and set its path in the same place. Uses \`POST/PATCH /:id/runners {repoPath,branch}\`. \`projects.repoPath\` prefilled as the default hint.
2. **DeviceStep wizard:** after ticking a device, show a path input + a copy-paste command \`forge-runner bind <slug> --path <dir>\` so terminal-first users keep up.
3. **Fix dead \`#quickstart\`** on /download — point at the landing section.
4. **Description is \`void\`-ed** on create — persist \`projects.description\` (clean break), or drop the field. Recommend adding the column.

Depends-on: issue A (endpoints + \`repoPath\` on the runners row).`,

  acceptance: [
    { text: 'Settings → Devices → device detail lists assigned projects; each has an editable path + branch saved via PATCH /:id/runners/:runnerId.', done: true },
    { text: 'Assign a new project to a device from the device page (POST /:id/runners) with a typed path; default prefilled from projects.repoPath.', done: true },
    { text: 'DeviceStep shows a path input + copyable `forge-runner bind <slug> --path <dir>`.', done: true },
    { text: 'The #quickstart link on /download is no longer dead.', done: true },
    { text: 'Project description is persisted on create (or the field is removed).', done: true },
    { text: 'Runner online/offline status displays correctly on the device page.', done: true },
  ],

  plan: `# Implementation plan — ISS-273

## Context / prerequisite check
- **Dependency issue A (ISS-271) is MERGED** (commit \`ada4a065\`). The runner row already carries \`repo_path\` + \`branch\`, and these endpoints exist:
  - \`POST /api/projects/:id/runners\` — body \`{ deviceId, repoPath?, branch?, capabilities? }\`.
  - \`PATCH /api/projects/:id/runners/:runnerId\` — body \`{ repoPath?, branch?, capabilities? }\`.
  - \`DELETE /api/projects/:id/runners/:runnerId\` (unbind).
- **\`projects.description\` column ALREADY EXISTS** — Item 4 needs **NO migration**, only wiring the create path.

## Item 1 — Device-centric management page
### 1.A Backend — owner-scoped endpoint
Add a user-authed mirror of \`/me/runners\`:
\`\`\`
GET /devices/:id/runners
  → { runnerId, projectId, slug, name, repoPath, branch,
      status, lastSeenAt, projectDefaultRepoPath, baseBranch }
\`\`\`
Filter \`eq(runners.deviceId, id)\` + \`eq(runners.type,'claude-code')\`, owner-checked (404/403).

### 1.B Web — feature API + hooks
- \`deviceApi.listRunners(deviceId)\` + \`useDeviceRunners(deviceId)\`.
- Widen \`useBindRunner\` body to accept \`repoPath\`/\`branch\`; add \`usePatchRunner()\`.

### 1.C Web — the device detail page
- New route \`app/settings/devices/[id]/page.tsx\` with a status pill, per-project rows (editable path + branch + Save), and an assign-project flow.

## Item 4 — Persist project description
- \`createProjectSchema\`: add \`description\`. Create handler: include it in \`.values({...})\`. Remove \`void description;\` in the modal.

## Build / verify
- core: \`pnpm test\`, \`pnpm typecheck\`, \`pnpm lint\`.
- web: \`pnpm typecheck\`, \`eslint\`.

## Risks / notes
- **No decomposition**: items 3 & 4 are tiny and item 4's migration risk evaporated — keep atomic, one branch, four scoped commits.
- Absolute paths are typed manually and unvalidated by the browser; a bad path only surfaces at runner bind time.`,

  comments: [
    { kind: 'triage', author: 'Triage agent', time: 'Apr 30 · 04:07', body:
`## Triage: Actionable

**Complexity:** Complex (L) — cross-package and multi-platform.
**Category:** web · **Priority:** high

**suggestDecompose: yes** — strong split signals:
- Multi-package: web UI + (item 4) core schema.
- High criterion count: 6 independently testable acceptance criteria.

**Dependency:** depends-on issue A. forge-plan should verify A's endpoints exist before planning items 1–2.

→ Moving to \`confirmed\`.` },

    { kind: 'plan', author: 'Plan agent', time: '04:12', body:
`## Plan written → \`approved\`

Two findings reshape the work:
1. **\`projects.description\` already exists** — Item 4 needs NO migration.
2. **One real backend gap**: ISS-271 only built the device-token discovery endpoint; the web has no owner-scoped way to list a device's runners. Plan adds \`GET /api/devices/:id/runners\`.

**Decompose decision: NO** (overriding triage). Items 3 & 4 are tiny — keeping atomic with four scoped sections in one branch.` },

    { kind: 'code', author: 'Code agent', time: '04:22', body:
`**forge-code complete** — branch \`ISS-273-device-centric-runner-mgmt\` (\`1ffcecd\`), pushed.

- **Item 1**: owner-scoped \`GET /api/devices/:id/runners\` (JWT-auth, ownership-checked) + 4 route tests. Web: \`useDeviceRunners\`, widened \`useBindRunner\`, new \`usePatchRunner\`, new device detail page.
- **Item 2**: DeviceStep path input + copyable \`forge-runner bind <slug> --path <dir>\`.
- **Item 3**: \`#quickstart\` → \`/#quickstart\`.
- **Item 4**: \`createProjectSchema\` + handler now persist \`description\`.

**Verification:** core build OK, \`devices/routes.test.ts\` 26/26, \`projects/routes.test.ts\` 51/51, web \`tsc --noEmit\` OK.` },

    { kind: 'changes', author: 'Review agent', time: '04:26', body:
`## Review: REQUEST CHANGES

Reviewed SHA \`1ffcecd\`. Core side is clean. One blocking defect:

### Blocker
**\`settings/devices/[id]/page.tsx\` — assign-project default prefill is silently dead.** \`GET /projects\` projects only \`{ id, slug, name, ownerId, role, apiKey, createdAt }\` — \`repoPath\` is **not** in the list payload, so \`selected.repoPath\` is always \`undefined\`.

Fix: fetch the selected project's detail (\`useProject(projectId)\`) to seed the default.

### Minor
1. \`available\` filters owner-only, but \`POST /:id/runners\` allows owner **or** project admin.
2. Empty-state flashes while the profile loads.` },

    { kind: 'fix', author: 'Fix agent', time: '04:29', body:
`**forge-fix complete** — \`d83c093\`, pushed.

- **Blocker resolved** — AssignProject now reads \`repoPath\` from \`useProject(projectId)\` detail; the default prefills.
- **Minor resolved** — \`available\` widened to owner OR admin; added \`if (!me.data) return null\` guard.

Set \`developed\` for re-review.` },

    { kind: 'approve', author: 'Review agent', time: '04:30', body:
`## Re-review: APPROVE

Reviewed SHA \`d83c093\`. All prior findings resolved — prefill seeds from detail, authz parity fixed, empty-state guarded. No new issues.

→ Advancing to \`deploying\`.` },

    { kind: 'qa', author: 'Test agent', time: '04:57', body:
`**QA Test Report** — local gate against \`d83c093\` (Postgres 17 + core API + web).

| # | Test Case | AC | Result |
|---|---|---|---|
| 1 | Device detail: editable path+branch saved via PATCH | #1 | PASS |
| 2 | Assign project from device page, path prefilled | #2 | PASS |
| 3 | DeviceStep path input + copyable bind command | #3 | PASS |
| 4 | /download #quickstart no longer dead | #4 | PASS |
| 5 | Project description persisted on create | #5 | PASS |
| 6 | Runner online/offline status displays | #6 | PASS |

## Evidence
![evidence-ac1-ac2-ac6-device-page.png](${EVIDENCE.ac1})
![evidence-ac1-ac2-assign-saved.png](${EVIDENCE.ac2})
![evidence-ac3-devicestep-bind-command.png](${EVIDENCE.ac3})
![evidence-ac4-quickstart-landing.png](${EVIDENCE.ac4})

**Summary:** 6/6 passed · **Verdict:** PASS` },

    { kind: 'released', author: 'Release agent', time: '05:02', body:
`## Released → \`closed\`

Merged \`ISS-273-device-centric-runner-mgmt\` (@ \`d83c093\`) into **main** via \`--no-ff\`.
- **Merge commit:** \`9d00232f\`
- **Post-merge sanity:** 77/77 core route tests pass on the merge commit.
- **Cleanup:** remote + local branch deleted.

All 6 ACs verified PASS by forge-test prior to merge. Closing.` },
  ],

  activity: [
    { type: 'status', from: 'released', to: 'closed', time: '05:02' },
    { type: 'comment', who: 'Release agent', time: '05:02' },
    { type: 'status', from: 'staging', to: 'released', time: '04:58' },
    { type: 'status', from: 'testing', to: 'pass', time: '04:58' },
    { type: 'attachment', name: 'evidence-ac1-ac2-ac6-device-page.png', size: '71 KB', time: '04:57' },
    { type: 'attachment', name: 'evidence-ac3-devicestep-bind-command.png', size: '79 KB', time: '04:57' },
    { type: 'dep', kind: 'relates', to: 'ISS-274', time: '04:34', reason: 'S5 adds skill-freshness to the device-centric page.' },
    { type: 'status', from: 'deploying', to: 'testing', time: '04:30' },
    { type: 'status', from: 'reopen', to: 'developed', time: '04:29' },
    { type: 'status', from: 'developed', to: 'reopen', time: '04:26', note: 'review requested changes' },
    { type: 'status', from: 'approved', to: 'developed', time: '04:23' },
    { type: 'status', from: 'confirmed', to: 'approved', time: '04:13' },
    { type: 'status', from: 'open', to: 'confirmed', time: '04:07' },
    { type: 'dep', kind: 'blocked by', to: 'ISS-271', time: '03:31', reason: 'needs repoPath on runners row + endpoints from A.' },
    { type: 'created', who: 'maintainer', time: '03:30' },
  ],

  deps: { blockedBy: [{ id: 'ISS-271', title: 'Runner endpoints + repoPath column', status: 'done' }], relates: [{ id: 'ISS-274', title: 'Skill-freshness on device page', status: 'queued' }] },
};

window.RICH_ISSUE = RICH_ISSUE;
