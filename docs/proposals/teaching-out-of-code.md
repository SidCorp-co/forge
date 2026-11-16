# Teaching that ships in code moves to the guides agents read at run time

**Removed when:** the issue that moves these three texts lands; until one is filed, ISS-1251 carries
this file, and the change that moves the last of them deletes it.

Found by ISS-1251's audit of how masters and runs are taught (owner, 2026-11-16: teach agents by
situation, at the source they read; the room brief moving out of `support/prompt.ts` is the same
finding for room agents). Org knowledge `prompt-is-a-map` says the always-on text is a few short
lines per rule, detail is fetched when the work needs it, and the way of working lives in org
knowledge or a skill. Three texts that teach masters and runs break that by living in code: changing
what an agent is taught takes a core deploy or a runner release, and tests pin the detail into the
always-on text, so it cannot shrink to a map.

Sizes were measured on 2026-11-16 at the head of `fix/iss1251-teach-not-force`, as characters of
the composed text.

## The three texts

### 1. The forge-master skill

- **Where it lives:** `packages/runner/crates/runner-workspace/assets/forge-master-skill.md`,
  compiled into the runner binary (`packages/runner/crates/runner-workspace/src/master_skill.rs:ASSET`)
  and written into each master's checkout by `packages/runner/crates/runner-workspace/src/master_skill.rs:install`.
- **Size:** 33 330 characters, 5 734 words, read on every master pass. That is the room brief's size.
- **Why code is the wrong home:** a change to how masters work waits for a runner release and for
  every box to upgrade, so boxes on different versions teach different methods. Most of the text
  restates what core already serves: the act shapes and refusals of the `dispatch` and `issue-flow`
  guides, and the run declaration the box's own `--help` describes.
- **Target home:** the skill keeps the role, the goal and the situations a master meets ("when the
  nudge names FB-n…", "when a row waits on another issue's landing…", "when a person is owed a
  reply…"), one short line each, each ending in the guide that holds its method. The act shapes,
  bodies and refusal codes move to the `dispatch` guide (`packages/core/src/guides/dispatch-guide.ts`),
  which core serves at `GET /api/guides/dispatch.md`, so it changes with the core the box talks to.
- **What pins it today:** the twelve tests in `packages/runner/crates/runner-workspace/src/master_skill.rs`
  assert exact phrases and codes in the asset (`QUESTION_ABOUT_SHAPE`, `QUESTION_MERGE_IS_ORDERING`,
  `ARTIFACT_CARRIER_SHIPPED`, `RELEASE_VERSION_UNDECIDED`, `WORKFLOW_REPIN_PENDING_CHANGE`, the
  direct-mode and kernel lines). Each one moves to a test over the guide that takes its detail, and the
  skill's tests keep only the situations and the guide each one names.

### 2. The pipeline rules

- **Where it lives:** the `pipeline-rules` fact in `packages/core/src/prompt/facts/registry.ts:FORGE_FACTS`,
  rendered into every pipeline step's preamble (`packages/core/src/prompt/facts/mandatory-blocks.ts`).
- **Size:** 18 389 characters, 3 020 words, in every pipeline step's prompt, beside the 4 074-character
  affordances table.
- **Why code is the wrong home:** it restates the `pipeline-and-issue-lifecycle` and `issue-flow`
  guides (the status ladder, parks and `needs`, the merge stamp, blockers, branch discipline), so one
  rule has two texts that drift. "Capture Learnings" had already drifted from the curated-memory shape
  and was fixed by hand in ISS-1251. A change to it is a core deploy.
- **Target home:** a short map in the fact: one "when X, do Y" line per situation (the dispatch is
  your instruction; never background-and-exit; park only for what a person owes; stamp the merge only
  after you checked it; never speak for a human), each naming its guide. The detail stays in the
  served guides and nowhere else.
- **What pins it today:** `packages/core/src/prompt/facts/guidance-goals.test.ts` (16 cases, exact
  phrases such as "The status move is what advances the pipeline") and three cases in
  `packages/core/src/guides/direction.test.ts` that read the rendered fact. They move to the guides'
  tests, and the fact's test keeps the map and the guide each line names.

### 3. The run tool reference

- **Where it lives:** `packages/core/src/prompt/facts/drive-rules.ts:STEP_TOOL_REFERENCE_TEXT` and
  `packages/core/src/prompt/facts/drive-rules.ts:DRIVE_TOOL_REFERENCE_TEXT`, the "Reaching Forge"
  block of every pipeline step and drive run.
- **Size:** 6 881 and 7 178 characters.
- **Why code is the wrong home:** it is a list of doors ("the issue — `issues/<id>` to read …",
  "knowledge and memory — …"), not situations. It carries every question shape and refusal code in
  full, which the `issue-flow` guide already carries. ISS-1251 rewrote only its Forge-feedback line
  to a situation.
- **Target home:** one line per situation a run meets (before you build, read the issue and its
  edges; when the business must decide, ask on the requirement; when the work landed, stamp it; when
  a Forge door fails you, report it), each naming the route and the guide section. The bodies and
  refusal codes stay in `issue-flow`.
- **What pins it today:** `packages/core/src/prompt/facts/acts-taught.test.ts` (15 cases) asserts the
  question and merge shapes and their refusal codes inside these two texts. Its check that every code
  named is one core returns is still worth keeping; it moves to the `issue-flow` guide's text, which
  `packages/core/src/guides/acts-taught.test.ts` already reads.

## Order

1. The run tool reference first. It is the smallest and core-only, and the `issue-flow` guide already
   holds its detail.
2. The pipeline rules, in the same core release as or after the guide sections their lines point to.
3. The master skill last, because it needs a runner release: the new skill names guides the core it
   talks to must already serve, so core ships the guide sections first.

## Honest costs

| Cost | Who pays it |
|---|---|
| An agent reads a pointer and must fetch the guide to act, which is one more call per situation the first time; an agent that skips the fetch acts on the one-line situation alone | every master and run, in turns and tokens |
| A served guide changes with core, so a box on an old runner reads a skill naming guide sections an old core may not serve; the order above holds that only if core ships first | whoever cuts the runner release |
| Moving the exact-phrase checks to the guides' tests means no red test says an agent never fetched the guide; a skipped fetch shows only where the door-use read counts guide reads, and nowhere else | the Audit, which reads what runs used |
| Three texts are rewritten at once in tone and placement, so a lesson or a project rule quoting their old wording reads stale until it is re-checked | the lessons steward and project owners |
