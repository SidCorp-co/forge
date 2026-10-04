"use client";

import { useMemo, useState } from "react";
import { EmptyState, ErrorState, SessionRowSkeleton } from "@/design";
import { useProjectEcosystems } from "@/features/ecosystem/hooks";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import type { ChatTarget } from "../dock-target";
import { type ListedConversation, useConversationsAcrossProjects } from "../hooks";
import { conversationTitle } from "../types";
import { ConversationSections } from "./conversation-sections";
import { type ConversationFilter, EVERY_PROJECT, ListFilterBar, NewChatButton } from "./conversation-list-bar";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4"];


export function filterConversations(
  rows: ListedConversation[],
  opts: { filter: ConversationFilter; search: string },
): ListedConversation[] {
  const term = opts.search.trim().toLowerCase();
  const { filter } = opts;
  return rows.filter(
    (r) =>
      (filter.kind === "all" ||
        (filter.kind === "project" ? r.projectId === filter.id : r.ecosystemId === filter.id)) &&
      (!term || conversationTitle(r).toLowerCase().includes(term)),
  );
}

function ecosystemsReading(q: ReturnType<typeof useProjectEcosystems>, hasProject: boolean) {
  if (!hasProject) return { ecosystems: [], note: "Open a project to reach its ecosystems" };
  if (q.isError) return { ecosystems: [], note: `Ecosystems could not be read: ${formatApiError(q.error)}` };
  if (!q.data) return { ecosystems: [], note: "Reading ecosystems…" };
  const ecosystems = q.data.memberships.flatMap((m) =>
    m.document.state === "active" && m.ecosystem ? [{ id: m.ecosystem.id, name: m.ecosystem.name }] : [],
  );
  return { ecosystems, note: ecosystems.length ? null : "This project is an active member of no ecosystem" };
}

export function ConversationList({
  projectId,
  conversationId,
  pageKey = null,
  onSelect,
}: {
  projectId: string | null;
  conversationId: string | null;
  /** The record the page under the dock shows (`REQ-1`), whose rooms are listed as This page. */
  pageKey?: string | null;
  onSelect: (target: ChatTarget) => void;
}) {
  // cm:why every project the person holds a role on, whatever org is active: a room is theirs to find wherever its project sits, and core still fences each read by role (ISS-34 F-4)
  const { data: allProjects } = useProjects();
  const projects = useMemo(() => allProjects ?? [], [allProjects]);
  const projectIds = useMemo(() => projects.map((p) => p.id).sort(), [projects]);
  const current = projects.find((p) => p.id === projectId);
  const ecosystemsQ = useProjectEcosystems(current?.id ?? "");
  const reading = ecosystemsReading(ecosystemsQ, current !== undefined);

  const [archived, setArchived] = useState(false);
  const list = useConversationsAcrossProjects(projectIds, archived);
  const [search, setSearch] = useState("");
  // cm:why the list opens on the project the dock is in; every project is one pick away in the filter
  const [picked, setPicked] = useState<ConversationFilter | null>(null);
  const filter: ConversationFilter =
    picked ?? (current ? { kind: "project", id: current.id, name: current.name } : EVERY_PROJECT);
  const rows = filterConversations(list.rows, { filter, search });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="conversation-list">
      <div className="flex flex-none flex-col gap-2 border-b border-line-subtle bg-surface px-3 py-2.5">
        <NewChatButton projects={projects} current={current} ecosystems={reading.ecosystems} ecosystemsNote={reading.note} onSelect={onSelect} />
        <ListFilterBar
          projects={projects}
          ecosystems={reading.ecosystems}
          current={current}
          search={search}
          onSearch={setSearch}
          filter={filter}
          picked={picked}
          onPick={setPicked}
          archived={archived}
          onArchived={setArchived}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-app">
        {list.error != null && (
          <ErrorState title="Conversations could not be read" message={formatApiError(list.error)} onRetry={list.refetch} />
        )}
        {list.isLoading && SKELETON_ROWS.map((k) => <SessionRowSkeleton key={k} />)}
        {!list.isLoading && list.error == null && rows.length === 0 && (
          <EmptyState
            title={archived ? "Nothing archived" : list.rows.length ? "Nothing matches" : "No conversations yet"}
            message={archived ? "Archived chats wait here." : "Start a chat and it shows up here."}
          />
        )}
        <ConversationSections
          rows={rows}
          projects={projects}
          current={current}
          pageKey={pageKey}
          conversationId={conversationId}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}
