"use client";

import { useMemo, useState } from "react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  SegmentedControl,
  Select,
  SessionRowSkeleton,
} from "@/design";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { chatPath } from "@/features/shell/mode";
import { formatApiError } from "@/lib/api/error";
import { groupByRecency } from "../grouping";
import {
  type ListedConversation,
  useArchiveConversation,
  useConversationsAcrossProjects,
  useDeleteConversation,
  useRenameConversation,
} from "../hooks";
import { conversationTitle } from "../types";
import { ConversationRow } from "./conversation-row";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4"];
const ALL = "all";

type Scope = "project" | "ecosystem";

export const ECOSYSTEM_SCOPE_REFUSAL =
  "Chat is not served at ecosystem scope: every chat runs under one project, and its channel tool reaches the ecosystems that project is in. Pick the project to ask from.";

export function filterConversations(
  rows: ListedConversation[],
  opts: { projectId: string; search: string },
): ListedConversation[] {
  const term = opts.search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (opts.projectId === ALL || r.projectId === opts.projectId) &&
      (!term || conversationTitle(r).toLowerCase().includes(term)),
  );
}

export function ChatSidebar({
  slug,
  conversationId,
  onNavigate,
}: {
  slug: string | null;
  conversationId: string | null;
  onNavigate: (href: string) => void;
}) {
  const { projects } = useOrgScopedProjects();
  const projectIds = useMemo(() => projects.map((p) => p.id).sort(), [projects]);
  const [archived, setArchived] = useState(false);
  const list = useConversationsAcrossProjects(projectIds, archived);
  const [scope, setScope] = useState<Scope>("project");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(ALL);
  const [confirming, setConfirming] = useState<ListedConversation | null>(null);
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const rows = filterConversations(list.rows, { projectId: filter, search });
  const leave = (id: string) => {
    if (id === conversationId) onNavigate(chatPath(slug));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5" data-testid="chat-sidebar">
      <Button variant="primary" size="sm" icon="plus" onClick={() => onNavigate(chatPath(slug))}>
        New chat
      </Button>

      <div className="flex flex-col gap-1.5">
        <SegmentedControl<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: "project", label: "Project" },
            { value: "ecosystem", label: "Ecosystem" },
          ]}
        />
        {scope === "project" ? (
          <Select
            aria-label="Chat scope project"
            options={projects.map((p) => ({ value: p.slug, label: p.name }))}
            value={slug ?? ""}
            placeholder="Pick a project…"
            onChange={(s) => onNavigate(chatPath(s))}
          />
        ) : (
          <p role="note" data-testid="ecosystem-scope-refused" className="fg-caption text-muted">
            {ECOSYSTEM_SCOPE_REFUSAL}
          </p>
        )}
      </div>

      <Input
        aria-label="Search conversations"
        placeholder="Search conversations…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <Select
          aria-label="Filter by project"
          className="min-w-0 flex-1"
          options={[{ value: ALL, label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          value={filter}
          onChange={setFilter}
        />
        <Button
          variant={archived ? "secondary" : "ghost"}
          size="sm"
          icon="archive"
          aria-pressed={archived}
          aria-label="Show archived"
          onClick={() => setArchived((v) => !v)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.error != null && (
          <ErrorState
            title="Conversations could not be read"
            message={formatApiError(list.error)}
            onRetry={list.refetch}
          />
        )}
        {list.isLoading && (
          <div className="overflow-hidden rounded-lg border border-line">
            {SKELETON_ROWS.map((k) => (
              <SessionRowSkeleton key={k} />
            ))}
          </div>
        )}
        {!list.isLoading && list.error == null && rows.length === 0 && (
          <EmptyState
            title={archived ? "Nothing archived" : list.rows.length ? "Nothing matches" : "No conversations yet"}
            message={archived ? "Archived chats wait here." : "Start a chat and it shows up here."}
          />
        )}
        <div className="space-y-3">
          {groupByRecency(rows).map((bucket) => (
            <div key={bucket.key}>
              <div className="fg-overline px-1 pb-1 text-subtle">{bucket.label}</div>
              <div className="space-y-1">
                {bucket.rows.map((row) => {
                  const p = byId.get(row.projectId);
                  return (
                    <ConversationRow
                      key={row.id}
                      row={row}
                      project={p}
                      open={row.id === conversationId}
                      onOpen={() => onNavigate(chatPath(p?.slug ?? row.projectId, row.id))}
                      onRename={(title) => rename.mutate({ id: row.id, title })}
                      onArchive={(a) =>
                        archive.mutate({ id: row.id, archived: a }, { onSuccess: () => leave(row.id) })
                      }
                      onDelete={() => setConfirming(row)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title="Delete this conversation?"
        message={
          confirming
            ? `“${conversationTitle(confirming)}” and everything said in it will be gone. Archive it instead to keep it out of the way.`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!confirming) return;
          const id = confirming.id;
          remove.mutate(id, { onSuccess: () => leave(id) });
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
