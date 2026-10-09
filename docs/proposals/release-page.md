# Release page — every release is a readable page, led by the Product

**Removed when:** the three build lanes of REQ-40 (qa-clips, release-page, release-reach) have
landed and REQ-40's thirteen criteria each have a pass verdict on the live build; the change that
lands the last of them deletes this file.

**Status:** proposed · **Date:** 2026-10-09 · **Read at:** `ca6610b5c` on `dev` · **Requirement:**
REQ-40 r1 (BC-1..13) · **Delivery issue:** ISS-492 · **Contracts:**
`packages/contracts/src/release-page.ts`

## What good products ship, and what we take

| Source | What a release carries | Taken here |
|---|---|---|
| Linear changelog (linear.app/changelog) | date, a lead feature with hero media, then Improvements and Fixes as short lists, a separate API section | one to three highlights with media, then lists |
| Notion releases (notion.com/releases) | headline, a GIF or video per major feature, "And a few more…" list | media belongs to the highlight, minor items are lines |
| Stripe changelog (docs.stripe.com/changelog) | every entry flagged breaking or not, API version, product area | Action required and the developer view's contracts |
| GitHub release notes (release.yml categories) | merged changes grouped by label | sections come from each issue's own note, never from commits |
| Keep a Changelog 1.1.0, changesets, release-please | Added, Changed, Deprecated, Removed, Fixed, Security; one fragment per change, assembled at the cut | already Forge's: `changelog.d/README.md`, per-issue `releaseNotes` |
| Beamer and Tour Kit docs | an announcement shown once per user, which needs one user id across devices, so the mark lives on the server | the seen mark is a server row per person |
| Playwright `recordVideo` (playwright.dev/docs/videos) and `Screencast` (v1.59+) | webm only; a context's video is saved at `close()`; a screencast starts and stops on one page | one clip per criterion, webm |
| GitHub attachments | 10 MB per image, 10 MB per video on a free plan | a clip stays at or under the 10 MiB upload ceiling |

Nobody we read splits a user page from a developer page; they separate by section. Forge splits
by view (BC-9) because its readers are a customer and a developer of the same product.

## What already exists, so nothing is built twice

| Piece | Where | Used for |
|---|---|---|
| Release read model | `packages/core/src/release-batch/release-read.ts:readRelease` → `ReleaseDetail` in `packages/contracts/src/releases.ts` | header, requirements completed or advanced (`packages/core/src/release-batch/release-view.ts:completionOf`), per-issue criteria, notes, changes, approvals |
| Customer lines | `packages/contracts/src/customer-notes.ts:customerNotes` | Improvements and fixes (BC-6) |
| Verdicts | `criterion_verdicts`: one row per judgement, `commit_sha` is the build, `evidence` names issue attachments | the truth rule (BC-13), known issues (BC-8), media (BC-3) |
| Verdict door | `packages/core/src/issues/criteria/routes.ts:issueCriteriaRoutes`; Judge form `packages/web-v2/src/features/issues/components/criteria-acts.tsx:RecordVerdict` | clip capture (BC-4) |
| Issue attachments | `packages/core/src/lib/attachment-mime.ts:ALLOWED_BY_TARGET` (issue takes `video/webm`, `video/mp4`), 10 MiB ceiling, local disk | where a clip is stored |
| Drafting with a figure check | `packages/core/src/reports/narrative.ts:writeTemplateNarrative` over `packages/core/src/integrations/llm/chat.ts:completeOnce`, judged by `packages/core/src/reports/templates.ts:judgeNarrative` | highlight drafting (BC-2) |
| What's new and its seen mark | `packages/core/src/whats-new/read.ts:readWhatsNew`; `packages/contracts/src/product-state.ts:whatsNewSeenValueSchema` in `user_product_state` | BC-10 |
| Share port | `packages/core/src/shares/ports.ts:provideShareSubjectSources`, example `packages/core/src/status-reports/share-source.ts:statusReportShareSource` | BC-11 share |
| Markdown export | `packages/contracts/src/status-reports.ts:reportDocumentMarkdown`; release notes copy in `packages/web-v2/src/features/releases/components/release-customer-notes.tsx:CustomerNotes` | BC-11 export |
| Approval setting | `packages/contracts/src/releases.ts:releaseApprovalRequired`, `release_approvals.decided_by_user` | BC-1 "who approved", BC-12 |

## The page

One page per release version, at the release's existing route. It opens on the user view; a
switch shows the developer view. The operator panes the page has today (criteria, checks, issues,
attempts) stay under the developer view. The Overview pane's "what users get" and customer-notes
blocks are replaced by the sections below, not kept beside them. Flat layout: sections divided by
hairlines, no cards. English copy.

| Section | View | BC | Built from | Rule |
|---|---|---|---|---|
| Header: version, date, where it runs, commit, approved by | both | 1, 12 | `ReleaseDetail` (version, releasedAt, production, finish commit, verified, approvals) | approval reads "not asked" where the setting asks nobody |
| Highlights, 1–3, each with a clip or picture | both | 2, 3 | stored highlights (below) | judged by `judgeHighlights` before they show |
| Requirements completed or advanced, with criteria proven live | both | 5 | `requirementsCompleted` + verdicts | a criterion is listed as proven only under the truth rule |
| Improvements, Fixes | both | 6 | `customerNotes` over each issue's `releaseNotes.userFacing`; section read as new, improved or fixed | an issue with no note is named, not invented |
| Action required: settings, migrations, permissions | both | 7 | the release's landing artifacts (`ReleaseChanges`): migration files, permission keys, project-config paths | each item names the artifact that owes it |
| Known issues | both | 8 | every carried criterion the truth rule does not claim | fail, short, skipped, or not judged on this build, with where it was judged instead |
| Technical notes: changes, migrations, API contracts, dependencies | developer | 9 | `releaseNotes.technical`, `ReleaseChanges`, contract and manifest artifacts | none |

**Truth rule (BC-13).** The build a page describes is the commit the release was cut at and
deploys. A criterion is claimed only when the newest verdict whose identity is that commit is a
pass (`releaseClaimOf`). A short, fail or skip on the build is a known issue as itself; a pass on
the merged commit or any other is "not judged on this build". With no cut, nothing is claimed.

## Highlights

- **Drafted by** the assistant through the gateway only: `completeOnce` on the deployment's chat
  provider. No direct provider key, no provider-only tool. With no model configured the page says
  so: `RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED`.
- **From** the Product record only (`ReleaseHighlightFacts`): for each requirement the release
  completes or advances, its title, summary and criterion statements, the BC codes the truth rule
  lets it claim, and the clips and pictures that release's verdicts kept. Never the codebase.
- **Judged** by `judgeHighlights` before it is stored: 1 to 3 (none where no requirement is
  carried), one per requirement, every claim a pass on the build, every figure stated in that
  requirement's record, media only from evidence of what it claims, and a clip used where one
  exists. A refusal is sent back once with the draft, as `writeTemplateNarrative` does; a second
  refusal stores `failed` with the refusals, and the page shows that instead of highlights.
- **Written** on each move of the release run and on each verdict recorded against a commit for an
  issue it carries (outbox `verdict.recorded`; the replay after deploy records these), and when a
  page read finds no draft answering today's facts. Each draft stores a digest of its facts; an
  unchanged digest is not redrafted, and a read never shows a stored highlight the build no longer
  proves. Stored per release (one table, migration 0478), never hand-edited.

## Clips (BC-3, BC-4)

- QA records one clip per observable criterion it judges: a Playwright screencast (or one context
  with `recordVideo`) started before the step that shows the criterion and stopped after it, webm,
  at most `RELEASE_CLIP_MAX_SECONDS` and `RELEASE_CLIP_MAX_BYTES`. A longer clip is re-recorded
  tighter, never trimmed by a server and never the ceiling raised.
- It is uploaded as an issue attachment and cited by name in the verdict's `evidence`, the same
  path a screenshot takes today. The Judge form accepts video as well as images.
- A highlight picks, from the clips and pictures cited by pass verdicts on criteria it claims, the
  clip first, then a picture. Where none exists it says why (`mediaGap`) rather than borrowing one.

## What's new (BC-10)

The seen mark becomes the release a person last saw in this environment: `ReleaseSeen
{ environment, version, at }`, kept in the existing `user_product_state` row for What's new (no new
key, so no CHECK change). What's new opens by itself once when the environment serves a newer
release than the mark (`whatsNewReleaseOwed`); a rollback opens nothing. It shows the serving
release's user view: highlights first, then the lines. The changelog feed is replaced as its source,
not kept beside it.

## Share and export (BC-11)

- **Share** is a new share subject, `release`, through the existing port: the user view is frozen
  at share time, scrubbed, opened at the existing share path. The subject list is CHECKed on
  `share_links`, so the kind lands with migration 0478.
- **Export** is built in the browser from the page's user view, as the release notes copy is today:
  Markdown (sections, media as links) and an email (a subject, a plain-text body and an HTML body
  from the same sections) downloaded as a `.eml` a person sends from their own mail. Forge sends no
  mail. The page reads at `releasePagePath`.

## Approval (BC-12)

The page is built by Forge from its records at the cut; nobody writes it. A person approves the
release only where `release.approval.required` is on, through the existing release approval. The
header says who approved and when, or "not asked" where the setting asks nobody; an approval given
anyway still shows. No new approval door.

## Seams with the live-preview lane (REQ-39)

No runner tunnel, preview or deploy-lane code is touched. QA records clips against whatever build
it is handed, preview or live; where REQ-39's preview URL is the judged build, the clip carries
that verdict's commit like any other.

## Build lanes

qa-clips (BC-4), release-page (core read model, highlights, share; BC-1..3, 5..9, 11 share, 12,
13; migration 0478), release-page-web (the page, both views, share render, export; BC-11 export),
release-reach (What's new; BC-10). Each owns its files outright; they merge in that order after
qa-clips, which merges whenever it is ready.

## Honest costs

- **QA takes longer.** Recording one clip per judged criterion adds seconds of capture and up to
  10 MiB of storage per clip, and a QA run that skips it leaves a highlight without media.
- **Strict truth hides real progress.** Under BC-13 a criterion passed on a merged commit but not
  re-judged on the release commit reads "not judged on this build" until QA judges the served build.
- **A model call at every cut.** Highlights are drafted through the gateway and redrafted when a
  verdict lands on the release commit; each draft costs a call and can fail, leaving the page
  without highlights until the next attempt.
- **One more table and one more read model** to keep in step with the release record.
