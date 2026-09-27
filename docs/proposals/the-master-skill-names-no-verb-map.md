# The master skill names no verb map, because the guide it would point at does not exist yet

ISS-1274 asked for two things in
`packages/runner/crates/forge-runner-core/assets/forge-master-skill.md`, the default skill every
master reads when its project has set no `master-policy`. One of them landed: the paragraph saying
an idle pane while admissible work stands is a deviation the master owes a reason for. This page is
about the other one, which did not land, and about the cleanup the issue gave to whoever lands the
first.

## The pointer is owed and gated

The skill names three of the CLI's verbs and says nowhere where the rest are described. The issue's
answer is one line pointing at `forge guide master`. It also forbids that line until the guide
prints on a current CLI copy, because a pointer to a missing page sends a master to a refusal. On
2026-09-27 the installed copy, 3.36.313, answered `No guide named master`, and `plugin/guides/` on
forge-plugin's default branch held only `contract/` and `skills/`. The guide is forge-plugin
ISS-2592, which this repository cannot reach by diff.

**The change that adds the pointer** first confirms `forge guide master` prints on the installed
copy, then adds one line to the skill's section on what is the master's own, and deletes the
assertion in
`master.rs:the_skill_says_an_idle_pane_with_admissible_work_is_a_deviation` that refuses any
mention of `forge guide master`. That assertion is what goes red if the pointer lands without the
check.

## Three interim copies of the objective outlive their reason

The issue records copies of both halves in the `master-policy` fact of anhome, sid-desk and
mowment, each labelled as a duplicate, and asks whoever lands this to delete the objective half
from all three. Two things put that out of this change's reach. The credential that built it sees
only forge-dev, so it cannot read or write another project's fact. And the skill ships inside the
runner binary, so the objective reaches no running master until a runner release carries it and
those boxes run that release; deleting the copies before then leaves those masters with neither.

**The deletion is owed once** the daemon on the boxes serving those three projects reports a
version built from a commit that carries the paragraph. The verb-map half of each copy stays until
the pointer above lands.
