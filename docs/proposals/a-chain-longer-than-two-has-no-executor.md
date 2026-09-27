# A release chain longer than two has no executor

ISS-1311 / ADR 0003 gave a project one ordered release chain. The column, the schema and the
database CHECK all accept up to eight entries, and `packages/core/src/release-batch/prompt.ts`
prints every entry and the crossing into it, in order. Nothing in this repository performs a
crossing: `packages/core/src/release-batch/plan.ts:releaseBranches` answers where a release starts,
where it lands, and whether it crosses anything at all, and ISS-1276 settled that **core writes no
release step for any project** — the release agent reads the procedure and does the work.

So a chain of three is *storable*, *readable* and *printed whole*, and whether both of its
crossings actually happen rests on an agent following a prompt. The half that would make it
checkable — the release skill — lives in `github.com/SidCorp-co/forge-plugin`, which no change in
this repository may edit and no gate here can see. That is why this is a line here rather than a
fix inside ISS-1311 or a new issue.

`0312` derives every chain from `release_model`, and that mapping produces at most two entries, so
no row it *creates* is a shape a release has not run before. That is a claim about the migration
and not about the fleet: a third entry arrives by a deliberate write afterwards, and this document
does not say whether one has. Read the current occupancy rather than assuming it:

```sql
SELECT slug, jsonb_array_length(release_chain) AS entries
  FROM projects WHERE jsonb_array_length(release_chain) > 2 ORDER BY slug;
```

An empty result is what "nobody pays today" below rests on, and it goes stale the moment somebody
writes a chain.

## What would close it

- The forge-plugin issue that moves its readers onto the chain — ADR 0003's amnesty condition — is
  the natural place to hand the release skill the whole chain and a step per edge.
- Until then, a reader of `plan.ts` takes `liveBranch` and `promotePlanned` as what they say: the
  last branch, and whether any edge is crossed. The path itself is `releaseChain`, which both the
  declaration and the prompt carry entire.

## Honest costs

| Choice | What it costs, and who pays |
|---|---|
| Leaving the column at eight entries with no executor for the middle ones | Somebody can declare a three-branch release this repository has never run, and finds out at their first release. The agent is the only thing standing between the declaration and a skipped crossing. Who pays is whoever writes the first three-entry chain, and the query above is how a reviewer finds out whether anyone has. |
| Capping the chain at two instead | The capability ADR 0003 was written for — a path the old enum could not express — goes away, and the cap has to be lifted again by the change that adds the executor. The owner of a three-environment project keeps spelling their release in prose. |
| Building the executor in core now | It contradicts ISS-1276, which removed core's release steps because they were wrong for every project that declares its own procedure. Core would compose a merge nobody asked it to compose, for a shape the migration creates for nobody. |
| Editing the release skill from this repository | It breaks the forge-plugin boundary CLAUDE.md names: the two repositories ship on different clocks, so the change lands where no gate here has seen it and no reviewer there asked for it. |
