# A release path of more than one promotion has no executor

**Removed when:** every promotion of a declared path is either performed and recorded, or refused by
name before release, which dev ISS-132 carries. The change that lands it deletes this file.

The project document (ADR 0004) lets production deploy from a branch reached by up to five
`promotions`, and `packages/core/src/release-batch/prompt.ts` prints every crossing in order.
Nothing in this repository performs a crossing: `packages/core/src/release-batch/plan.ts:releaseBranches`
answers where a release starts, where it lands, and whether it crosses anything at all, and ISS-1276
settled that **core writes no release step for any project** — the release agent reads the
procedure and does the work.

So a path of two promotions is *declarable*, *readable* and *printed whole*, and whether both
crossings actually happen rests on an agent following a prompt. The half that would make it
checkable — the release skill — lives in `github.com/SidCorp-co/forge-plugin`, which no change in
this repository may edit and no gate here can see. That is why this is a line here rather than a
fix or a new issue.

Read the current occupancy rather than assuming it:

```sql
SELECT p.slug, jsonb_array_length(d.document->'promotions') AS promotions
  FROM project_config_documents d JOIN projects p ON p.id = d.project_id
 WHERE jsonb_array_length(d.document->'promotions') > 1 ORDER BY p.slug;
```

An empty result is what "nobody pays today" below rests on, and it goes stale the moment somebody
declares a second promotion.

## What would close it

- The forge-plugin change that moves its readers onto the project document is the natural place to
  hand the release skill the whole path and a step per promotion.
- Until then, a reader of `plan.ts` takes `deploysFrom` and `promotePlanned` as what they say: the
  branch production deploys from, and whether any promotion is crossed. The path itself is the
  declaration's `path.crossings`, which the prompt carries entire.

## Honest costs

| Choice | What it costs, and who pays |
|---|---|
| Leaving the document at five promotions with no executor for the middle ones | Somebody can declare a three-branch release this repository has never run, and finds out at their first release. The agent is the only thing standing between the declaration and a skipped crossing. Who pays is whoever declares the second promotion, and the query above is how a reviewer finds out whether anyone has. |
| Capping the path at one promotion instead | A path the document can express goes away, and the cap has to be lifted again by the change that adds the executor. The owner of a three-environment project keeps spelling their release in prose. |
| Building the executor in core now | It contradicts ISS-1276, which removed core's release steps because they were wrong for every project that declares its own procedure. |
| Editing the release skill from this repository | It breaks the forge-plugin boundary CLAUDE.md names: the two repositories ship on different clocks, so the change lands where no gate here has seen it and no reviewer there asked for it. |
