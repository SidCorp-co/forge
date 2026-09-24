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
    'FILTERS. search: a literal substring or identifier-split token over ' +
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
    'in the past to RETRACT it (updated:true). get returns relations.blocks (this blocks them) ' +
    'and relations.blockedBy (they block this), each flagged expired when its validUntil has ' +
    'passed and it no longer gates dispatch.\n' +
    'TRANSITION. on_hold is a deliberate pause, waiting parks the issue for human review, and ' +
    'closed means the work shipped: a close on an issue with no merged_at is refused ' +
    '(CLOSE_REQUIRES_SHIPPED), and work that turned out not to be work leaves by dropped.\n' +
    'MERGE MARK. mark_merged (data.issueId, data.target, optional data.commit / data.mergedAt ' +
    'ISO / data.note) stamps merged_at. It writes merged_commit_sha ONLY where Forge already ' +
    'holds its own record of the merge - a pull request it saw merged - and the sha it writes ' +
    "there is that record's, never data.commit. Your commit never reaches the column: it " +
    'reaches the audit trail as YOUR CLAIM. The answer, and every row this tool returns, ' +
    'carries mark/mergeMark (observed | asserted | unmarked) plus detail - observed means ' +
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
