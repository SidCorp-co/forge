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
import { useProjectEcosystems } from "@/features/ecosystem/hooks";
import { chatDraftPath, chatPath } from "@/features/shell/mode";
import { formatApiError } from "@/lib/api/error";
import { sidebarSections } from "../grouping";
import {
  type ListedConversation,
  useArchiveConversation,
  useConversationsAcrossProjects,
  useDeleteConversation,
  usePinConversation,
  useRenameConversation,
} from "../hooks";
import { conversationTitle } from "../types";
import { ConversationRow } from "./conversation-row";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4"];
const ALL = "all";

type Scope = "project" | "ecosystem";

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
  const pin = usePinConversation();
  const [ecosystemId, setEcosystemId] = useState<string | null>(null);

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const rows = filterConversations(list.rows, { projectId: filter, search });
  const leave = (id: string) => {
    if (id === conversationId) onNavigate(chatPath(slug));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5" data-testid="chat-sidebar">
      <Button
        variant="primary"
        size="sm"
        icon="plus"
        onClick={() => onNavigate(slug ? chatDraftPath(slug, scope === "ecosystem" ? ecosystemId : null) : chatPath(null))}
      >
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
        <Select
          aria-label="Chat scope project"
          options={projects.map((p) => ({ value: p.slug, label: p.name }))}
          value={slug ?? ""}
          placeholder="Pick a project…"
          onChange={(s) => onNavigate(chatPath(s))}
        />
        {scope === "ecosystem" &&
          (slug ? (
            <EcosystemPicker
              projectId={projects.find((p) => p.slug === slug)?.id}
              value={ecosystemId}
              onChange={(id) => {
                setEcosystemId(id);
                onNavigate(chatDraftPath(slug, id));
              }}
            />
          ) : (
            <p className="fg-caption text-muted">Pick the project the chat is asked from first.</p>
          ))}
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
          {sidebarSections(rows).map((bucket) => (
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
                      onPin={(pinned) => pin.mutate({ id: row.id, pinned })}
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

function EcosystemPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string | undefined;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const q = useProjectEcosystems(projectId ?? "");
  if (!projectId) return null;
  if (q.isError) {
    return (
      <p role="alert" className="fg-caption text-[color:var(--red-600)]">
        This project's ecosystems could not be read: {formatApiError(q.error)}
      </p>
    );
  }
  const active = (q.data?.memberships ?? []).filter((m) => m.document.state === "active" && m.ecosystem);
  if (q.data && active.length === 0) {
    return <p className="fg-caption text-muted">This project is an active member of no ecosystem.</p>;
  }
  return (
    <Select
      aria-label="Chat scope ecosystem"
      options={active.map((m) => ({ value: m.ecosystem?.id ?? "", label: m.ecosystem?.name ?? "" }))}
      value={value ?? ""}
      placeholder={q.isLoading ? "Reading ecosystems…" : "Pick an ecosystem…"}
      onChange={onChange}
    />
  );
}
