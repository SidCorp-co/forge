"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { Badge } from "@/design";
import { useProjectMembers } from "@/features/issues/hooks";
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

const People = createContext<ReadonlyMap<string, string>>(new Map());

/** Names the reader's project's members, each by display name or else email, for the lines inside it. */
export function PeopleNames({ projectId, children }: { projectId: string; children: ReactNode }) {
  const members = useProjectMembers(projectId);
  const names = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.userId, m.displayName ?? m.email])),
    [members.data],
  );
  return <People.Provider value={names}>{children}</People.Provider>;
}

const VIA: Record<Author["via"], string> = {
  master: "by its master agent",
  assistant: "through the assistant",
  web: "on the web",
  cli: "from the CLI",
};

function who(author: Author, me: string | undefined, people: ReadonlyMap<string, string>, party?: string): string {
  if (author.kind === "agent") return party ? `${party}'s master` : "an agent";
  if (author.id === me) return "you";
  return people.get(author.id) ?? `person ${author.id.slice(0, 8)}`;
}

/** Who wrote it and through what. A document written through the assistant says so plainly. */
export function AuthorLine({ author, label = "Written", party }: { author: Author; label?: string; party?: string }) {
  const me = useAuth().user?.id;
  const people = useContext(People);
  const named = author.kind === "agent" && party !== undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>
        {label} by {who(author, me, people, party)}
        {named ? "" : ` ${VIA[author.via]}`}
      </span>
      {author.via === "assistant" ? <Badge tone="cobalt">via assistant</Badge> : null}
      {author.kind === "agent" ? <Badge tone="neutral">agent</Badge> : null}
    </span>
  );
}

export function HoldLine({ hold, names }: { hold: ThreadHold; names: Names }) {
  const me = useAuth().user?.id;
  const people = useContext(People);
  const placed = hold.action === "hold" ? "Held" : "Released";
  return (
    <span className="break-words">
      {placed} by {who(hold.by, me, people)} {VIA[hold.by.via]} for {names(hold.side)}
      {hold.reason ? <>: “{hold.reason}”</> : null}
    </span>
  );
}
