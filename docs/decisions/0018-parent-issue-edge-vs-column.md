# ADR 0018 — Parent issue: edge form is authoritative

**Status:** Accepted (2026-05-08)
**Related:** ISS-62

## Context

Parent links between issues are currently stored in two places:

- `issues.parent_issue_id` column (Drizzle `issues` table, `packages/core/src/db/schema.ts`). Set by `POST /issues` and `PATCH /issues` (`packages/core/src/issues/routes.ts`).
- `issue_dependencies` rows with `kind='parent'`, exposed via `GET /issues/:id/dependencies` and surfaced by the sidebar `IssueRelations` component on web and dev.

The two representations are not kept in sync by any constraint or trigger. The column is written only on issue create/patch; new parent assignments through the dependency-edge endpoint do not write back to the column. UI clients and `pm-graph` already read from the edge form for parent relations, alongside the other three kinds (`blocks`, `relates`, `duplicates`).

ISS-62 added a parent-chain breadcrumb at the top of the web issue detail page and needed to pick one source of truth.

## Decision

The `issue_dependencies` edge form (`kind='parent'`) is authoritative for parent links. The `issues.parent_issue_id` column is treated as a denormalized cache that may drift, and will be removed in a follow-up issue.

New parent assignments must go through the dependency-edge endpoint. UI surfaces (the breadcrumb in this ISS, plus the existing relations panel) read only the edge form.

## Reasons

1. Edges already model all four relation kinds uniformly (`blocks`, `relates`, `duplicates`, `parent`); the column only models parent. Picking the edge keeps the four kinds symmetric.
2. `IssueRelations` (web and dev) and `pm-graph` already read the edge form, so the column is not the actual source of truth for any UI today.
3. The column has no unique or FK-based enforcement against the edge table and is set in one code path only — drift is the norm rather than the exception.

## Consequences

- ISS-62's parent-chain UI walks `incoming kind='parent'` edges only.
- Future code paths that assign a parent must update edges. Code paths still writing the column should be deprecated alongside the column removal.
- A one-shot SQL backfill will be needed before dropping the column: insert `kind='parent'` edges for any `issues.parent_issue_id` row not yet represented in `issue_dependencies`. That backfill and the column drop are out of scope for ISS-62 and tracked as a separate follow-up.

## Alternatives considered

- **Keep the column as authoritative.** Rejected. Would require swapping `IssueRelations`'s parent grouping to read the column, which breaks parity with the other three kinds and forces a second read path on every consumer.
- **Keep both, add a trigger to sync them.** Rejected. The complexity does not buy anything: the only consumer of the column today is the create/patch path that writes it. Removing the column entirely is simpler than maintaining sync.
