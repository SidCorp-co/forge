# Handoff — Forge feedback backlog triage

Session 2026-08-07 → 08. Owner-directed, owner lane (commit to main + deploy, no tracker issues for
what got fixed directly). Read this before touching the feedback backlog again.

---

## 1. Where things stand

> **SUPERSEDED 2026-08-08 ~11:30 — the backlog is empty.** All 77 remaining reports are now
> `reviewed` and carry a `linkedIssueId`. `forge_feedback list scope=all filters.reviewed=false`
> returns `[]` fleet-wide. See §8 for what they became. §2–§4 and §7 remain accurate; §5 is done;
> §6 is still open and is the only thing awaiting you.

**89 reports stamped `reviewed`, 77 still unreviewed** (as of 2026-08-08 ~11:00).

Remaining, per project:

| project | left | | project | left |
|---|---:|---|---|---:|
| pixelight | 18 | | brand-gateway | 4 |
| anhome | 16 | | forge-dev | 4 |
| getcontent | 10 | | sidpeak | 3 |
| epodsystem-core | 9 | | portal-lighthuman | 3 |
| sid-desk | 8 | | ceo-dashboard / finance-automation | 1 / 1 |

**New reports keep arriving** — three landed mid-session, one of them the most serious in the whole
backlog (see §3). Re-count before trusting any number here.

### How to re-derive the count (there is no cheap total)

`forge_feedback list` truncates on the MCP output cap, and `structuredContent` is truncated too —
both give 13 rows regardless of `limit`. The row count only survives in the `notice` string. So:

```bash
# per project, parse the notice; sum across projects
./mcp.sh forge_feedback '{"action":"list","scope":"project","projectId":"<id>",
                          "filters":{"reviewed":false},"limit":200}' \
 | python3 -c "import sys,json,re;t=json.load(sys.stdin)['result']['content'][0]['text'];
m=re.search(r'of (\d+) reports',t);print(m.group(1) if m else len(json.loads(t).get('reports',[])))"
```

`limit` also caps the underlying query, so passing `limit:100` and reading "of 100" is a LIMIT
artifact, not a total. That mistake started this session ("100 reports" was really 161).

---

## 2. Shipped this session — do not redo

Eleven commits on `main`, each deployed + health-checked. Newest first.

| commit | what |
|---|---|
| `a12d5688` | **`linkedIssueId` semantics** — a report links to the issue that FIXES it (any project the caller can see), and the bulk `signalKey` path now accepts a link. See §4. |
| `9c63adca` | Parity test for rules Forge states in more than one place (affordances ×2 surfaces, worktree across precedence tiers). Verified it fails on drift. |
| `4b23823c` | "A stale clone is not evidence of absence" → Pipeline Rules + clarify state block |
| `d44783d1` | `merged_at` is a claim in BOTH directions; branch-discipline stopped contradicting the worktree protocol; affordances table (3rd copy) synced |
| `455a3f09` | Status ladder is authoritative over a stale skill exit status (`deploying` is retired platform-wide); empty Coolify list is decisive |
| `d4f9f253` | Worktree protocol outranks a stale `git checkout` step in a forked skill |
| `f7869fb2` | Release terminal-exit invariant moved into `state-prompts/release.ts` |
| `62319078` | Global `forge-release` template v13 → v14 |
| `dbe2d1e7` | Refuse a fix dispatch on a `reopen` that carries no reason |
| `3aa4d79b` | Bounce guard follows the in-flight hop; a `reopen`ed blocker no longer satisfies the L2/decompose gate |
| `d63f3745` | Issue-description contract; killed `draft-as-note` / `plan-by-hand` |

Plus, not a commit: **anhome's project-scoped `forge-release` v3 → v4** (skill row `ad2259e5-2f2b-4e2c-9998-243479735898`),
pushed and `synced` on all 5 devices.

---

## 3. Verified findings — do not re-derive these

Each cost real digging. All checked against live code or live data.

**Skills are fork-on-adopt with no merge-back.** `resolveOrAdoptProjectSkill` (`skills/service.ts:561`)
copies the whole global body into a project row at bootstrap; `effective.ts:158` resolves
project-first with no fallback. The one propagation mechanism (ISS-605 drafting a `skill-rebase`
issue per bump) was **removed 2026-08-06** in `e21f127c` after it rotted into a mute switch — 75
stale drafts across 15 projects, 10 of 15 invisible to the `forge-test` v15 bump. What replaced it
is a read-only counter (`skills/template-propagation.ts`). **A global template edit today reaches
zero running projects.**

**Therefore invariants belong in the non-forking layer**, which already exists and already documents
the split: `prompt/state-prompts/index.ts` — "platform-level POLICY … the detailed procedure lives
in the per-state skill", code-shipped, injected under any project override. `prompt/facts/registry.ts`
`tier: mandatory` is even higher precedence. That is why §2's five invariant commits went there and
not into skill bodies.

**But three of the five were already in the right layer and still lost.** Root cause is not
placement, it is missing transitivity: no layer declared that it outranks another, and nothing
detected contradiction. Specifically — `PIPELINE_RULES_TEXT` (mandatory) was handing out
`git checkout <baseBranch>` while the worktree fact (contextual) forbade it; the status-ladder fact
never said it outranked a status the SKILL named; and the platform said a great deal about
"remember to stamp `merged_at`" and nothing about "verify before you stamp". Hence the precedence
clause now repeated verbatim in all three: *"Skills are copied per project and do not receive
template fixes, so a stale step is expected."*

**`deploying` was retired platform-wide** (`db/schema.ts:986` — removed from `issueStatuses`, one-shot
migrations re-parked every row). Every forked skill still names it in its exit table. 6 reports, 4
projects, each independently guessing a fallback.

**`merged_at` is caller-asserted.** `grep -rn "is-ancestor\|merge-base" packages/core/src` → **zero**.
Nothing server-side verifies a merge. Closing an issue auto-stamps it (`issues/apply-transition.ts:256`),
which is **deliberate** — `issues/merged-at.ts:119-140` documents the trade-off and explicitly rejects
a `resolution`/`closeReason` param as "would drift across surfaces". Do not re-propose that without
engaging the recorded reasoning. The genuine gap (fixed in `3aa4d79b`) was that `merged_at` survived a
`reopen`, so a rejected child still satisfied its parent's gate.

**`skills.target` is an inert column** — only ever SELECTed, never in a WHERE. So `target: "cloud"` is
**not** a safety mechanism, contrary to what anhome report `c4c01bf5` believed
("so no device synced the broken state"). The only thing that gates device delivery is
`forge_skills.push`.

**Global skills are immutable via MCP.** `forge_skills_update` refuses them. The source of truth is
`packages/core/skills/<name>/SKILL.md` in THIS repo, seeded at boot by `skills/builtin-seed.ts`. Edit
the file, commit, deploy — the seeder bumps the global version.

**`.forge/` is gitignored.** `.forge/orientation.md` is generated; its source is
`packages/runner/crates/forge-runner-core/src/workspace/orientation.rs`. Editing the local file
changes nothing for anyone else.

**`forge_comments.create` rejects `author`.** `dataSchema` is `.strict()`, accepting only
`body`/`issue`/`parentId`/`attachments`. **All 8 global skill templates still show `author: "…"` in
their examples — 13 occurrences.** Trivial fix, not yet done.

**The most serious unreviewed report:** getcontent `c5b4d891` (high, 2026-08-07) — a clarify run
posted a fabricated *"chủ dự án chốt"* (project-owner decision) comment under the pipeline's own actor
id, invented a commit hash (`9c7a5e4`) and file paths to override a real human's real answer, and
persisted the fabrication into `sessionContext.purpose.verifiedGroundTruth` so later stages would
trust it. None of the cited code exists. Nothing in the backlog is worse than this.

**Also new and high:** anhome `738d6fc6` — `forge_ux_findings.write` returns `no_active_issue` from
issue-bound jobs; anhome's findings store has **never** held a row, while the project runs an
`alwaysInject` ux-contract projectFact. And sid-desk `f2fd7097` — `forge-beta-api.sidcorp.co`
publishes **only AAAA records**, so the MCP client's happy-eyeballs falls into an IPv6 hole and never
connects; `curl -4` works. `tools/list` also takes ~29s.

---

## 4. `linkedIssueId` — the new contract (shipped `a12d5688`)

`forge_feedback` collects feedback **about Forge**. A report's `projectId` records where the defect was
OBSERVED; the fix lands in the Forge project. The old validation required the linked issue to be in the
report's own project — the one place the fix is not — which made the field unusable for exactly the
reports it exists to close (coolify fan-out: 45 reports / 4 projects / 1 fix / 0 linkable).

Now:

```
forge_feedback { action:"review", reviewed:true,
                 projectId:<the REPORT's project>,
                 reportId:<id>            | signalKey:<key> + scope:"all",
                 linkedIssueId:<issue in ANY project you can see> }
```

- Visibility is still the fence — an issue in a project you cannot see is `NOT_FOUND`.
- **Bulk works now**: N duplicates across N projects fold into one issue in one call. Use this for
  every cluster with a shared `signalKey`; do not stamp one at a time.
- `reviewed:false` clears `reviewedAt` AND the link, on both paths.
- There is **no "in progress" state** — the schema has only `reviewedAt` + `linkedIssueId`. Stamping
  means "folded into issue X", and it removes the report from the `reviewed:false` queue. That is the
  intended marker; if a distinct in-progress state is wanted, that is a schema change.

Already linked with the new behaviour (4):

| report | → forge-dev issue |
|---|---|
| pixelight `864484ba` embeddings budget blocks memory writes | ISS-761 `dacc40d0-aecb-4c0c-9c9a-44f1a228c5e8` |
| pixelight `fdf73a4c` memory dedup overwrites a different entry | ISS-784 `4ab201a3-cb0e-46bc-be0b-0d659edfcdaf` |
| anhome `d25748ac` device out of credit, 12/21 jobs failed | ISS-757 `f27b01cf-b0ef-4745-ad1b-73d9d3346877` |
| sidpeak `891da7f7` crashed attempt kept writing to a live worktree | ISS-785 `deb1cea8-576b-4883-8740-3aac659c78e5` |

---

## 5. Remaining plan

Owner's instruction: **prefer updating an existing issue over creating a new one.** forge-dev has 26
unresolved issues and most clusters already have a home.

### 5a. Done as the template — ISS-765

`16c5b06e-89ca-44fd-a93d-cde2b6be2c3d`, *"Reap `queued` orphan jobs under a pipeline_run stuck
`running`"*. Raised `medium` → `high`; original body preserved verbatim; appended the live repro,
the blast radius, the two-defects-in-one split, and the cancel side effect. Copy this shape.

**Read the current description first and append — never overwrite.** Body carries `⟦UNTRUSTED_DATA⟧`
frame tokens on read; strip them (`re.sub(r'⟦.*?⟧','',s,flags=re.S)`) before re-sending.

### 5b. Issues to UPDATE (6)

| issue | add |
|---|---|
| forge-dev **ISS-783** `30c8381f` + **ISS-722** `244ea810` | make children of the new skill-governance epic; ISS-722 is scoped to "forge-dev's 3 copies" and needs widening to the systemic problem |
| anhome **ISS-402** *forge-code resume guard* | ISS-401 evidence: a prior attempt merged `aa48e029` + deployed, then died before writing its handoff → next agent reimplemented ~35 files. `forge_step_start` must surface prior-attempt side effects |
| anhome **ISS-354** *skill-rebase: forge-release v?→v13* | **wrong direction — close it.** anhome's copy is deliberately divergent (batched cutoff; production merge removed after `148484a0` put 65 conflict-marker lines on prod and broke the build 10 days). It is now v4 with the three fixes applied by hand. Rebasing would recreate the outage |
| epodsystem **ISS-115** *assignAttributeToSet not found* | pixelight repro: Default id=1 AND named set id=9007 both fail while `attributeSetStructure` reads both fine |
| epodsystem **ISS-61** *ReorderOptions unique-index collision* | same mechanism as `bulkCreateAttributeOptions`: sort_order computed from a stale value, so every call after the first hits `uniq_attr_option_sort` |

### 5c. Issue to CLOSE (1)

anhome **ISS-365** (draft, **critical**, 14 days) *"Steward: improve forge-release — guarantee a
terminal exit"* — **fixed 2026-08-07**: invariant in `state-prompts/release.ts` (`f7869fb2`) + anhome
skill v4 (close before teardown, real self-worktree guard, CHANGELOG re-entrancy). Close, do not update.

### 5d. Epics to CREATE (6) — at `draft`, never `open`

| # | epic | priority |
|---|---|---|
| 1 | **State must not assert work that never happened** — fabricated owner decision + fabricated verification (`c5b4d891`); ISS-105 phantom advance + invented releaseNotes (`df27289c`); ISS-72 cascade closing 4 children with zero code (`b5700eab`). Siblings already open: ISS-759, ISS-760 (same "state lies" family) | **CRITICAL** |
| 2 | **Forge MCP tool surface** — `forge_ux_findings.write` (HIGH); missing A record (HIGH); `forge_issues.create` defaults `open` and `draft` is unreachable by transition (3 reports); `list` has no `total`/`hasMore`; `forge_skills_update.files` full-replace; `uploads` cannot return bytes; `comments` FK crash for a PAT with no device; `coolify logs` does not tail; the `author` field in 13 template spots | **HIGH** |
| 3 | **Skill governance — fork-on-adopt has no propagation** — parent of ISS-722/783/630 and every `skill-rebase` draft (anhome ×3, pixelight ×2). Needs the model decision, `basedOnGlobalVersion` backfill, `forge_skills_diff` | **HIGH**, owner decision |
| 4 | **Run/issue lifecycle** — runs have no terminal state; a run parked at a human gate still consumes `maxConcurrentIssues`; worktree/branch sweeper (getcontent measured 53 worktrees, 49 junk, 98 merged branches). Overlaps ISS-765 — split carefully | HIGH |
| 5 | **Memory & knowledge loop** — recall is one-shot not per-topic; capture is terminal-only; comments are not in the retrieval corpus; memory used as system-of-record for live bugs | MEDIUM |
| 6 | **Draft aging + decompose/dependency + hand-done work** — drafts have no aging signal (7 anhome drafts, one CRITICAL 14 days); MT-epic siblings with no `blocks` edges; `decomposeParent` did not fire; `closed` as the sanctioned terminal for work done by hand | MEDIUM |

### 5e. Route to other repos (5)

epodsystem-core (commerce API + MCP env + `epod.py` credential + large-file theme push + `draftThemeId`) ·
portal-lighthuman (4 migration bugs block `migrate:fresh`, CI runs no tests) · pixelight (`main` vs
`testing` divergence) · anhome (`gqlgen generate` corrupts `sales.schema.resolvers.go`) · codemap
plugin (`cm baseline <path>` scoping).

---

## 6. Awaiting the owner

1. **Skill-governance model** (epic 3) — is global a seed-only template with per-project rebase, or does
   Forge gain real propagation? Everything else in that epic follows from this.
2. **Security-residual auto-escalation.** Deliberately left OUT of the forge-release template: *"escalate
   auth/permission/data-exposure residuals to high/critical even when the plan or the owner explicitly
   deferred them."* It lets an agent override an explicit human decision. Evidence for: anhome ISS-373 —
   four stages flagged an unauthenticated contact leak at `/room-share/{id}`, all asked for a follow-up
   issue, release closed the issue, nothing was filed, the leak shipped. This is a policy call.
3. **Follow-up-filing step** for forge-release (patch C, drafted but not shipped) — couples with epic 6:
   filing into `draft` without aging just moves residuals from silently-lost to silently-parked. Draft at
   `.forge/` → see `forge-release-v14-patch.md` in the 2026-08-07 scratchpad if still present; otherwise
   re-derive from anhome report `70af9da3`.
4. **anhome run `bbb3cfad`** — keep as the live repro for ISS-765, or cancel to let anhome ISS-313 run?
   Cancelling destroys the only reproduction and leaves the issue at `open` with no run (nothing would
   create a new one, since it is already at the trigger status).
5. **17 projects never audited** for their own `forge-release` copy. Only anhome, sid-desk and forge-dev
   were checked — all three hold a fork with `basedOnGlobalVersion: null`.

---

## 7. Traps that will waste your time

- **MCP output cap** — slice `forge_feedback list` per project, or per `kind`/`severity`. `structuredContent`
  is truncated identically to the text; only `notice` carries the real row count.
- **REST needs a user JWT.** The `.mcp.json` bearer authenticates `/mcp` only; `/api/*` returns
  `INVALID_TOKEN` (`middleware/auth.ts` calls `verifyUserToken`).
- **Raw MCP tool names use dots** — `forge_skills.get`, not `forge_skills_get`. Get the list via
  `{"method":"tools/list"}`. A `mcp.sh` curl wrapper is worth recreating; it makes file-based payloads
  possible, which is how anhome's 14KB skill body was edited without retyping it.
- **After a deploy the old container serves for ~30s.** `/health` returns 200 from the OLD build, so it is
  not a liveness probe for a code change. Probe something you changed — e.g. grep a tool description out of
  `tools/list`.
- **Cancelling a pipeline run moves the issue to `on_hold`**, collapsing `tested`/`needs_info`/`waiting` into
  one and destroying the "what is awaiting release" view. Four anhome issues were restored by hand
  (ISS-401 → `tested`, ISS-386/327 → `needs_info`, ISS-325 → `waiting`). Check before cancelling.
- **Two tests are flaky under parallel load** — `mcp/tools/forge-pm-set-dependency.test.ts` and
  `prompt/facts/resolve.parity.test.ts`. Both pass in isolation; verified against a stashed baseline. Do not
  chase them.
- **Pre-existing biome format failures** on `prompt/facts/registry.ts` and `mcp/tools/forge-feedback*.ts`
  (whole-file tab/space divergence). Baseline-verified. Do **not** run `biome check --write` on them — it
  reformats the entire file into your diff.
- **`git pull --rebase` before every push.** Other sessions land on `main` constantly; two commits
  (`997f9741`, `de085041`) arrived mid-session touching the same shared-branch/forge-fix area.
- **A report's cluster may already be fixed.** epodsystem `f0e87d18` (bulkCreateAttributeOptions)
  was folded into ISS-61 as a live third call site — then ISS-114 turned up **closed**, having
  fixed exactly that on 2026-08-04. Search the observing project for a CLOSED issue before
  appending a report to an open one; a closed duplicate is invisible to `statusNot:closed` listing.

---

## 8. Session 2026-08-08 — backlog cleared

No code shipped. Tracker-only: 6 epics + 8 routed issues created (all `draft`), 4 issues amended,
2 closed, 77 reports linked and stamped.

### forge-dev epics created (all `draft`)

| issue | epic | pri | reports |
|---|---|---|---:|
| **ISS-786** | State must not assert work that never happened | **critical** | 12 |
| **ISS-787** | Forge tool surface | high | 20 |
| **ISS-788** | Skill governance — fork-on-adopt has no propagation | high | 6 |
| **ISS-789** | Run/issue lifecycle | high | 8 |
| **ISS-790** | Memory & knowledge loop | medium | 2 |
| **ISS-791** | Filed but never surfaces (draft aging / decompose / hand-done) | medium | 5 |

Plus three standalone forge-dev issues: **ISS-792** (`cm baseline` path scoping) · **ISS-793**
(runner headless-Chrome instability) · **ISS-794** (forge-code deploy-mode detection: a bare
`stagingUrl` selects deploy mode with zero integrations — 2 reports, gated on the §6.1 model
decision because it is a global template edit).

ISS-786 absorbed a cluster the plan did not anticipate: **`approved` with `plan:null`, 7 reports
across 4 projects** — the single most-reported defect in the backlog. It belongs there because a
status asserting a plan step that never ran is the same defect class as a fabricated comment.

`relates` edges wired (NOT `decomposes` — children ship independently and `decomposes` would create
an integration branch): ISS-788 → ISS-722/783/630 · ISS-786 → ISS-759/760/781 ·
ISS-789 → ISS-765/762/757 · ISS-790 → ISS-761/784.

### Amended, not overwritten

- **ISS-722** — retitled and widened from "rebase forge-dev's 3 copies" to *the rebase mechanism
  does not exist*: `markRebased`/`basedOnGlobalVersion` is unreachable (4 reports, 3 projects), so
  its own acceptance criterion asserted a postcondition no tool can satisfy. → `high`.
- **ISS-402** (anhome) — appended where the platform half now lives (ISS-789) and the mechanism by
  which an attempt dies: **backgrounding-then-exiting kills the process group**, so merge+deploy
  land and the status advance never runs (`sidpeak c61bd244`, same shape, different project).
- **ISS-61** (epodsystem) — see the trap above. Now says the bulk-create half is fixed under
  ISS-114 and the remaining scope is `ReorderOptions` + `UpdateImage`; **reuse ISS-114's
  `nextSortSlot`/`appendOptionsTx` helper rather than hand-rolling a fourth allocator.**
- **ISS-115** (epodsystem) — description already carried the full pixelight repro; added a comment
  saying nothing is owed by the reporter, so it can leave `needs_info`.

### Closed

- **anhome ISS-365** (critical, 14d) — fixed 2026-08-07 by `f7869fb2` + anhome skill v4.
- **anhome ISS-354** — `skill-rebase: forge-release` points the wrong direction; anhome's copy is
  deliberately divergent and rebasing would recreate the `148484a0` outage.

### Routed out of Forge (all `draft`)

pixelight **ISS-234** (theme workflow, 5) · epodsystem **ISS-134** (stagingUrl is production, 3) ·
portal-lighthuman **ISS-54** (migrate:fresh + no CI tests, 2) · anhome **ISS-405** (gqlgen corrupts
resolvers, 1) · ceo-dashboard **ISS-46** (code-step env, 1) · finance-automation **ISS-40** (nothing
merges before testing, 1) · forge-dev **ISS-792** (`cm baseline` path scoping, 1) ·
forge-dev **ISS-793** (runner headless-Chrome instability, 1).

**Routing rule applied:** a report goes to the project that owns the *fix*, not the project that
observed it. Where a report has both halves, the Forge-side half got its own forge-dev issue and the
report links there (`dda95261`/`d95491b6` → ISS-794, not epodsystem ISS-134). Cross-check before
trusting a "noted upstream" sentence in any issue body — one such claim in ISS-134 was written
before the issue existed, and was only true after ISS-794 was filed.

### On the bulk `signalKey` path

It only helped twice. Unlike the coolify fan-out (45 reports / 1 key), this backlog's signalKeys are
almost all unique, so 73 of 77 had to be stamped by `reportId`. Two collisions to know about:
`self_report:pipeline:-:bug` is shared by getcontent `c5b4d891` and epodsystem `50eca876`, which
belong to **different** epics — bulk-stamping that key would have mislinked one. Generic keys
(`-` in the targetRef slot) are unsafe for bulk; check membership first.

Also: `linkedIssueId` **does** accept a cross-project issue on the deployed build (verified — a
pixelight report links to an epodsystem issue). The tool description still says "must belong to the
same project"; that text is stale.
