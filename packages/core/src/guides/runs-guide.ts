import { RUN_STUCK_AFTER_MS, SESSION_SILENCE_REAP_MS } from '@forge/contracts/run-standing';
import type { CoreGuide } from './types.js';

const STUCK_MIN = RUN_STUCK_AFTER_MS / 60_000;
const REAP_MIN = SESSION_SILENCE_REAP_MS / 60_000;

export const RUNS_AND_MASTERS_GUIDE: CoreGuide = {
  slug: 'runs-and-masters',
  audience: 'agent',
  title: 'Runs and the project master: standing, holder, waits and stuck',
  summary:
    'How core reads where every run stands (queued, claimed, running, waiting on a person or a gate, stuck, done, failed, cancelled, handed back), who holds it and until when, what it waits on, why it reads stuck, and what the project master is doing.',
  version: 1,
  body: `## Runs and the project master

A run is one pipeline run of a project: an issue run, a release, a deploy or a job with no issue. A chat's
one-shot run and a master's own run are not runs here; the list names how many it leaves out and why.
\`forge_runs\` is the door (\`list\`, \`get\`), and \`GET /api/projects/:id/runs/standing\` and
\`/runs/standing/:runId\` serve the same read. \`forge_masters\` (\`standing\`, \`passes\`) answers what the
project master is doing. Every fact is derived by core from the rows it holds; no screen derives one.

### States
- \`queued\`: admitted, nothing has taken it. It waits on the master, or on the machine while every slot is in use.
- \`claimed\`: one holder took it and has not started.
- \`running\`: its root beats.
- \`waiting_person\`: a named person owes the next act (a question, a pause only a person clears, a hold
  that does not resume itself, a release approval). The wait names who, the act and since when.
- \`waiting_gate\`: a gate that clears without a person. \`resumesAt\` is the gate's own deadline, or null
  when it has none, never a guess.
- \`stuck\`: live by its status, and nothing moves it (below).
- Final: \`done\`, \`failed\` (with a cause, \`unclassified\` when none was recorded), \`cancelled\` (with the
  actor who stopped it), \`handed_back\` (the work went back; the next attempt is a new run).

A run's \`holder\` names who holds it and \`expiresAt\` with \`expirySource\`: the claim's renewal window,
a deploy lock's expiry, or the silence reap. Every candidate expiry is listed in \`holder.expiries\`.

### Stuck
\`stuck\` is the early, reversible signal: \`{rule, since, evidence, failsAt, failsBy}\`, with
\`evidence\` naming the one row the rule stands on (\`table\`, \`id\`, \`column\`). Rules:
- \`silent\`: no live job, and no sign of life for more than ${STUCK_MIN} min.
- \`lease_expired\`, \`lease_abandoned\`: the claim on its issue lapsed or stopped beating while the run is live.
- \`disagreement\`: the box and core disagree (\`box-live-core-terminal\`, \`box-exited-core-running\`), or
  the pipeline run is still live while its root ended (\`run-live-root-ended\`).
- \`stranded\`: the idle-issues sweep holds a stranded finding on its issue.
- \`overdue\`: a self-resuming gate, or a deploy lock, is past its own deadline by ${STUCK_MIN} min.

Stuck fails nothing. The reapers fail a silent run session or master at ${REAP_MIN} min, and \`failsAt\`
says when, or \`failsBy\` says that no silence reaper times the run out. A run that beats again reads
running again. A person wait is never stuck.

### The project master
\`forge_masters standing\` answers the master's state (\`in_pass\`, \`idle\`, \`silent\`, \`none\`), its open
pass, its last closed pass (dispatched, skipped with each refusal, parked) and its slots. \`passes\` pages
the stored passes newest first; read \`hasMore\` before calling a history complete.`,
};
