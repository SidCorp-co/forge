'use client';

// Phase 2.6-F2: issue relations UI is deferred. Core's /api/issues/:id
// detail response currently returns empty `activity` + `comments` arrays and
// has no relations endpoint. The component renders nothing until relations
// land on forge/core.

export function IssueRelations() {
  return null;
}

export default IssueRelations;
