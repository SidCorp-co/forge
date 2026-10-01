"use client";

import { useMemo } from "react";
import { Badge } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useAuth } from "@/providers/auth-provider";
import { useApiPage } from "../hooks";
import type { Author, ThreadHold } from "../types";

export type Names = (projectId: string) => string;

/** Project names this reader can know: its own projects, and the counterparties on its API page. */
export function useProjectNames(projectId: string): Names {
  const mine = useProjects();
  const page = useApiPage(projectId);
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const p of mine.data ?? []) names.set(p.id, p.slug);
    for (const c of page.data?.consumes ?? []) if (c.provider) names.set(c.provider.id, c.provider.slug);
    for (const p of page.data?.publishes ?? [])
      for (const c of p.consumers) if (c.project) names.set(c.project.id, c.project.slug);
    return (id: string) => names.get(id) ?? `project ${id.slice(0, 8)}`;
  }, [mine.data, page.data]);
}

const VIA: Record<Author["via"], string> = {
  master: "by its master agent",
  assistant: "through the assistant",
  web: "on the web",
  cli: "from the CLI",
};

function who(author: Author, me: string | undefined): string {
  if (author.kind === "agent") return "an agent";
  return author.id === me ? "you" : `person ${author.id.slice(0, 8)}`;
}

/** Who wrote it and through what. A document written through the assistant says so plainly. */
export function AuthorLine({ author, label = "Written" }: { author: Author; label?: string }) {
  const me = useAuth().user?.id;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>
        {label} by {who(author, me)} {VIA[author.via]}
      </span>
      {author.via === "assistant" ? <Badge tone="cobalt">via assistant</Badge> : null}
      {author.kind === "agent" ? <Badge tone="neutral">agent</Badge> : null}
    </span>
  );
}

export function HoldLine({ hold, names }: { hold: ThreadHold; names: Names }) {
  const me = useAuth().user?.id;
  const placed = hold.action === "hold" ? "Held" : "Released";
  return (
    <span className="break-words">
      {placed} by {who(hold.by, me)} {VIA[hold.by.via]} for {names(hold.side)}
      {hold.reason ? <>: “{hold.reason}”</> : null}
    </span>
  );
}
