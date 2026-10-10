"use client";

import { createContext, type ReactNode, use } from "react";
import { Badge } from "@/design";
import { useProjectMembers } from "@/features/issues";
import { useProjects } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useAuth } from "@/providers/auth-provider";
import { useApiPage } from "../hooks";
import type { Author, ThreadHold } from "../types";

export type Names = (projectId: string) => string;

/** Project names this reader can know: its own projects, and the counterparties on its API page. */
export function useProjectNames(projectId: string): Names {
  const mine = useProjects();
  const page = useApiPage(projectId);
  const names = new Map<string, string>();
  for (const p of mine.data ?? []) names.set(p.id, p.slug);
  for (const c of page.data?.consumes ?? []) if (c.provider) names.set(c.provider.id, c.provider.slug);
  for (const p of page.data?.publishes ?? [])
    for (const c of p.consumers) if (c.project) names.set(c.project.id, c.project.slug);
  return (id: string) => names.get(id) ?? `project ${id.slice(0, 8)}`;
}

const PeopleContext = createContext<ReadonlyMap<string, string>>(new Map());

/** Names the reader's project's members, each by display name or else email, for the lines inside it. */
export function PeopleNames({ projectId, children }: { projectId: string; children: ReactNode }) {
  const members = useProjectMembers(projectId);
  const names = new Map((members.data ?? []).map((m) => [m.userId, m.displayName ?? m.email]));
  return <PeopleContext value={names}>{children}</PeopleContext>;
}

const via = (author: Author, t: Copy): string => t(`ecosystem.people.via.${author.via}`);

function who(author: Author, me: string | undefined, people: ReadonlyMap<string, string>, t: Copy, party?: string): string {
  if (author.kind === "agent") return party ? t("ecosystem.people.partyMaster", { party }) : t("ecosystem.people.anAgent");
  if (author.id === me) return t("ecosystem.people.you");
  return people.get(author.id) ?? t("ecosystem.people.person", { id: author.id.slice(0, 8) });
}

/** Who wrote it and through what. A document written through the assistant says so plainly. */
export function AuthorLine({ author, label, party }: { author: Author; label?: string; party?: string }) {
  const t = useCopy();
  const me = useAuth().user?.id;
  const people = use(PeopleContext);
  const named = author.kind === "agent" && party !== undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span>
        {label === undefined
          ? t("ecosystem.people.writtenBy", { who: who(author, me, people, t, party) })
          : label
            ? t("ecosystem.people.labelBy", { label, who: who(author, me, people, t, party) })
            : t("ecosystem.people.by", { who: who(author, me, people, t, party) })}
        {named ? "" : ` ${via(author, t)}`}
      </span>
      {author.via === "assistant" ? <Badge tone="cobalt">{t("ecosystem.people.viaAssistant")}</Badge> : null}
      {author.kind === "agent" ? <Badge tone="neutral">{t("ecosystem.people.agent")}</Badge> : null}
    </span>
  );
}

export function HoldLine({ hold, names }: { hold: ThreadHold; names: Names }) {
  const t = useCopy();
  const me = useAuth().user?.id;
  const people = use(PeopleContext);
  const vars = { who: who(hold.by, me, people, t), via: via(hold.by, t), side: names(hold.side) };
  return (
    <span className="break-words">
      {hold.action === "hold" ? t("ecosystem.people.heldBy", vars) : t("ecosystem.people.releasedBy", vars)}
      {hold.reason ? <>: “{hold.reason}”</> : null}
    </span>
  );
}
