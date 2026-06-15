"use client";

import { useQuery } from "@tanstack/react-query";
import { docsApi } from "./api";

/** Project docs tree. Keyed `['docs','tree',projectId]`. */
export function useDocsTree(projectId: string | undefined) {
  return useQuery({
    queryKey: ["docs", "tree", projectId],
    queryFn: () => docsApi.tree(projectId as string),
    enabled: !!projectId,
  });
}

/** One doc's markdown. Keyed `['docs','content',projectId,path]`. */
export function useDocContent(projectId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: ["docs", "content", projectId, path],
    queryFn: () => docsApi.content(projectId as string, path as string),
    enabled: !!projectId && !!path,
  });
}

/** Forge's platform docs tree (global `/docs` nav). Keyed `['docs','platform','tree']`. */
export function usePlatformDocsTree() {
  return useQuery({
    queryKey: ["docs", "platform", "tree"],
    queryFn: () => docsApi.platformTree(),
  });
}

/** One platform doc's markdown. Keyed `['docs','platform','content',path]`. */
export function usePlatformDocContent(path: string | undefined) {
  return useQuery({
    queryKey: ["docs", "platform", "content", path],
    queryFn: () => docsApi.platformContent(path as string),
    enabled: !!path,
  });
}
