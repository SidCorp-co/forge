# Chat first: it answers what needs you and drives the page beside it

**Removed when:** ISS-495 closes, that is when the seven build lanes at the end of this file have
landed. What holds after that is the code, the contracts and the revised Chat turn, Feedback triage,
Feedback lifecycle, Requirement lifecycle, Issue lifecycle and Personal data designs.

Requirement REQ-41 r1, BC-1..22. Delivery issue ISS-495. Owner rulings, 2026-10-09: previews and
recordings open only for signed-in project members; a reproduce preview uses demo data where the
project's preview setting names it, else its dev environment, never production (REQ-39 BC-13); the
preview domain is iosbenchmarks.com (wildcard on Cloudflare, SSL Flexible); the whole requirement is
designed at once and split into lanes, not phased.

The shared contracts are landed in `packages/contracts/src`: `ui-list-filters.ts`, the REQ-41 block
of `ui-actions.ts`, `needs-you-decisions.ts`, `reply-check.ts`, the REQ-41 block of `preview.ts`, and
`reproduce.ts`. Each shape a lane must register with its executor (a UI action, a refusal code, a
route, a setting) is landed beside the registry, not in it, so the model is never offered an action
and no route is named that nothing answers yet. The lane that builds the executor moves it in.

## What was wrong on 2026-10-09

- The assistant's answer to "what is waiting on me" was held whole by the reply check, so the
  person saw only the held notice.
- Needs you listed 29 requirements as waiting on the owner. About 6 needed a person. The rest were
  13 "Update to the approved design" (a re-pin that changes no criterion), 11 old drafts waiting on
  "propose r1", 7 crash-park questions ("3 run sessions ended on this issue") and 3 design-only cut
  questions. The issues area added 37 draft issues waiting on "take on or drop".
- Chat could navigate and filter Issues only. Requirements, Feedback and Workflows were unreachable
  from chat, no list filtered by who an item waits on, and an idea or a bug was described in prose.

## Needs me (BC-1, BC-2)

**One read.** `development/needs-you.ts:readNeedsYou` already composes every area's rows under the
one predicate `standing.ts:needsViewer`, and the home and `/attention` draw it. The needs-me read is
that read's `asks` rows, split into decisions and the rest:
`GET /api/projects/:id/needs-you/decisions` answers `needsYouDecisionsSchema`. The assistant reads
it through one new tool, `forge_needs_you`, built on the same function. There is no second path.

**A decision** carries its group, its question, a recommended answer with who recommended it, and
1–8 buttons. Each button is a `DECISION_ACTS` entry: the route the record's own page calls, filled by
core, posted by the browser as the person who presses it, under the permission that route checks
(BC-9). A decision without a recommendation must say why (`noRecommendation`); the schema refuses
one that does neither. `opens` is null for a question a run asked on no record.

| Row source | Group | Question | Recommended | Buttons |
|---|---|---|---|---|
| Open question on an issue, requirement, feedback item, or none (`agent_questions`) | answer | the step's prompt | choice step: `recommendedOptionId`, by the asker; free text: the step's new `recommended`, else none | `question.answer` per option, or one free-text answer |
| Proposed revision, agreement or acceptance where the project setting asks | approve, accept | Forge's sentence naming the revision and its change summary | the checklist's own verdict, by rule | `revision.accept` / `revision.return`, `requirement.agree`, `requirement.accept` |
| Release approval waiting on the viewer | approve | the release and what it carries | by rule: approve when every carried criterion passes | `release.decide` |
| Feedback answer to confirm, or a fix to verify | verify | the answer or what shipped | by rule from the latest verdict | `feedback.verify` / `feedback.reopen` |
| A draft the assistant proposed merging or dropping (BC-12) | merge_or_drop | the assistant's question | the assistant's | `question.answer` per option |

**Not decisions**, counted by reason so the reply names what it left out (`notDecisions`):
`own_work` (propose or revise your own draft), `work` (criteria to check, health markers to settle),
`awaiting_proposal` (a draft the assistant has not proposed on yet).

**A free-text question gets a recommended answer.** `FreeTextStep` gains `recommended?: string`. A
question a run asks a person through the box's door (`POST /api/devices/me/questions`, which
`forge-runner question ask --needs … --recommend …` sends) without one is refused
`QUESTION_RECOMMENDATION_REQUIRED`, naming the field. This is kernel input, so it is refused, never
filled in. A park question minted from a transition's `needs` or a comment's question intent is not
yet held to it: its writer is forge-plugin, whose half is reported there. Those, and questions
already open, read `noRecommendation: "The run that asked gave no recommended answer"`.

**In chat.** "What waits on me" is answered from the decisions, grouped, each with its question,
the recommendation and its buttons drawn from the tool result (the `offer_act` card pattern of
`contracts/chat-acts.ts`). The reply ends with one line naming what it left out, by reason.

## A held reply still shows its checked part (BC-3)

Today an Assistant-mode reply that no rewrite fixes is replaced whole by
`conversations/fallback-replies.ts:heldFallbackReply`, and its staged blocks are dropped.

- **Cut, do not mark.** Each refused claim's clause is cut from the draft. The clause span is
  `messaging/reply-marks.ts`'s own clause rule, exported. What is left is screened again, and it
  ships only if it passes.
- **Blocks are kept.** Blocks staged by `forge_show` and `forge_report` are drawn from this turn's
  reads, so they are released with a partial reply.
- **The notice.** `reply-check.ts:heldPartNotice` names what was left out.
- **The record.** The message stores `heldPartSchema` (`verdict: partial`), and the stream sends
  `partial` beside `checked` and `withheld`.
- **When nothing is left.** If no clause passes and there is no block, the reply is `withheld` and
  goes out as today's held line. It is never empty.

## Page actions (BC-4..BC-9)

- **Routes (BC-4).** `UI_ROUTE_ADDITIONS` adds `requirements` and `feedback`. `workflows` and
  `releases` are already registered.
- **Filters (BC-4, BC-5).** `ui-list-filters.ts:UI_LIST_FILTERS` gives each list a closed set of
  fields. Every list has `waitingOn: you | agent | running`. The value is read by
  `waitingFilterOf` from the row's standing, the same read every list draws its Waiting-on cell
  from. Each field lives in one URL param (`UI_FILTER_PARAMS`), so the list, the action and the mark
  read the same thing. The Product lists get `ui.requirements.filter`, `ui.feedback.filter`,
  `ui.workflows.filter` and `ui.releases.filter`, in the shape `ui.issues.filter` already has.
  Issues gains `waitingOn` in the same change that teaches its list to read it.
- **Open by key (BC-6).** `ui.open` takes `{key}` read by its shape (REQ-n, FB-n, an issue key), or
  `{kind, key}` for a workflow flow or a release version. A key its kind does not take is refused,
  naming the shape it takes.
- **Highlight (BC-6).** `ui.highlight` marks a section of the open record (`UI_HIGHLIGHT_SECTIONS`),
  a step of the open workflow, or a row the list shows. `highlightRefusal` refuses it
  `UI_ACTION_NOT_ON_PAGE` from the snapshot core already holds, before the browser is asked. The
  page uses the existing `.forge-highlight` style in `globals.css`, through one hook.
- **Marks (BC-7).** `chat-dock/assistant-filters.ts` already marks a chip orange while the URL still
  holds the value the assistant set, so a person's change clears it. This spreads to every list's
  toolbar.
- **Sees (BC-8).** The snapshot gains `listFilter`, `shown` (the top 50 row keys, so "the first one"
  means what the person sees) and `highlight`. `describeUiSnapshot` says them. The model reads them
  as page context, as it already does.
- **View only (BC-9).** Every page action changes the view only. Acts are the decision buttons
  above, and the existing `offer_act` cards, both pressed by the person.

## Noise cut at the source (BC-10, BC-11, BC-12)

| BC | Rule | Kernel rule | What decides |
|---|---|---|---|
| 10 | A requirement follows an approved design by itself | On a workflow design reaching `approved`, core re-pins every agreed requirement pinning an older revision of it, through `requirements/repin.ts:repinRequirement`, as the kernel with a reason naming both revisions. A re-pin changes no criterion (`standing.effect.follow`). Where the new revision removes or renames a step a criterion traces, core does not re-pin. The requirement then waits on the assistant (`agent`), which drafts a `revision_diff` suggestion. | Whether any step a current criterion traces was removed or renamed between the pinned and the approved revision |
| 11 | A run parked after repeated failures waits on the master | `pipeline/autonomous-rescue-cap.ts` parks at `on_hold` as an agent park (no question, no blocker). `issues/standing.ts`'s agent-park turn already reads that as waiting on the master ("resume once"). The master re-dispatches with a changed brief, drops it, or asks a person a question carrying a recommended answer. | The cap that exists: 3 run sessions ended since the issue last moved on |
| 12 | A draft untouched for 7 days gets a merge-or-drop proposal | A sweep finds drafts (requirement draft revisions, draft requirements, draft issues) whose newest touch is 7 days old and that have no open proposal. The assistant asks one question on the record: merge into a named item, drop, or keep, with a recommended option and its reason, read from requirements, feedback and releases. Before that the draft is `awaiting_proposal`, which is not a decision. | `touched_at` older than 7 days (`DRAFT_STALE_DAYS`), and no open question of that origin |

The 7 crash-park questions already open are voided by the master through the API after the change
lands, each moving its issue to the agent park, so no SQL rewrites a kernel row.

## The home opens on chat (BC-13)

The project home (`app/(workspace)/projects/[slug]/page.tsx`) leads with the conversation: the
composer and its thread, full width. Beside it, or below it on a phone, are three flat sections:

- **Needs you:** the decisions read, grouped, with their buttons.
- **Running:** what `forge_project_status` reads as in flight.
- **At risk:** what it reads as late, and requirements whose criteria fall short on the running build.

They are tables with hairlines, no cards. The sections the home has today move below these three
or leave, where the dashboard already shows them.

## Idea preview (BC-14, BC-15, BC-16)

**What it is.** An idea preview is a REQ-39 preview whose subject is `idea`
(`preview.ts:previewSubjectSchema`). It is not a second preview kind.

**How it starts (BC-14).** In chat the assistant offers "Build a preview" for a requirement or a
feedback item. Pressing it calls `POST /api/projects/:id/previews` with `{kind: "idea", about,
brief}`, as the person, and needs `project.write`. Core starts a sketch run on a runner:
- the run is an agent session with no issue;
- its worktree is off the base, on `sketch/<item>-<6 chars>`;
- it is briefed with the item and the ask;
- it never pushes, never merges and never files anything.

The preview serves that worktree.

**Edits (BC-15).** Each chat message about the preview goes through REQ-39's preview door
(`messages`, then `session.send`). The run edits, and the dev server's hot reload shows the change.

**Keep (BC-16).** Keeping an idea snapshots its patch, base and files, takes screenshots, and writes
a `preview` picture (`keptPreviewContentSchema`):
- on the requirement's head revision, for an idea about a requirement;
- on the item's new requirement draft (triage route `new_requirement`), for an idea about feedback.

The assistant then drafts criteria from what was asked and what changed, as a `revision_diff`
suggestion, or into the draft itself while it is a draft. Reopening a kept picture starts a new idea
`from` its patch.

**ISS-458's question** is what a requirement picture is. For a screen it is, at best, a kept preview:
the real build, labelled a rough sketch, with no accept. No baseline pins it, as Requirement
lifecycle r14 already says of every picture.

## Reproduce (BC-17..BC-22)

- **Build (BC-17).** A feedback item opens `{kind: "reproduce", feedback}`. With no build named,
  core takes the release live on the environment the item names at its `created_at`. Without one it
  refuses `PREVIEW_BUILD_UNKNOWN`, naming "a release or a sha". The runner checks the sha out into
  scratch and starts the dev server with no agent session. A sha the box cannot fetch fails the
  preview `REF_NOT_FOUND` with the git output.
- **Data (BC-22).** `preview.demo` (`previewDemoSettingsSchema`) names a demo environment, a seed
  command, or both. Without it the reproduce uses the environment its dev server already uses
  (`reproduceDataOf`). Production is refused either way (`PREVIEW_PRODUCTION_ENVIRONMENT`).
- **Recorder (BC-18).** The relay injects `<script src="/__forge_preview/rec.js">` after `<head>` in
  every `text/html` answer of a recording preview. It asks the dev server for `identity` encoding on
  those requests and drops `content-length`. The script is rrweb 2.x (MIT) with its console and
  network plugins, set by `RECORDER_OPTIONS`:
  - every input masked;
  - text an app marks private masked;
  - network requests without headers or bodies;
  - console errors and warnings, and uncaught errors;
  - two custom events: labelled clicks and client-side route changes.

  It posts batches to `/__forge_preview/rec` on the same origin behind the viewer cookie, so the
  app's `script-src 'self'` admits it and no Forge credential reaches the page. A page whose own CSP
  blocks it is failed `RECORDER_BLOCKED` after 30 s without a batch.
- **Storage.** Every string in a batch passes `@forge/observability` `scrubSecretsDeep` and
  `scrubPersonalData` before it is stored.
  - Raw events go to the uploads storage (`getStorage()`) as gzip segments, for 30 days.
  - The `timelineOf` timeline, at most 500 lines, sits on the `preview_recordings` row until the
    item's reporter data is redacted.
  - A recording stops at 30 minutes and is refused past 50 MB.
- **Diagnosis (BC-19).** The assistant reads the timeline through `forge_recording`, never the raw
  events. It reads the build's release page for what changed in it. It proposes a cause and a fix
  as a `feedback_triage` suggestion: route `issue`, short form, with the recording as the
  reproduction evidence. It reads the product record, not the code; the fix is built by the routed
  issue's run.
- **Confirm (BC-20).** The routed issue's run opens its REQ-39 preview. The reporter, or anyone on
  the project for them, presses Fixed or Not fixed there (`POST /api/previews/:id/confirm`). The
  confirm is bound to the patch id served. When the issue ships, `loopCloseFromConfirm` answers the
  item's loop close:
  - gone, where the shipped patch is the one confirmed;
  - not gone, on Not fixed, which reopens the item with its note;
  - asked again as today, where what shipped differs.
- **Members only (BC-21).** Recordings are read by `project.read` holders: the route, and the
  feedback page's player. The preview relay already admits members only, by ticket and cookie, with
  the membership checked again within 60 s. `feedback.redact` deletes the recordings with the rest
  of the reporter's data.

## Permissions and every refusal

| Act | Permission | Refusals |
|---|---|---|
| Read decisions | `project.read` | none beyond the read's own |
| Press a decision button | the route's own | the route's own codes, unchanged |
| Ask a person a question | the asking door's | `QUESTION_RECOMMENDATION_REQUIRED` |
| Page action | the asker's turn | `UI_ACTION_UNKNOWN`, `UI_ACTION_INVALID`, `UI_ACTION_NOT_ON_PAGE`, `UI_ACTION_UNAVAILABLE` (browser) |
| Open an idea | `project.write` | `PREVIEW_ITEM_UNKNOWN`, `PREVIEW_RUNNER_UNSUPPORTED`, `PREVIEW_DOMAIN_UNCONFIGURED` |
| Keep an idea | `requirements.write` | `PREVIEW_KEEP_NOT_IDEA`, `PREVIEW_SNAPSHOT_UNAVAILABLE` |
| Open a reproduce | `project.read` | `PREVIEW_ITEM_UNKNOWN`, `PREVIEW_BUILD_UNKNOWN`, `PREVIEW_PRODUCTION_ENVIRONMENT` |
| Send a recording batch | the viewer cookie of that preview | `RECORDING_CLOSED`, `RECORDING_SEQ_GAP`, `RECORDING_BATCH_TOO_LARGE`, `RECORDING_TOO_LARGE` |
| Read a recording | `project.read` | `RECORDING_NOT_FOUND`, `RECORDING_FORBIDDEN`, `RECORDING_EXPIRED` (events), `RECORDING_REDACTED` |
| Confirm a fix | `project.read` | `PREVIEW_CONFIRM_NOT_FIX`, `PREVIEW_CONFIRM_REASON_REQUIRED` |

## Design text owed

These are text-only revisions, approved by the orchestrator.

- **Chat turn r6 → r7.**
  - `investigate` reads the needs-me read for "what waits on me".
  - `held` shows the checked part, and is withheld only where nothing passed.
  - A new step `page` covers the page actions and Sees.
  - A door `preview` for ideas: it writes code through a sketch run and no record.
- **Requirement lifecycle r14 → r15.**
  - `agreed` re-pins by itself on a design approval unless a traced step changed.
  - `draft` gets the 7-day merge-or-drop question.
  - `picture` takes a kept preview for a screen.
- **Issue lifecycle r14 → r15.** The rescue cap is an agent park waiting on the master. A run's
  person question carries a recommended answer.
- **Feedback triage r15 → r16.** `suggest` may carry a recording's cause and fix. `verify` is
  answered ahead by a confirm on the same patch.
- **Feedback lifecycle r13 → r14.** `evidence` includes a reproduce recording with its timeline.
  `loop-check` reads a confirm.
- **Personal data in Forge r16 → r17.** Recordings: scrubbed at ingest, raw events for 30 days,
  the timeline until redacted, members only.

## Criteria

| BC | Where it holds | Lane |
|---|---|---|
| 1 only person decisions | `needsYouDecisionsSchema`, `notDecisions`, `forge_needs_you` | needs-me |
| 2 question, recommended answer, button | `needsYouDecisionSchema`, `DECISION_ACTS`, `QUESTION_RECOMMENDATION_REQUIRED` | needs-me |
| 3 held reply shows its checked part | `heldPartSchema`, clause cut, blocks kept | needs-me |
| 4 open Product lists, set filters | `UI_ROUTE_ADDITIONS`, `ui.<list>.filter` | ui-actions |
| 5 filter by you, agent, running | `waitingFilterOf`, `waitingOn` on every list | ui-actions |
| 6 open any record, highlight | `uiOpenParamsSchema`, `ui.highlight`, `highlightRefusal` | ui-actions |
| 7 assistant filters stay marked | `UI_FILTER_PARAMS`, `assistant-filters.ts` on every toolbar | ui-actions |
| 8 chat knows what the page shows | snapshot `listFilter`, `shown`, `highlight` | ui-actions |
| 9 view only, acts by click | registry view-only; buttons are page routes | ui-actions, needs-me |
| 10 auto-follow approved designs | re-pin on design approval | noise-cut |
| 11 crash-park waits on the master | rescue cap as an agent park | noise-cut |
| 12 7-day merge-or-drop proposal | stale-draft sweep, question with options | noise-cut |
| 13 home on chat | home page | home |
| 14 build an idea as a live preview | `idea` subject, sketch run | previews-core, idea |
| 15 edits within seconds | preview door, hot reload | previews-core |
| 16 kept preview is the picture | `keptPreviewContentSchema`, picture kind `preview` | idea |
| 17 preview of the reporter's build | `reproduce` subject, build resolution | previews-core, reproduce |
| 18 records clicks, errors, failed requests, inputs masked | `RECORDER_OPTIONS`, `timelineOf`, relay injection | previews-core |
| 19 assistant proposes cause and fix | `forge_recording`, triage suggestion | reproduce |
| 20 reporter confirms, that is the verdict | `confirmFixRequestSchema`, `loopCloseFromConfirm` | previews-core, reproduce |
| 21 members only | relay admission, `RECORDING_FORBIDDEN` | previews-core |
| 22 demo data, else dev environment | `previewDemoSettingsSchema`, `reproduceDataOf` | previews-core |

## Lanes

Each lane owns its files outright; the exact list is the split the orchestrator holds.

| Lane | BC | Migration | Merges after |
|---|---|---|---|
| needs-me | 1, 2, 3 | none | this branch |
| ui-actions | 4–9 | none | this branch |
| noise-cut | 10, 11, 12 | none | this branch |
| home | 13 | none | needs-me |
| previews-core | 14, 15, 17, 18, 20–22 (core, runner) | 0479 (`previews` subject columns, `preview_recordings`, `preview_fix_confirmations`) | preview-tunnel (0477), release-page (0478), this branch |
| idea | 14, 15, 16 (web, assistant, picture) | 0480 (`requirement_pictures` kind `preview`) | previews-core |
| reproduce | 17, 19, 20 (web, assistant, feedback loop close) | none | previews-core |

## Honest costs

- **More text in every turn.** The model is offered five more page actions, and each message
  carries up to 50 row keys of snapshot.
- **A rule that acts alone.** The re-pin on design approval runs without anyone pressing it. A
  design change that alters what a criterion means without renaming its step is followed silently.
  The traced-step test is only as good as the traces.
- **Fewer person gates.** The rescue cap no longer reaches a person directly. A master that is down
  leaves parked issues waiting until it returns, where a person might have noticed sooner.
- **A recorder inside the project's page.** It costs about 30 KB gzipped per page, and every HTML
  answer of a recording preview is buffered to inject it.
- **Masking is a promise.** Text is not masked by default, so a page showing personal data on the
  dev environment is recorded showing it, scrubbed only by pattern. Demo data is the real answer,
  and it is a project setting nobody is made to fill.
- **Storage that grows.** Up to 50 MB a recording for 30 days, in the uploads store, with a sweep to
  maintain.
- **Sketch runs.** Each takes a runner slot and a dev server on the box like an issue run, for work
  that may be thrown away.
- **A confirm that waits.** The reporter's confirm counts only if the shipped patch equals the one
  they saw. A rebase that changes the patch id asks them again.
- **Branches that wait on others.** Seven lanes and two migrations hang on preview-tunnel and
  release-page landing first.

## Not decided here

- **How a design-only issue closes.** This is ISS-290's owner ruling. Its 3 open questions stay
  decisions with no recommendation until then.
- **Pin-only design batches.** Whether "approve N pin-only changes" follows by itself like BC-10.
  It is the same principle, but no criterion names it.
- **Safari and the recorder.** Whether the recorder survives Safari's iframe cookie partitioning is
  REQ-39's open question too.
