## Migrating a project onto the module taxonomy

For a project that already names its modules somewhere ELSE — a knowledge entry, a wiki page,
a `**Module:** billing` line agents were told to write on every issue — and now wants them as first
class `kind:"module"` labels with a primary per issue.

This runs against a DEPLOYED Forge over MCP or REST. It is not a repo change, and Forge ships no
command that does it for you: the mapping from an old convention to a taxonomy is a judgement, and
the pass below is the shape that keeps that judgement re-runnable.

### The two idempotency keys
Everything here rests on these. Get them wrong and a second run doubles the data.

| Pass | Key | Already-done test |
|---|---|---|
| Create the module | `(projectId, label name)` | a label with that exact name exists — if it is `kind:"label"`, PROMOTE it to `kind:"module"` rather than creating a second row under a different name |
| Attribute an issue | `(issueId, labelId, isPrimary)` | the issue's `labels[]` already has that entry with `isPrimary:true` |

Label names are not unique in the database. The name is the key **you** are choosing to treat as
one, which is why the promote-don't-duplicate rule above is not optional: create-if-absent keyed on
a name that already exists as a plain label leaves the project with two rows called `billing`, and
only one of them can ever be a primary.

### Pass 0 — dry run, reads only
Produce the whole plan before writing anything. Nothing in this pass writes.

1. Read the source of truth for the module list (the knowledge entry, the doc, whatever it is)
   and the project's existing labels (`forge_issues` filters, or `GET /api/projects/:id/labels`).
2. For each intended module, classify it: **absent** (will create), **exists as a plain label**
   (will promote), **exists as a module** (skip).
3. List every issue carrying the old tag. Classify each: **no primary** (will attribute),
   **primary already correct** (skip), **primary is a DIFFERENT module** (do not touch — that is a
   disagreement between the old tag and someone's deliberate choice, and it is a human's to settle).
4. Print the four counts: to-create, to-promote, to-attribute, conflicts. **Read them before the
   write pass.** A to-create count equal to the whole module list on a SECOND run means your name
   key is not matching — stop, do not write.

### Pass 1 — create the modules
Parents before children, so `parentId` has something to point at. A module's parent must itself be
a module in the same project, and the hierarchy must stay acyclic; Forge refuses the rest by code
(`PARENT_NOT_MODULE`, `CIRCULAR_HIERARCHY`, `INVALID_PARENT`). A refusal here is information —
it means your source list disagrees with itself. Do not work around it by flattening.

Colour is optional; a module created without one gets a stable colour derived from its name.

### Pass 2 — attribute the issues
For each issue in the to-attribute list, send the label set with the module as an object:

```
forge_issues.update({ documentId, labels: [{ labelId: "billing", isPrimary: true }, ...existing] })
```

`labels` REPLACES the set — read the issue's current `labels[]` and send it back WITH the module
entry, or you will silently strip every other label the issue had. That is the one way this pass
loses data, and it is not the migration doing it, it is a partial payload.

At most one entry may be primary, and it must be a module; both are refused rather than half-applied.

### What this migration must NOT do
- **Do not delete the old tags.** The `**Module:**` comment lines stay exactly where they are. They
  become dead weight, not a second source of truth, and leaving them costs nothing while deleting
  them destroys the only record of what the attribution was derived from.
- **Do not clear or re-point a primary somebody set by hand.** Conflicts are reported, not resolved.
- **Do not invent a module for an issue that has no tag.** An issue with no primary is a normal
  state. Forge requires no primary at any status.

### Verify
Re-run pass 0. On a clean migration it reports zero to-create, zero to-promote, zero to-attribute,
and the same conflict list as before. Spot-check one issue per module through
`forge_issues.get` → `labels[]` and confirm exactly one entry has `isPrimary:true`. Then check
the filter the taxonomy exists for: `forge_issues.list` with `filters.module` returns the issues
you attributed and nothing else.

### After the migration
Nothing else to switch on. A project whose labels include a `kind:"module"` row gets a
**Module attribution** section in every pipeline agent's system prompt automatically, naming its
modules and the `isPrimary` field — so new issues get attributed by the agents that work them, and
the old convention has no second half to maintain. A project with no module labels gets no such
section, which is why this migration is what turns the feature on.