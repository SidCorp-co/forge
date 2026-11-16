# The master skill, the pipeline rules and the run tool reference become a rendered map and cards

**Removed when:** the issue that renders these three texts from capability cards lands; until one is
filed, ISS-1251 carries this file, and the change that renders the last of them deletes it.

ISS-1251's design ("Forge ships capabilities without shipping their use") gives every agent-facing
capability one **card** kept beside the code of the door it describes: its owner, purpose, the
situations that call for it ("when you are … → do …"), best practice with one worked example, the
red flag agents actually hit, its audience and its replay scenarios. Every surface an agent reads is
**rendered** from the cards in two tiers:

- **Tier 0, the map**: one line per situation, "when X → capability Y", read every turn, within a
  budget per audience.
- **Tier 1, the card**: best practice, example and red flag, fetched when the situation arises
  (`forge_describe`, a guide page, a skill section).

Org knowledge `prompt-is-a-map` asks for exactly this: a few short always-on lines, detail fetched
on demand. The card type and its registry are being built in ISS-1251. The room brief in
`support/prompt.ts` is the first text rendered from them. This proposal covers the three texts that
teach masters and runs and are still written by hand in code. The forge-plugin half (its skills,
hooks and CLI help rendered from the same cards) is forge-plugin FB-87, not this repo's.

Each text below has the same three faults:

- It is a second copy of teaching that a card or a served guide also holds, so the two drift.
- Changing it takes a core deploy or a runner release.
- Tests pin its detail into the always-on text, so it cannot shrink to a map.

Sizes were measured on 2026-11-16 at the head of `fix/iss1251-teach-not-force`, in characters of
the composed text.

## The three texts

### 1. The forge-master skill

- **Where it lives:** `packages/runner/crates/runner-workspace/assets/forge-master-skill.md`, compiled
  into the runner binary (`packages/runner/crates/runner-workspace/src/master_skill.rs:ASSET`) and
  written into each master's checkout by `packages/runner/crates/runner-workspace/src/master_skill.rs:install`.
- **Size:** 33 330 characters (5 734 words), read on every master pass. That is the size of the room
  brief.
- **Why code is the wrong home:**
  - A change to how masters work waits for a runner release and for every box to upgrade, so boxes
    on different versions teach different methods.
  - Most of the text restates act shapes and refusal codes that the `dispatch` and `issue-flow`
    guides already carry. Those are exactly what the cards of those doors will hold.
- **Target:**
  - The skill keeps only what no card holds: the role, the goal and what a pass owes.
  - Its situations ("when the nudge names FB-n…", "when a row waits on another issue's landing…",
    "when a person is owed a reply…") become the Tier-0 map for the `master` audience. That map is
    rendered by core from the cards and read at run time (orientation or nudge), not shipped in the
    binary.
  - The act detail is the cards' Tier 1, reached through `forge_describe` or the guide page rendered
    from them.
  - The asset shrinks to a pointer at the map, so a teaching change needs no runner release.
- **What pins it today:**
  - The twelve tests in `packages/runner/crates/runner-workspace/src/master_skill.rs` assert exact
    phrases and codes in the asset: `QUESTION_ABOUT_SHAPE`, `QUESTION_MERGE_IS_ORDERING`,
    `ARTIFACT_CARRIER_SHIPPED`, `RELEASE_VERSION_UNDECIDED`, `WORKFLOW_REPIN_PENDING_CHANGE`, and
    the direct-mode and kernel lines.
  - Each test becomes a scenario on the card of the door it is about. The asset's tests keep only
    the role and the pointer.

### 2. The pipeline rules

- **Where it lives:** the `pipeline-rules` fact in `packages/core/src/prompt/facts/registry.ts:FORGE_FACTS`,
  rendered into every pipeline step's preamble (`packages/core/src/prompt/facts/mandatory-blocks.ts`).
- **Size:** 18 389 characters (3 020 words) in every pipeline step's prompt. The 4 074-character
  affordances table (`packages/core/src/prompt/facts/registry.ts:OPERATING_AFFORDANCES_TEXT`) sits
  beside it.
- **Why code is the wrong home:**
  - It restates the `pipeline-and-issue-lifecycle` and `issue-flow` guides: the status ladder,
    parks and `needs`, the merge stamp, blockers, branch discipline.
  - Its "Capture Learnings" section had already drifted from the curated-memory shape, and ISS-1251
    fixed it by hand.
  - A change to it is a core deploy.
- **Target:**
  - The affordances table, already "When you need / Use / Watch for", becomes the rendered Tier-0
    map for the `run` audience.
  - The rules become cards, under the doors they are about: the transition, the merge mark,
    `needs_info`, the worktree. Their red flags are lines like "background-and-exit", "speaking for
    a human" and "stamping before you checked".
  - What stays always-on is what no door owns, rendered to a few lines: the dispatch is your
    instruction, and nobody reads this terminal.
- **What pins it today:**
  - `packages/core/src/prompt/facts/guidance-goals.test.ts` (16 cases asserting exact phrases, such
    as "The status move is what advances the pipeline").
  - Three cases in `packages/core/src/guides/direction.test.ts` that read the rendered fact.
  - Both become the cards' scenarios and a budget test on the rendered map.

### 3. The run tool reference

- **Where it lives:** `packages/core/src/prompt/facts/drive-rules.ts:STEP_TOOL_REFERENCE_TEXT` and
  `packages/core/src/prompt/facts/drive-rules.ts:DRIVE_TOOL_REFERENCE_TEXT`, the "Reaching Forge"
  block of every pipeline step and every drive run.
- **Size:** 6 881 and 7 178 characters.
- **Why code is the wrong home:**
  - It is an inventory of doors ("the issue — `issues/<id>` to read …", "knowledge and memory —
    …"), not situations.
  - It carries every question shape and refusal code in full. A door's card holds those, and the
    `issue-flow` guide holds them again.
  - ISS-1251 rewrote only its Forge-feedback line into a situation.
- **Target:**
  - The block is deleted. Its situations join the `run` audience's Tier-0 map: before you build,
    read the issue and its edges; when the business must decide, ask on the requirement; when the
    work landed, stamp it; when a Forge door fails you, report it on its card.
  - Each door's shape, example and refusals are its card, fetched with `forge_describe` or read in
    the rendered guide.
- **What pins it today:**
  - `packages/core/src/prompt/facts/acts-taught.test.ts` (15 cases) asserts the question and merge
    shapes and their refusal codes inside these two texts.
  - Its check that every code it names is one core returns is still worth keeping. It becomes a
    registry check: every refusal a card names is in its door's refusal codes.

## Order

1. The run tool reference first. It is the smallest, core-only, and its doors' cards are the first
   the registry needs anyway.
2. The pipeline rules, once the cards of the transition, merge-mark and question doors exist.
3. The master skill last. It needs a runner release, and the map it points at must already be served
   by the core the box talks to, so core ships the map first.

## Honest costs

| Cost | Who pays it |
|---|---|
| An agent reads a map line and must fetch the card to act well, which is one more call per situation the first time; an agent that skips the fetch acts on the one-line situation alone | every master and run, in turns and tokens |
| A box on an old runner keeps its hand-written skill until it upgrades, so during the move two forms of the master's teaching are live: the old asset and the served map | whoever cuts the runner release; the order above keeps it to one release window |
| Exact-phrase tests become card scenarios replayed before a card changes, which are slower to run than a string assertion and need the replay corpus kept | the builder changing a card |
| A lesson or project rule quoting the old wording reads stale until it is re-checked or folded into the card that replaced it | the lessons steward and project owners |
