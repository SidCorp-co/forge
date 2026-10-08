/**
 * ISS-1126 — the `forge_issues` tool description, as its own module.
 *
 * It is 57 lines of prose that nothing in the factory reads, and while it sat inside the factory's
 * arrow it counted against both of `check-size-budget`'s frozen numbers for `forge-issues.ts` — so
 * correcting a sentence in it made that gate red for a reason having nothing to do with the
 * sentence. Moved here; the text is this tool's contract with every agent that calls it, and this
 * is the one place it is written.
 *
 * It takes the ref clause rather than importing it, so this module holds prose and nothing that
 * reads a registry.
 */

export function forgeIssuesDescription(refClause: string): string {
  return (
    `Issues and their tasks; every sub-action is in the action enum. ${refClause}\n` +
    'READING. list returns a summary projection - it omits the five heavy fields the fields ' +
    'enum names - to stay under the response token cap; get returns the full body. ' +
    'filters.issue and filters.taskStatus belong to listTasks - list REFUSES them, use get. ' +
    'Triage with list, get only the one issue you are about to work, and never re-get a body ' +
    'already loaded this session; after a lean forge_step_start manifest (bodyTruncated:true) ' +
    'pull just the fields:[...] you need. Read hasMore before calling any count complete: a ' +
    'list cut short by your own limit looks exactly like a complete one. truncated/truncatedBy ' +
    'name the cap that bit.\n' +
    'CREATE. Fill title, description, priority, category. plan and acceptanceCriteria are the ' +
    "clarify/plan steps' output - pre-filling them deletes that step's reason to exist (red " +
    'flag: plan-by-hand). description is a requirements contract (outcome, business rules, ' +
    'invariants, out-of-scope), not an implementation script: file paths, endpoints and ' +
    '"follow the pattern at <path>" go stale and outrank live exploration. Body shape: guides ' +
    'pipeline-and-issue-lifecycle and writing-an-issue; mermaid fences render; ATTACH .html ' +
    'rather than pasting it.\n' +
    'FILTERS. search: an issue key (ISS-42, 42, or a prefix this project holds; `ISS 42`, ' +
    '`#42`, a pasted `(ISS-42),` and a key with an en dash or a zero-width character read the ' +
    'same) answers that one row or is refused as `<ISSUE_KEY_* code>: <sentence>`, and so is a ' +
    'key under a prefix another project holds; several keys each carrying a prefix or a `#` ' +
    '(`ISS-42 ISS-43`) answer every one of them, or refuse the whole for the one this project ' +
    'does not hold; the address of an issue page answers that issue, or is refused by the same ' +
    "codes where it is another project's or nobody's; a number in double quotes, and several " +
    'bare numbers, are searched as text; ' +
    'anything else is a literal substring or identifier-split token over ' +
    'title/description/plan/acceptanceCriteria, with matchedFields naming which matched per ' +
    'row, so a clause cited only on a criterion is findable. label/module: a name or uuid or ' +
    'an array of either (OR); an unknown name returns an EMPTY set, and module matches MODULE ' +
    'labels only.\n' +
    'LABELS. data.labels takes label NAMES or UUIDs from this project; unknown ones are ' +
    'refused, never auto-created. On update it is a REPLACE-SET, not additive: [] clears all, ' +
    'omitting it changes none. Read the current labels[] off a FULL get before a delta, or you ' +
    'clobber the set. A module is a label with kind:"module", and each labels[] entry reports ' +
    'kind and isPrimary. Set the primary module by sending { labelId, isPrimary: true } among ' +
    'the plain strings - at most one, and it must be a module, or the whole write is refused. ' +
    'A new primary replaces the old atomically; omit isPrimary everywhere for none.\n' +
    'RELATIONS. data.relations applies on create AND update and works with a personal access ' +
    'token; for a kind its own enum does not list, use forge_project_pm set_dependency. Send ' +
    'exactly one of dependsOnId (THIS issue is blocked BY it) or blocksId (THIS issue blocks ' +
    'it). Edges commit before the dispatch trigger, so nothing dispatches ahead of its ' +
    "blocker, and the reply's relations[] confirms each edge. Re-send an edge with validUntil " +
    'in the past to RETRACT it (updated:true). A blocks relation may carry holdsUntil: ' +
    '"settled" (the default: released once the blocker is developed or past) or "shipped" ' +
    '(released only once the blocker is closed, for a dependency that must wait on a publish); ' +
    "omitting it keeps today's reading, and shipped on a relates relation is refused. get returns " +
    'relations.blocks (this blocks them) and relations.blockedBy (they block this), each ' +
    'reporting its holdsUntil and flagged expired when its validUntil has passed and it no ' +
    'longer gates dispatch.\n' +
    'TRANSITION. on_hold is a deliberate pause, waiting parks the issue for human review, and ' +
    'closed means the work shipped: a close on an issue with no merged_at is refused ' +
    '(CLOSE_REQUIRES_SHIPPED), and work that turned out not to be work leaves by dropped. On an ' +
    'issue whose landingShape is outside_git the close also needs the mark to name where it ' +
    'landed, and a bare merged_at is refused the same way. A transition answers rewritten: null, ' +
    "or, where a rule stored another status than the one asked (an agent's waiting stored as " +
    "needs_info on an autonomous project, an agent's closed held at awaiting_release by the " +
    'release gate), rewritten { requested, stored, rule: autonomous_driver | release_gate, ' +
    'waitingKind { sent, stored }, detail }; update answers it whenever it moved the status.\n' +
    "LANDING SHAPE. get and every write's answer carry landingShape (git | outside_git), the one " +
    "field saying where THIS issue's work lands and so what its mark and close accept, and " +
    "declaredLandingShape, the issue's own declaration, null where its project's kind answers " +
    '(website = outside_git). update takes data.landingShape - git, outside_git, or null to hand ' +
    "it back to the project - for a change that lands no file in a git project's repository, " +
    "such as a deployment's settings and a redeploy; mark it with data.landing then, and that " +
    'mark is its work evidence for developed and testing. Refused LANDING_SHAPE_MARK_STANDS ' +
    'while a mark stands, since the mark was judged on the lane it was made under: unmark first.\n' +
    'MERGE MARK. mark_merged (data.issueId, data.target - required except on an outside_git issue - ' +
    'optional data.commit / data.landing / data.mergedAt ISO / data.note) stamps merged_at. The ' +
    'first mark stands: a landing sent over a standing mark is refused MARK_ALREADY_STANDS naming ' +
    'what stands, and unmark then mark is the correction. data.landing is the live URL, CMS entry or ' +
    'storefront resource the work now is, required on an outside_git issue unless Forge observed a ' +
    'merged pull request (LANDING_REQUIRED) and refused on any other (LANDING_NOT_THIS_SHAPE); ' +
    'it is stored in merged_landing and the mark reads landed. It writes merged_commit_sha ONLY from a ' +
    'record Forge holds itself: a pull request it saw merged, or - for an agent on a git issue ' +
    'whose issue holds no branch, handoff or merged commit, i.e. work landed on the base branch ' +
    "itself - the data.commit it checked against the project's repository: resolved there, " +
    'declaring this issue in its subject, and contained in the base or live branch, else refused ' +
    'COMMIT_NOT_IN_REPOSITORY, COMMIT_NOT_THIS_ISSUE or COMMIT_NOT_LANDED - ' +
    'except that wherever Forge cannot verify the commit (the project declares no way to read its ' +
    'repository, the reader it has fails, or no base branch is named) the mark is accepted as ' +
    'asserted and the commit is kept in mergedClaimedCommit as a claim Forge did NOT verify, which ' +
    'counts as the work evidence, the answer naming the cause and the setting that fixes it; ' +
    'mark again once the repository can be read and Forge checks the claim, upgrading it to ' +
    'observed or refusing it by name. ' +
    'Anywhere else your commit never reaches the column: it ' +
    'reaches the audit trail as YOUR CLAIM, and on a git issue only once the repository ' +
    'resolves it, recorded by the full sha it resolves to - refused COMMIT_NOT_IN_REPOSITORY ' +
    'where the repository holds no such commit, and COMMIT_UNVERIFIED where it cannot be read, ' +
    'in which case mark naming no commit. A person marking with data.commit is held to this: ' +
    'COMMIT_UNVERIFIED stands for a person. The answer, and every row this tool returns, ' +
    'carries mark/mergeMark (observed | landed | asserted | unmarked) plus detail - observed means ' +
    'Forge witnessed the merge itself, asserted means it witnessed none and took your word ' +
    "for it. Marking unblocks nothing: a blocks edge is released by the blocker's STATUS " +
    '(ISS-1100) and no dispatch decision reads merged_at. target is an audit label. unmark ' +
    'clears both columns when a merge is rolled back, and is refused on a closed issue: ' +
    'move it off closed first.\n' +
    'ARCHIVE. An archived issue is out of list, search, memory recall and the alike check, and ' +
    'still answers get by key with archivedAt set. archive/unarchive (project admin) take ' +
    'archiveFilter { keys?, statuses?, seqBelow?, exclude? } - the intersection of what is ' +
    'given, minus exclude, keys or statuses required - and dryRun:true answers what it would ' +
    'touch and writes nothing. Only a closed or dropped issue with no live edge to unfinished ' +
    'work can be archived; anything else is refused by name and nothing is written. ' +
    'filters.includeArchived:true lists archived rows too. A transition or a new edge naming ' +
    'an archived issue is refused (ISSUE_ARCHIVED) until it is unarchived.\n' +
    'TASKS. createTask needs data.issueId + data.taskTitle; listTasks needs filters.issue and ' +
    'accepts filters.taskStatus; updateTask/deleteTask take the task UUID as documentId. Tasks ' +
    'inherit project membership from their issue.\n' +
    'ATTACHMENTS. Use forge_uploads (presigned URL) for anything past a tiny snippet; base64 ' +
    'in data.attachments[] is slow and burns context, though it still works for up to 10 tiny ' +
    'files (total <= UPLOADS_MAX_BYTES) and on partial failure returns attachments plus ' +
    'attachmentErrors (code/message).\n' +
    'The X-Forge-Project-Slug header sets the project; projectId only overrides it.'
  );
}
