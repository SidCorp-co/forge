# The ten `master-cleans-what-its-runs-leave` entries are deleted once the skill that carries the rule runs on their boxes

ISS-1392 moved the owner's cleanup rule into the skill every master reads,
`packages/runner/crates/forge-runner-core/assets/skills/forge-master/SKILL.md`, and the list of what a
run leaves into `references/what-a-run-leaves.md` beside it. The same issue asks for the ten
per-project knowledge entries that held the rule until then to be deleted. That half is not in the
change that adds the skill text, for two reasons that sit outside any diff here.

## Why the deletion is not in the same change

The credential a run in this repository holds sees only forge-dev, so it can neither list nor delete
another project's knowledge entry, and forge-dev itself holds none of the ten. The skill also ships
inside the runner binary, so the rule reaches a master only when a runner release carrying it is the
build that box's daemon runs, and the daemon takes a release on its own check. Deleting an entry
before that leaves that project's master with neither copy of the rule, on the one rule whose absence
let a box fill with debris for days.

## The deletion is owed once

The entry `master-cleans-what-its-runs-leave` is deleted from each of the ten projects that carry it
once the skill is installed in that project's master checkout by a build whose commit contains the
merge of ISS-1392. A daemon on that build is not enough: the install can be refused for a checkout
whose git tracks the skill or un-ignores `.claude/`, and such a checkout keeps the older skill
without the rule. `forge-runner status` prints, per project, what the last install did there; the
line reads `written by` or `already the asset of` the build that carries the merge, and
`git merge-base --is-ancestor` against that merge says whether it does. A project whose line reads
`NOT WRITTEN`, or names an older build, keeps its entry until it does not.

## Honest costs

- Until each box runs the new build, the rule exists twice on it, as the entry and as the skill, and
  an edit to one can drift from the other. The entry is the older copy and the skill wins.
- Ten deletions are ten acts in ten projects by someone who can see them, which is one more step that
  nothing in this repository will remind them of; the issue stays open for it.
- A project added after 2026-10-06 never had the entry, so it carries the rule from the skill alone
  and shows no gap; that is the case this change closes, not one it costs.
