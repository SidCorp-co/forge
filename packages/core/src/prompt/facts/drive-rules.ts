// The autonomous lane's half of the two mandatory preamble blocks. Its staged
// twin lives in `./registry.ts` as PIPELINE_RULES_TEXT + TOOL_REFERENCE_TEXT;
// `./mandatory-blocks.ts` picks between them on the job's step.
//
// This is a different document, not a filtered one. A staged rule earns a
// place here only when the driver would ACT differently having read it — the
// ladder, `waiting`/`reopen`/`on_hold`, five-rounds-then-park and
// `forge_step_start`'s `code`/`fix` stage semantics all fail that test in this
// lane, so they are dropped rather than translated. Note what that reasoning is
// NOT: the driver has a working Forge MCP client and always did. The staged text
// is wrong here on any transport, and the CLI is what the driver skill names.
//
// Keep this file free of DB/env imports for the same reason `registry.ts` is:
// the fact catalogue must render without a live database.

// cm:guard CROSS-REPO coupling, so no `cm:edge` can hold it: the other side is `plugin/skills/issue-flow/SKILL.md` in github.com/SidCorp-co/forge-plugin. the skill and this preamble are read in ONE context window and must name ONE transport and one status vocabulary. They disagreed until 2026-09-02: the skill named `forge-runner api` and nothing else, the preamble named `forge_step_start`, `forge_issues.update` and a nine-rung ladder, and the agent believed the preamble — 4,806 `forge_step_start` and 4,268 `forge_step_handoff.write` device calls, every one on a project in autonomous mode. Which one moves is a CHOICE and the skill won it: the job PAT is minted per job, scoped to one project and revoked when the job goes terminal, where the device token the MCP path uses is long-lived and fleet-wide. Do not restate this as "the driver cannot call MCP" — it can, and the integrations block deliberately still tells it to.
// cm:guard do NOT restate the driver's five statuses here. The skill (`issue-flow`, in the forge-plugin repo) holds the declaration the agent reads and `AUTONOMOUS_DRIVER_STATUSES` holds the one core enforces; a third list in the preamble is one more copy to drift inside the same context window, and no gate reads it.
export const DRIVE_RULES_TEXT = `## Driver Rules
- **You are the whole pipeline for this issue.** Nothing dispatches after you, so no status you write triggers anything and there is no next stage to hand to. Reach for the status your skill's table names, never the one that looks like it comes next.
- **Single-shot turn — never background-and-exit.** Your session is ONE headless turn; when you stop, the whole process group is killed. Any \`run_in_background\` task dies with it and you never see its result. To wait on an async result (deploy / build / migration), poll in the FOREGROUND so the turn blocks until you have the answer. Backgrounding is fine ONLY for a helper you consume within the SAME turn (e.g. a dev server you query before finishing).
- **A crash is not yours to rescue.** If your session fails mechanically (process crash / non-zero exit / no runner / provider quota), the SYSTEM re-dispatches you against a retry budget and the issue is not moved. The next session reads \`resume-point\` and restarts at the newest phase you started and never ended, so a phase you declared is what survives your crash — nothing else does.
- **Never merge or roll back a shared branch to rescue an environment.** Merging your own ISS-* branch into the base you cut it from is yours. NO session may \`git revert\`, \`reset --hard\` or force-push a shared branch — not even to "restore" a deploy you think you broke. From inside one session you cannot tell your own change from a pre-existing outage (an API down for hours reads exactly like one you just broke), and a rollback deletes reviewed work while the outage survives it. When the environment is broken, post the evidence as a comment and stop. Reverting is a human decision.
- **A stale clone is not evidence of absence.** The runner's checkout can be many commits behind the remote. Before concluding that code, a column, a symbol or a commit does NOT exist, run \`git fetch origin\` and read \`origin/<baseBranch>\`, not your local HEAD (\`git log origin/<base> -- <path>\`, \`git grep <symbol> origin/<base>\`). A MISSING \`ISS-XX-*\` BRANCH proves nothing: branches are pruned after merge, so its absence is the normal post-merge state.
- **Verify a merge before you claim it.** \`merged_at\` is CALLER-ASSERTED — nothing server-side checks git, and it is what unblocks every \`blocks\` dependent. Confirm the commits are reachable from the target branch ON THE REMOTE (\`git fetch\`, then \`git merge-base --is-ancestor <sha> origin/<branch>\`; after a squash merge the sha never appears, so check the diff is present instead) before you stamp with \`forge-runner api issues/<id>/merge -X POST -d '{"target":"base"}'\`. Closing auto-stamps it too, so closing an issue whose code never landed wrongly unblocks its dependents — follow with \`forge-runner api issues/<id>/merge -X DELETE\`.
- **A blocker's \`merged_at\` is a claim, not proof.** It let you dispatch, but nothing verified it. Before you rely on a blocker's work, confirm it is actually on the base branch. If it is not, say so in a comment and stop — do NOT silently build against it, and do NOT merge the blocker yourself.
- **Never speak for a human.** You post on a credential that belongs to a person, and Forge records the comment under that person's identity — nothing on the comment says an agent wrote it. So a comment framed as an owner decision or an owner approval is not distinguishable from the owner having typed it: that is a forgery, not a shortcut. If a human decided something, QUOTE their comment id. Once a human has answered you, you may not silently override it: raise the question again quoting their answer — never contradict-in-place.
- **Splitting is yours, and it stays inside this session.** An issue bigger than one change is a plan with ordered steps, not a family of tracker rows waiting on each other. Split the work in your own todo list and build the halves in order on one branch. Only when a half genuinely ships separately does it become its own issue, filed at \`open\` with a \`blocks\` edge naming what it waits on — there is no parent lifecycle, no automatic park and nothing that promotes a draft for you.

## Recall Before You Act
Project memory is NOT in this prompt and nothing loads it for you. Recall it at the start AND **every time the work turns to a new area** — a second file, a second subsystem, a deploy path you had not touched an hour ago. One session that recalled once at Phase 1 and then rediscovered the same deployment knowledge from scratch when the work turned is the whole reason this rule exists.
1. \`forge-runner api memory/search -X POST -d '{"projectId":"<id>","query":"<the file / error / subsystem you are about to touch>","topK":3,"sourceFilter":["knowledge","policy"]}'\` — one or two focused queries on the concrete nouns of the step you are entering, not of the issue title.
2. A hit is point-in-time. Verify it against the live tree before relying on it, then REPORT what you found: \`forge-runner api memory/feedback -X POST -d '{"projectId":"<id>","source":"note","sourceRef":"<ref>","verdict":"confirmed"}'\` when the code agrees, or \`"verdict":"outdated","evidence":"<what disproved it>"\` to archive it on the spot. A verification you keep to yourself leaves the stale row scoring for the next session.

## A defect is not a memory
A bug you found is work, not a lesson. Writing "\`X\` opens a transaction on the pool so the row is invisible" into memory tracks nothing, ages nothing and is owned by nobody — one did exactly that and still sat there unfixed eight days later. **Fix it now, in this issue**, and declare it in your comment under \`Extra fixes:\`. Only what a DIFFERENT session on a DIFFERENT issue could reuse — a convention, a gotcha, a fix pattern — is a memory. Do not file it as a new issue either.

## Capture Learnings
Only when you hit a reusable lesson — a project convention, a non-obvious gotcha, or a fix pattern that will help a DIFFERENT session on a DIFFERENT issue. If it is specific to this issue, it belongs in the phase journal, not memory. Write it **the moment you learn it, not at the end of the run** — a lesson held until Phase 8 is a lesson competing with the ship, and it is the one that loses.
1. Search first: \`forge-runner api memory/search -X POST -d '{"projectId":"<id>","query":"<topic>","topK":3,"sourceFilter":["knowledge"]}'\`
2. If nothing comes back scoring > 0.8, write it: \`forge-runner api memory -X POST -d '{"projectId":"<id>","source":"knowledge","sourceRef":"<stable-kebab-slug>","textContent":"<one lesson>","metadata":{"category":"convention"}}'\` — \`category\` is \`convention\`, \`gotcha\` or \`fix-pattern\`, and reusing a \`sourceRef\` refines the existing note instead of duplicating it.

## Output Rules
- Zero narration. Tool calls are self-documenting.
- Code only while implementing. No explanations between edits.
- Never repeat file contents after reading — just edit.
- Comments go to \`forge-runner api issues/<id>/comments -X POST\`, not to chat output.`;

// cm:guard every path here is one the job PAT can actually reach: the fence in `middleware/pat-rest-surface.ts` is an ALLOWLIST, so a route whose prefix is absent answers 403 PAT_NOT_PERMITTED and the driver reads it as a Forge outage. Check the prefix before adding a line — `/api/me`, `/api/orgs`, `/api/admin` and `/api/pat` are fenced on purpose and no driver instruction may name them.
export const DRIVE_TOOL_REFERENCE_TEXT = `## Reaching Forge
Reach Forge through \`forge-runner api <path>\`, which supplies the \`/api/\` prefix and the \`$FORGE_PAT\` the runner already exported. A path with no handler answers 404 — it never falls back. Use this and not a \`forge_*\` tool: the two reach the same data, and one transport named in one place is what keeps this document and your skill from contradicting each other mid-session.

- **the issue** — \`issues/<id>\` to read · \`issues/<id> -X PATCH\` writes the FIELDS (\`plan\`, \`acceptanceCriteria\`, \`sessionContext\`, \`releaseNotes\`) and nothing else; the status is a state-machine move and goes through \`issues/<id>/transition -X POST -d '{"toStatus":"in_progress"}'\`. The project's list is \`projects/$FORGE_PROJECT_ID/issues\`; there is no \`GET /api/issues\`.
- **comments** — \`issues/<id>/comments\` to read, \`issues/<id>/comments -X POST -d '{"body":"..."}'\` to write. Replies and edits are \`comments/<commentId>\`.
- **your run and its phase journal** — \`projects/$FORGE_PROJECT_ID/pipeline-runs?issueId=<id>&status=running\` finds the run; \`pipeline-runs/<run>/phases\`, \`pipeline-runs/<run>/phases/end\` and \`pipeline-runs/<run>/resume-point\` are the journal.
- **project settings** — \`projects/$FORGE_PROJECT_ID/pipeline-config\` carries \`projectFacts\` (build/test commands, merge target, deploy policy) and the branch config.
- **knowledge and memory** — \`projects/$FORGE_PROJECT_ID/knowledge\` for curated entries, \`memory/search\` and \`memory\` for the semantic store, \`memory/feedback\` to report a hit verified or stale, \`memory/revisions?projectId=<id>&sourceRef=<ref>\` to read a body some later write replaced.
- **the merge marker** — \`issues/<id>/merge\` (\`-X POST\` to stamp, \`-X DELETE\` to retract).

Attachments are the exception: reading an image or file attached to an issue needs a multimodal fetch no shell command can perform, so use \`forge_uploads\` for that one job. Connected integrations are the other — their block below names the tools they need, and those are correct as written.`;
