# A publish release carries landings nobody named

Left standing by ISS-1386 on purpose.

ISS-1386 reads what a release carries beyond its roster only on a chain that promotes by
`merge-branch`. There the range is two branch heads, `compare(live...start)`, and
`cut-range.ts:readRangeTo` reads it in full. Two shapes are not read. Each answers
`carried: { kind: 'not-read', why }` by name, so nobody takes either for a clean range:

- **A publish chain.** Its release builds and publishes whatever the start branch holds. There is no
  live branch to compare against, so the range would have to run from the last published commit,
  and Forge records no such commit for a publish target today. An issue landed on the start branch
  but parked at `needs_info` is published unnamed, exactly as ISS-1386 found on a promote chain.
- **A cherry-pick crossing.** The live branch receives copies, not the start branch's commits, so a
  landing sha is never in `live...start`. The range would have to be matched by patch identity, which
  nothing here computes.

There is a third gap on the promote chain itself. The release job is told the exact cut to promote
(`prompt.ts`), but `finish` does not read the range again. A job that promoted the branch head
instead of the cut ships whatever landed after the create, and nothing judges that.

What would close each one:

- **Publish:** record the commit each publish shipped (the release record already names one), and
  read `compare(<last shipped>...start)` against it.
- **Cherry-pick:** match landings by `git patch-id`, read through the binding.
- **Finish:** at finish, read `compare(cut...live)` from the run's `metadata.carried.cut`. Refuse a
  finish where that range holds a landing that was not in the batch's range, and name each one.

## Honest costs

Until then, a publish project and a cherry-pick project get the warning-shaped `not-read` and no
refusal. A promote job that ignores its cut is caught only by the issues' own judges, after the
release has shipped.
