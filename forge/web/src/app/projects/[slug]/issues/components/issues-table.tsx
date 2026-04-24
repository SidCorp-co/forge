'use client';

// Phase 2.6-F2: rich issues table (Pokemon sprites, inline selects, cost
// cells, bulk actions) depended on Strapi-only fields (complexity,
// aiSummary, agent sessions) + endpoints that have no core equivalent yet.
// IssuesView (components/issues-view.tsx) now renders a simpler list
// directly against the new Issue shape. This file remains for legacy
// imports and re-exports the lean list fallback.

export function IssuesTable() {
  return null;
}

export default IssuesTable;
