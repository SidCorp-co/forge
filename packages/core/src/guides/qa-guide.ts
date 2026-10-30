// The judging method of the capability-guide registry: how a run sent to judge one issue somebody
// else built reads what it is held to, judges it on the running build and writes each verdict —
// over core's REST door alone. Same shape, same consumers as registry.ts.
//
// Altitude (NT1): the order of the reads and what a verdict counts for. The verdict body itself is
// the `issue-flow` guide's (section 5); this page points at it rather than restating it.

import { guideRef } from './guide-ref.js';
import type { CoreGuide } from './types.js';

export const QA_GUIDE: CoreGuide = {
  slug: 'qa',
  audience: 'agent',
  title: "Judging an issue's criteria on the running build",
  summary:
    'The method of a run sent to judge an issue somebody else built: the REST reads for what its verdicts are held to, where to start, the verdict history, how a criterion is exercised and recorded, and which design revision a design issue is judged on.',
  version: 1,
  body: `## Judging an issue's criteria on the running build

This is the method of a run sent to judge one issue somebody else built. It builds nothing, lands
nothing and moves no status. Every act below is a REST call; on a runner box \`forge-runner api <path>\`
makes it with the pane's credential, so a judge needs no other tool to follow this page.

### Four rules
1. **Judge what is running, not what was written.** Use the thing answering at the build you were
   sent to; read the code afterwards only to give a finding its location.
2. **Each verdict goes up the moment it is judged.** The verdicts are the one part of a judging run
   that outlives it. A set held back for one write at the end is lost with the run.
3. **You do not edit the criteria you judge, and you do not fix what you find.** Say what you saw;
   a criterion whose wording is wrong is said so in your verdict's reason, and corrected by whoever
   owns the issue (\`PATCH /api/issues/:id/criteria/:n\`, which keeps its verdicts).
4. **Only a demonstrated harm blocks.** The task cannot be done, its result is materially wrong, work
   is lost, or the way round it is one nobody would find. Anything else is a note, not a fail.

### What your verdicts are held to
Read these before judging anything, while whoever sent you can still equip you.
- A verdict the run that built the change wrote is that builder's evidence and counts as no
  judgement, whatever \`qa\` (\`GET /api/projects/:id/policy\`) says: yours is the one that counts.
  A verdict answering \`notCounted\` (\`VERDICT_BY_BUILDER\`) was read as the builder's: where the
  building run is still live on your box, send \`run\` with your box's run id. A run declared over an
  issue before its merge was recorded, at a status short of \`awaiting_release\`, is read as its
  builder, and the answer names that status: record the merge, move the issue on, and declare a new
  judge run. A run core has not
  admitted yet, its declaration still queued, writes no verdict: one naming it is refused
  \`VERDICT_SESSION_NOT_ADMITTED\` with the refusal it waits behind, and nothing is written.
- \`GET /api/projects/:id/issues?status=awaiting_release\` lists the issues whose work landed and waits
  on its release. Their criteria are judged on the build the release ships.
- \`GET /api/issues/:id/criteria\` lists each live criterion: its statement, its \`class\`
  (\`observable\` is judged on the running build, \`server_side\` on it from inside the running server,
  \`code_property\` by the review against the diff),
  the \`judge\` it routes to, its kept \`probe\`, its \`latest\` verdict with the identity that
  verdict was taken at, and its \`weighing\`: whether the gate that will decide the issue counts it
  (\`earned\`), its \`standing\`, the \`reason\`, and \`weighedOn\` — at the landing where a promotion
  stands before production, else at what is served (the \`environment\` judged on until release).
- \`GET /api/issues/:id/design\` gives the proof the design names for each criterion.
- \`GET /api/issues/:id/review\` lists what the review owes: the code-property criteria are its, not
  yours.
- \`GET /api/issues/:id/judged-build\` answers the build a verdict on the issue defaults to: the sha the
  environment serves, and in \`basis\` whether it holds the issue's landed commit. Where the project
  names its testing environment (\`delivery.judgedOn\`), that is the build that environment serves
  (\`source: judged-on\`), judged there as a \`runtime\` verdict at that commit.
- \`GET /api/projects/:id/config\` answers the project document: each environment's address and the
  testing profile its testers get in through, whose \`limits\` say what that environment does not have.
- \`GET /api/jobs/<run>/testing-profiles/<profile>/secrets\` answers the values behind that profile's
  \`secret://\` references, to log in with. A job sends \`self\`. A run a master declared reads under
  its box's credential with \`forge-runner api jobs/self/testing-profiles/<profile>/secrets\` from
  inside its own checkout, where the box sends the id of the run declared over that checkout in place
  of \`self\` and says so on stderr; from anywhere else it sends that run id as \`<run>\` itself. Core learns of a declared run on the box's next sweep,
  seconds after \`forge-runner run declare\`: a read before it is refused
  \`TESTING_SECRETS_RUN_NOT_RECORDED\`, and the same call answers once it has. Only the profile of the environment deploying the branch the
  issue's work landed on is answered, while the run runs; each read is audited on the issue and each
  value is scrubbed from what the run posts. Keep a value in no file, comment or commit.
- A session working for a person on a box, with no master to declare for it, gets a run from that
  person: someone holding project admin calls \`POST /api/projects/:id/review-runs\` with
  \`{ issue, box, profile, minutes? }\`, and the session reads that one profile under the box's
  credential (\`FORGE_BORROW_FROM=<runner config dir>/forge-runner/master/<slug>/forge-cli.json
  forge-runner api jobs/<runId>/testing-profiles/<profile>/secrets\`) until the run is closed at
  \`devices/me/run-sessions/<sessionId>/close\` or reaches its end (30 minutes unless named, 120 at most).

A criterion you have no route to is a \`skipped\` naming what is missing. Where every criterion you
were given would be one, say so and stop: a credential or a person is what was owed, not a run.

### Where to start
Read \`latest\` on each criterion. Judge the ones carrying no verdict, a \`skipped\`, or a verdict taken
at an identity other than the build you were sent to judge. A verdict already taken at that build
is a verdict, not a draft: judge it again only where it cites something other than what you were sent
to judge. A verdict recorded before the issue's latest reopen is evidence about an earlier build and
counts for nothing now.

### The verdict history
\`GET /api/issues/:id/events?kind=verdict\` lists every verdict ever written on the issue, each as a
record carrying its criterion, verdict, identity, reason (\`why\`), evidence, judge and probe, with
when it was written. The criteria read keeps only the latest per live criterion; its \`retired\` list
holds each criterion the plan reworded or removed, with every verdict it carried.

### Exercising a criterion
Work it the way the person in it would, the states they reach by accident included: the empty list,
the lapsed session, the field left blank, the second submit. A criterion exercised only down the path
that works has not been tested. Plant the failure the criterion guards against where you can, and
watch the probe go red before its green counts. A verdict is worth what its reader can re-run: the
steps, what you expected, what you observed. Captures go outside the checkout you are judging.

### Writing each verdict
\`POST /api/issues/:id/verdicts\` per criterion, as ${guideRef('issue-flow')} (section 5) gives the
body: the identity the build serves, written whole, the evidence uploaded first and cited by its name,
its id or its download URL, the
probe an observable criterion keeps, and its clip or \`withoutClip\`. A server-side criterion cites the
capture of what you ran inside the running server instead, and keeps no probe and no clip
(\`VERDICT_CAPTURE_REQUIRED\`, \`VERDICT_PROBE_SERVER_SIDE\`). A code-property criterion is the
review's, and a verdict recorded on it as QA's is refused. On a project that declares no production
environment nothing runs that Forge observes: the build is the commit \`judged-build\` names, its
identity is \`{ kind: 'commit', sha }\` at that commit, and a \`runtime\` identity there is refused
\`VERDICT_RUNTIME_UNOBSERVED\`.

### A design issue
A criterion judged against a design is written with
\`identity: { kind: 'design', workflow, revision }\`, \`workflow\` being the design's flow name or
uuid. It is judged against the newest approved revision of that design:
\`GET /api/projects/:id/workflows/:workflow/design\` names it as \`approvedRevision\`, and a later
revision standing proposed (\`proposedRevision\`), under this issue or another, is not it. Content that holds only on an unapproved
revision does not satisfy the criterion: the verdict taken at the newest approved revision is a
\`fail\` whose reason names the revision holding the content and that it waits on its approver. A
verdict naming the unapproved revision is refused \`VERDICT_DESIGN_UNAPPROVED\`. Where no revision of
the design was ever approved there is nothing to judge against: the verdict is \`skipped\`, naming
the revision that waits.

### When you are done
Report one line per criterion: its verdict, the build or revision it was taken at, and what it was
taken from. A \`fail\` you record sends an issue past its build back to \`reopen\` by itself, and the
correction is made there: file no new issue for it. You move no status yourself.`,
};
