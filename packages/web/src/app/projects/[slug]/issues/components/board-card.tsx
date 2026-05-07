'use client';

// ISS-42: full board card needs a port from forge-old that is part of the
// A1 issues-table/board work. The current Drizzle Issue shape no longer
// carries `agentStatus` / `documentId` so the legacy body would not type
// against `@forge/contracts`. Stub for now; restore as part of the A1
// follow-up that wires <IssuesBoardView> into <IssuesView>.
export function BoardCard(): null {
  return null;
}
