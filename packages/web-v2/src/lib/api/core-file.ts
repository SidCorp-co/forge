"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CoreFiles } from "@/design/patterns/core-image";
import { retryAt } from "@/lib/utils/retry-rule";
import { apiFile } from "./client";

const KEPT_FOR_MS = 5 * 60 * 1000;

function coreFileQuery(path: string) {
  return { queryKey: ["core-file", path], queryFn: () => apiFile(path), staleTime: KEPT_FOR_MS };
}

/**
 * A core file shown by the page itself, such as an image attachment, as an address only this page can load. Its bytes
 * come through the client, so a refusal with a wait holds it and it is read again once that wait is over (ISS-1229
 * r55, judge-170: an `<img src>` on the core went out again on every return and every reload, inside the wait).
 */
export function useCoreFile(path: string, enabled: boolean) {
  const query = coreFileQuery(path);
  const q = useQuery({ ...query, enabled });
  const client = useQueryClient();
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
  useAskedAgainAfterTheWait(enabled ? q.error : null, q.refetch, () => client.getQueryState(query.queryKey)?.error);
  return { src, error: q.isError ? q.error : null };
}

/** The kit's reader of core files, which the app hands it. */
export const coreFiles: CoreFiles = { useFile: useCoreFile };

/** A failed file read asked again once its wait ends, never before. Every place showing it joins one ask, and one already
 *  answered is not asked again: `failedNow` is the read's failure as it stands then. */
export function useAskedAgainAfterTheWait(
  error: unknown,
  refetch: (options: { cancelRefetch: boolean }) => unknown,
  failedNow: () => unknown = () => error,
): void {
  const at = retryAt(error);
  const failed = useRef(failedNow);
  failed.current = failedNow;
  useEffect(() => {
    if (at === null) return;
    const id = setTimeout(() => {
      if (failed.current() === error) void refetch({ cancelRefetch: false });
    }, Math.max(0, at - Date.now()) + 5);
    return () => clearTimeout(id);
  }, [at, error, refetch]);
}
