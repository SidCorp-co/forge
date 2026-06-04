'use client';

import { useQuery } from '@tanstack/react-query';
import { docsApi } from './api';

/** Project docs tree. Keyed `['docs','tree',projectId]`. */
export function useDocsTree(projectId: string | undefined) {
  return useQuery({
    queryKey: ['docs', 'tree', projectId],
    queryFn: () => docsApi.tree(projectId as string),
    enabled: !!projectId,
  });
}

/** One doc's markdown. Keyed `['docs','content',projectId,path]`. */
export function useDocContent(projectId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: ['docs', 'content', projectId, path],
    queryFn: () => docsApi.content(projectId as string, path as string),
    enabled: !!projectId && !!path,
  });
}
