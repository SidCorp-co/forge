# forge-plan comment formats

Post these via `forge_comments → create` after Step 5 (plan written). Always English (see [`../../README.md` § English-only rule](../../README.md)).

## Normal plans (Simple / Medium / Complex atomic)

```markdown
**Plan** — <one-line summary of the approach>

**Affected files:** <count> files in <package(s)>
**Status:** <Auto-approved / Awaiting human approval>

The full plan has been written to the issue's plan field.
```

## Decomposed parents (Complex composite — see [decomposition.md](decomposition.md))

```markdown
**Decompose** — Split into <N> sub-issues:
- ISS-<id1>: <title>
- ISS-<id2>: <title>
- ISS-<id3>: <title>

**Rationale:** <one-line: why split, what each child owns>
**Dependencies:** <Independent | "ISS-X must merge first">

Children created at `on_hold` with scoped plans. Approve parent (`waiting → approved`) to cascade children to `approved` and start parallel coding.
```

## Author

The `forge_comments → create` data schema is strict — it does NOT accept an `author` field. The comment is automatically attributed to the calling principal (`device.ownerId` for MCP runners, `userId` for PAT/web).

## Posting order

Comment FIRST, then transition status. The transition is the **last** action — it triggers the next pipeline step, which will read the comment.
