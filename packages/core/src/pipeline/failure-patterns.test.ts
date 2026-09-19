import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failure-classifier.js';
import { causeForText } from './failure-patterns.js';

/*
 * ISS-1101 — the box's own never-started report has to arrive as a cause.
 *
 * `pool_jobs::never_started` (ISS-1096) sends this sentence to
 * `POST /jobs/:id/fail` when a pane's prompt was delivered and its agent never
 * reported submitting it. Without a rule it lands `unclassified`, which is the
 * state this issue found it in: the box names the condition honestly and core
 * throws the name away one hop later.
 *
 * The reap's own literal deliberately has NO rule, exactly as `queue_timeout`
 * and `heartbeat_timeout` have none: a session reason reaches the job axis
 * through `jobs/session-lost-cause.ts`, which maps everything but
 * `park_unanswered` to `session_lost` — a member of `SYNTHETIC_REAP_ERRORS`, so
 * the mirror back cannot overwrite the session's own diagnosis. A round-trip
 * test written here for it was asserting a path the design does not have.
 */
describe('a pane whose prompt was never submitted (ISS-1101, pairing with ISS-1096)', () => {
  // cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/daemon/turn_evidence.rs — `never_started_reason` builds this string; it is pasted here whole rather than paraphrased, because a rule written against a paraphrase passes this test and misses the sentence the box actually sends.
  const NEVER_STARTED =
    "the job's pane `forge-job-3d93cbab` was opened and its prompt delivered, but the agent " +
    'never reported submitting it, or anything else, in 120s — tmux accepted the keystroke and ' +
    'no turn ever began, so this box never had work in flight to report';

  it("classifies the box's never-started sentence rather than leaving it unclassified", () => {
    expect(classifyFailure({ error: NEVER_STARTED }).cause).toBe('turn_never_reported');
  });

  // cm:guard the rule needs BOTH clauses. "never reported submitting" alone would also read as a
  // claim about a turn that ended, and the delivery clause is what ties it to an untaken prompt.
  it('does not fire on half the sentence', () => {
    expect(causeForText('the agent never reported submitting anything')).not.toBe(
      'turn_never_reported',
    );
  });

  // cm:guard ORDER against `runner_unreachable`, whose `/dispatch not delivered/` sits one word from
  // this sentence's "its prompt delivered". Asserted as the outcome rather than as a position in the
  // table, because the table can be reordered without this line moving.
  it('is not read as a runner that never took the dispatch', () => {
    expect(causeForText(NEVER_STARTED)).not.toBe('runner_unreachable');
  });
});
