# What a run leaves on the box

Read before the first removal of a pass. `SKILL.md` says what a fold owes and what is never removed;
this lists what there is to find, so a sweep does not miss a kind.

## One box, one day

On 2026-10-06 a box held forty-six worktrees (86 GB) for a project whose master had been gone for
days, thirty-five more (70 GB) for another, 880 docker volumes (124.8 GB reclaimable) most of them
anonymous volumes left by per-run test databases, 20 GB of run scratch, and the stopped judge
databases of issues long since folded. No report named any of it, because a run's report says what
it changed in the product and never what it made on the box.

## By kind

| Kind | Where it sits | It is that run's when |
|---|---|---|
| Worktree, with the build output inside it | under the checkout the run was cut from | the run's declaration names the tree, or the tree is named for an issue the run folded |
| Local branch | the checkout's own refs | it is the run's branch and its commits are on the remote or merged |
| Containers, volumes, networks | the container runtime | they carry the run's name, or an anonymous volume was last used by a container that did |
| Scratch directory | the one the run was given | it is the directory the run's brief named for it |
| Judge or test database left stopped | the container runtime | its name carries the issue key of a run already folded |

## What decides

A thing is removed when it is the folded run's and nothing live holds it. A thing whose owner cannot
be read from its name, its declaration or its brief is left alone and named in the pass: a wrong
removal cannot be undone, and a leftover can wait one more pass.
