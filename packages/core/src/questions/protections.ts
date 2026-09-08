// What core promises a box before that box is allowed to park without a process.
//
// Core and the runner deploy separately, so landing the reapers in the same
// commit as the first code that can park is necessary and not sufficient: a
// rolling deploy puts a new runner against an old core, whose `park-deadline`
// still reaps a park at residency and whose `answer-resume` answers it by
// dispatching a second job. The box therefore asks rather than assuming, and a
// version number is not the question — what it needs to know is which
// protections are RUNNING (ISS-964 criterion 27).

/**
 * The protections core owns, by name.
 */
// cm:guard exactly the protections CORE can observe about itself. `worktree-reap-ledger` is deliberately absent: that reaper is the runner's own code, and core advertising it would be core asserting something it cannot know. The runner requires all three and satisfies that one from its own build (`workspace/worktree_reap.rs`).
// cm:guard a name is added here only once the code behind it is in this build — `park-protections.test.ts` reads the source for each one, because an advertisement is a promise a box acts on by releasing its process, and a name with nothing behind it is worse than no advertisement at all.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/protections.rs — the runner requires ALL of its named set and treats absence, an empty list, a 404 and a transport error alike as "not available". Renaming a member here silently shuts the park on every box.
export const PARK_PROTECTIONS = ['park-exempt-residency', 'answer-resume-park'] as const;

export type ParkProtection = (typeof PARK_PROTECTIONS)[number];
