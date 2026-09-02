// What "autonomous" IS, with no dispatcher attached.
//
// Two domains ask these questions: the dispatcher enqueues by them, and
// `issues/apply-transition.ts` rewrites a status by them. So they live in a
// module with no runtime imports at all — `autonomous-dispatch.ts` reaches
// pg-boss through the enqueue helper, and a caller that only wants to ASK
// whether a project is autonomous must not boot the queue to find out.

import type { IssueStatus, JobType } from '../db/schema.js';
import type { PipelineConfig } from './pipeline-config-schema.js';

/** The status at which the driver is handed the issue. */
export const AUTONOMOUS_ENTRY_STATUS: IssueStatus = 'open';

/** The one park the driver may enter, and the only one a human answer restarts. */
// cm:edge lockstep -> packages/core/src/jobs/turn-verdict-routes.ts — the turn verdict asks the SAME question from the other end (may this session stay resident?), and the two answers must name one status: a verdict that parked elsewhere would hold a runner slot for a pause a human chose, and a resume that did would take that pause away from them.
export const AUTONOMOUS_QUESTION_STATUS: IssueStatus = 'needs_info';

// cm:guard S1 of the published standard, and the ONLY declaration of it. The driver writes a KERNEL status; `needs_human` / `done` / `running` are render labels from packages/contracts/src/issue-vocabulary.ts, nothing on the write path translates them, and a skill that names one hands the agent a value `forge_issues` rejects — which is how 27 parks landed on `waiting`, a status answer-resume.ts never wakes. Since ISS-886 an agent's `waiting` is rewritten to `needs_info` (issues/autonomous-park.ts) so those 27 are no longer reachable, but the rewrite is a net under this list, NOT a licence to widen it: it catches one status, and a skill naming any of the other labels still hands over a value the kernel rejects outright.
// cm:guard CROSS-REPO coupling, so no `cm:edge` can hold it: the other side is `plugin/skills/issue-flow/SKILL.md` in github.com/SidCorp-co/forge-plugin. the skill's status table must list exactly these. It lived in this repo under packages/runner/skills until 2026-09-02 and check-autonomous-transitions.mjs failed the build when the two diverged; the skill moved to a plugin, the gate had nothing left to read and was removed, and this line is what remains of that coupling. A status added here reaches the agent only when the plugin says it too.
export const AUTONOMOUS_DRIVER_STATUSES: readonly IssueStatus[] = [
  'open',
  'in_progress',
  'needs_info',
  'closed',
  'dropped',
] as const;

export const AUTONOMOUS_JOB_TYPE: JobType = 'drive';

// cm:guard this name reaches the agent ONLY as text in the drive prompt — nothing in core or the runner resolves it. Since 2026-09-02 the skill is delivered by the `forge` Claude Code plugin (github.com/SidCorp-co/forge-plugin), installed on a device when a bound project designates it in `pipelineConfig.plugins` AND that box has `[plugins] enabled = true`; a project missing either dispatches a driver that is told to use a skill it does not have. `skill_registrations` never resolves this name and must not start to.
export const AUTONOMOUS_SKILL_NAME = 'issue-flow';

// cm:guard the ONLY place the absent-`mode` default is decided, and it has three readers — `isAutonomous`, `skills/lock.ts` and `reconciler.ts` (which reads the raw SQL column, not the parsed config). A second copy of `=== 'autonomous'` anywhere is a project that dispatches under one driver while its skills lock under the other.
// cm:guard flipped from staged to autonomous on 2026-09-02, measured not assumed: of 31 live projects 28 said `autonomous` EXPLICITLY, 0 said `staged`, and the 3 that said nothing had 12 jobs between them with none since 2026-08-11. Staged was never a choice anyone made; it was the answer nobody gave. The price is named in `forge-drive/SKILL.md`: `assertAutonomousReady` gates the WRITE that sets this key, so a project carrying the default has answered no contract, and the guarantee that skill used to make about `build-commands`/`test-commands` no longer holds. Flipping back means restoring that guarantee, not just this literal.
export function resolveMode(mode: string | null | undefined): 'staged' | 'autonomous' {
  return mode === 'staged' ? 'staged' : 'autonomous';
}

// cm:guard `cfg === null` is a DISTINCT case from an absent `mode` and must stay one: null means the project is missing or its config did not parse, and answering `autonomous` there would rewrite parks and cascade children on a project nobody can see is broken. Absent `mode` means the project never said, which the default now answers. Collapsing the two — `resolveMode(cfg?.mode)` — silently makes an unparseable config autonomous.
export function isAutonomous(cfg: PipelineConfig | null): boolean {
  return cfg !== null && resolveMode(cfg.mode) === 'autonomous';
}

/** Where the driver's work ends and the issue run closes with it. */
export const AUTONOMOUS_TERMINAL_STATUSES: readonly IssueStatus[] = ['closed', 'dropped'] as const;

// cm:guard derived from the list above, never written by hand: a driver status that is not the entry, not the park and not terminal is one NO job is ever dispatched AT (`autonomousStepFor` returns a step only at the entry status), so an agent that stops there leaves the issue with no work behind it and nothing in core to re-enter — the ISS-890 wedge, measured on ISS-880 as 2h15m between a `done` drive job and a hand-close. Classifying a NEW driver status is therefore mandatory: leave it unclassified and it falls into this set, which is the safe direction — it gets watched rather than silently stranded.
// cm:edge lockstep -> packages/core/src/pipeline/reconciler.ts — `resetAutonomousWedgesOnce` selects on exactly these statuses; a status that belongs here but is excluded is a wedge no pass can see
export const AUTONOMOUS_INFLIGHT_STATUSES: readonly IssueStatus[] =
  AUTONOMOUS_DRIVER_STATUSES.filter(
    (s) =>
      s !== AUTONOMOUS_ENTRY_STATUS &&
      s !== AUTONOMOUS_QUESTION_STATUS &&
      !AUTONOMOUS_TERMINAL_STATUSES.includes(s),
  );
