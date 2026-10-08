"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDebounced } from "@/design/hooks/use-debounced";
import type { Command } from "@/design/patterns/command-palette";
import { issuesApi } from "@/features/issues/api";
import { issueKeyRefusalOf } from "@/features/issues/key-refusal";
import { formatApiError } from "@/lib/api/error";

export interface IssueSearchCommandDeps {
  /** The open project; outside one the box searches no issues. */
  projectId: string | undefined;
  slug: string | null;
  query: string;
  router: { push: (href: string) => void };
}

/**
 * The ⌘K box's issue search: the text goes to the project's issues search as typed, and what it
 * answers comes back as `search` commands, or as the sentence a refused key or a failed search carries. The server is
 * the only reader of a key, so `#1280` here finds what it finds on the issues screen (ISS-1334).
 */
export function useIssueSearchCommands({ projectId, slug, query, router }: IssueSearchCommandDeps): {
  commands: Command[];
  notice: string | null;
} {
  const text = query.trim();
  const asked = useDebounced(text, 200);
  const live = Boolean(projectId && slug && text);
  const found = useQuery({
    queryKey: ["issues", "lookup", projectId, asked],
    queryFn: () => issuesApi.lookup(projectId as string, asked),
    enabled: live && asked !== "",
    retry: false,
    staleTime: 30_000,
  });

  return useMemo(() => {
    if (!live) return { commands: [], notice: null };
    const answered = asked === text;
    const rows: Command[] = answered
      ? (found.data?.items ?? []).map((row) => ({
          label: `${row.displayId} · ${row.title}`,
          icon: "list",
          group: "search",
          onRun: () => router.push(`/projects/${slug}/issues/${row.id}`),
        }))
      : [];
    const searchIssues: Command = {
      label: `Search issues for “${text}”`,
      icon: "search",
      group: "search",
      onRun: () => router.push(`/projects/${slug}/issues?q=${encodeURIComponent(text)}`),
    };
    const failed = answered && found.error ? found.error : null;
    return {
      commands: [...rows, searchIssues],
      notice: failed
        ? (issueKeyRefusalOf(failed) ??
          `The issues search did not answer: ${formatApiError(failed)}`)
        : null,
    };
  }, [live, asked, text, found.data, found.error, router, slug]);
}
