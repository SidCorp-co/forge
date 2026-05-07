'use client';

import { useMemo } from 'react';
import { DEPENDENCY_KINDS, type DependencyEdge, type DependencyKind } from '../api/issue-api';
import { useIssueDependencies } from './use-issue-dependencies';

export interface RelationsGroup {
  outgoing: DependencyEdge[];
  incoming: DependencyEdge[];
}

export type RelationsByKind = Record<DependencyKind, RelationsGroup>;

const emptyGroups = (): RelationsByKind => ({
  blocks: { outgoing: [], incoming: [] },
  relates: { outgoing: [], incoming: [] },
  duplicates: { outgoing: [], incoming: [] },
  parent: { outgoing: [], incoming: [] },
});

export function useIssueRelations(issueId: string | undefined) {
  const query = useIssueDependencies(issueId);

  const groups = useMemo<RelationsByKind>(() => {
    const out = emptyGroups();
    if (!query.data) return out;
    for (const edge of query.data.outgoing) {
      if (DEPENDENCY_KINDS.includes(edge.kind)) out[edge.kind].outgoing.push(edge);
    }
    for (const edge of query.data.incoming) {
      if (DEPENDENCY_KINDS.includes(edge.kind)) out[edge.kind].incoming.push(edge);
    }
    return out;
  }, [query.data]);

  const total = useMemo(() => {
    let n = 0;
    for (const k of DEPENDENCY_KINDS) n += groups[k].outgoing.length + groups[k].incoming.length;
    return n;
  }, [groups]);

  return {
    groups,
    total,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
