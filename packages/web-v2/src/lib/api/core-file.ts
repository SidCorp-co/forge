"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { retryAt } from "@/lib/utils/retry-rule";
import { apiFile } from "./client";

const KEPT_FOR_MS = 5 * 60 * 1000;

/** One core file's bytes, read through the client and shared by every place that shows it. */
export function coreFileQuery(path: string) {
  return { queryKey: ["core-file", path], queryFn: () => apiFile(path), staleTime: KEPT_FOR_MS };
}

/**
 * A core file a page shows by itself, such as an image attachment, as an address only this page can load: its bytes
 * come through the client, so a refusal with a wait holds it, and it is read again once that wait is over (ISS-1229
 * r55, judge-170: an `<img src>` on the core went out again on every return and every reload, inside the wait).
 */
export function useCoreFile(path: string, enabled = true) {
  const q = useQuery({ ...coreFileQuery(path), enabled });
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) {
      setSrc(null);
      return;
    }
    const url = URL.createObjectURL(q.data);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [q.data]);
  useAskedAgainAfterTheWait(q.error, q.refetch);
  return { src, error: q.isError ? q.error : null };
}

/** A failed file read asked again once, when the server's wait ends, and never before. */
export function useAskedAgainAfterTheWait(error: unknown, refetch: () => unknown): void {
  const at = retryAt(error);
  useEffect(() => {
    if (at === null) return;
    const id = setTimeout(() => void refetch(), Math.max(0, at - Date.now()) + 5);
    return () => clearTimeout(id);
  }, [at, refetch]);
}
