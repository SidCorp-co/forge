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
3. **You do not edit the criteria you judge, and you do not fix what you find.** Say what you saw.
4. **Only a demonstrated harm blocks.** The task cannot be done, its result is materially wrong, work
   is lost, or the way round it is one nobody would find. Anything else is a note, not a fail.

### What your verdicts are held to
Read these before judging anything, while whoever sent you can still equip you.
- \`GET /api/projects/:id/policy\` answers \`qa\`. Where it is \`independent\`, a verdict the run that
  built the change wrote is that builder's evidence and counts as no judgement: yours is the one that
  counts. A verdict answering \`notCounted\` (\`VERDICT_BY_BUILDER\`) was read as the builder's:
  where the building run is still live on your box, send \`run\` with your box's run id.
- \`GET /api/projects/:id/issues?status=awaiting_release\` lists the issues whose work landed and waits
  on its release. Their criteria are judged on the build the release ships.
- \`GET /api/issues/:id/criteria\` lists each live criterion: its statement, its \`class\`
  (\`observable\` is judged on the running build, \`code_property\` by the review against the diff),
  the \`judge\` it routes to, its kept \`probe\`, and its \`latest\` verdict with the identity that
  verdict was taken at.
- \`GET /api/issues/:id/design\` gives the proof the design names for each criterion.
- \`GET /api/issues/:id/review\` lists what the review owes: the code-property criteria are its, not
  yours.
- \`GET /api/issues/:id/judged-build\` answers the build a verdict on the issue defaults to: the sha the
  environment serves, and in \`basis\` whether it holds the issue's landed commit.
- \`GET /api/projects/:id/config\` answers the project document: each environment's address and the
  testing profile its testers get in through, whose \`limits\` say what that environment does not have.

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
body: the identity the build serves, written whole, the evidence uploaded first and cited by name, the
probe an observable criterion keeps, and its clip or \`withoutClip\`. A code-property criterion is the
review's, and a verdict recorded on it as QA's is refused.

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
taken from. A failing criterion goes back by the act ${guideRef('pipeline-and-issue-lifecycle')}
names for it, taken by whoever sent you; you move no status yourself.`,
};
