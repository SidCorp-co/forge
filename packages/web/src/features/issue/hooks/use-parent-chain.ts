'use client';

import { useQuery } from '@tanstack/react-query';
import { issueApi } from '../api/issue-api';

const MAX_DEPTH = 3;

export interface ParentChainEntry {
  id: string;
  displayId: string;
  title: string;
}

export interface ParentChainResult {
  chain: ParentChainEntry[];
  truncated: boolean;
}

export const parentChainKey = (issueId: string | undefined) =>
  ['issue', issueId, 'parent-chain'] as const;

export function useParentChain(issueId: string | undefined) {
  return useQuery<ParentChainResult>({
    queryKey: parentChainKey(issueId),
    enabled: !!issueId,
    staleTime: 30_000,
    queryFn: async () => {
      const chain: ParentChainEntry[] = [];
      let truncated = false;
      let cursor = issueId as string;
      for (let depth = 0; depth <= MAX_DEPTH; depth++) {
        const deps = await issueApi.getDependencies(cursor);
        const parentEdge = deps.incoming.find((e) => e.kind === 'parent');
        if (!parentEdge) break;
        if (depth === MAX_DEPTH) {
          truncated = true;
          break;
        }
        const parent = await issueApi.get(parentEdge.fromIssueId);
        chain.unshift({
          id: parent.id,
          displayId: parent.displayId,
          title: parent.title,
        });
        cursor = parent.id;
      }
      return { chain, truncated };
    },
  });
}
