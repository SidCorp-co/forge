"use client";

import { useMemo, useState } from "react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  Input,
  Menu,
  type MenuItem,
  SessionRowSkeleton,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useProjectEcosystems } from "@/features/ecosystem/hooks";
import { chatDraftPath, chatPath } from "@/features/shell/mode";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
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

type EcosystemScope = { slug: string; ecosystemId: string; name: string };

export type ConversationFilter =
  | { kind: "all" }
  | { kind: "project"; id: string; name: string }
  | { kind: "ecosystem"; id: string; name: string };

const EVERY_PROJECT: ConversationFilter = { kind: "all" };

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

export function ChatSidebar({
  slug,
  conversationId,
  onNavigate,
}: {
  slug: string | null;
  conversationId: string | null;
  onNavigate: (href: string) => void;
}) {
  // cm:why every project the person holds a role on, whatever org is active: a room is theirs to find wherever its project sits, and core still fences each read by role (ISS-34 F-4)
  const { data: allProjects } = useProjects();
  const projects = useMemo(() => allProjects ?? [], [allProjects]);
  const projectIds = useMemo(() => projects.map((p) => p.id).sort(), [projects]);
  const current = projects.find((p) => p.slug === slug);
  const ecosystemsQ = useProjectEcosystems(current?.id ?? "");
  const { ecosystems, note: ecosystemsNote } = ecosystemsReading(ecosystemsQ, current !== undefined);

  const [archived, setArchived] = useState(false);
  const list = useConversationsAcrossProjects(projectIds, archived);
  const [ecosystemScope, setEcosystemScope] = useState<EcosystemScope | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>(EVERY_PROJECT);
  const [confirming, setConfirming] = useState<ListedConversation | null>(null);
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();
  const pin = usePinConversation();

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const rows = filterConversations(list.rows, { filter, search });
  const filtered = filter.kind !== "all" || archived;
  const leave = (id: string) => {
    if (id === conversationId) onNavigate(chatPath(slug));
  };

  const startProject = (projectSlug: string) => {
    setEcosystemScope(null);
    onNavigate(chatPath(projectSlug));
  };
  const startEcosystem = (scope: EcosystemScope) => {
    setEcosystemScope(scope);
    onNavigate(chatDraftPath(scope.slug, scope.ecosystemId));
  };
  const scopeName = ecosystemScope?.name ?? current?.name;
  const startInScope = () =>
    ecosystemScope ? startEcosystem(ecosystemScope) : current ? startProject(current.slug) : onNavigate(chatPath(null));

  const scopeItems: MenuItem[] = [
    ...projects.map((p) => ({
      group: "Project",
      label: p.name,
      checked: ecosystemScope === null && p.slug === slug,
      onSelect: () => startProject(p.slug),
    })),
    ...(ecosystemsNote ? [{ group: "Ecosystem", label: ecosystemsNote, disabled: true }] : []),
    ...ecosystems.map((e) => ({
      group: "Ecosystem",
      label: e.name,
      checked: ecosystemScope?.ecosystemId === e.id,
      onSelect: () => current && startEcosystem({ slug: current.slug, ecosystemId: e.id, name: e.name }),
    })),
    {
      group: "With other people",
      label: "Start a room with other people…",
      icon: "users",
      onSelect: () => {
        setEcosystemScope(null);
        onNavigate(chatPath(null));
      },
    },
  ];

  const filterItems: MenuItem[] = [
    {
      group: "Show conversations from",
      label: "Every project",
      checked: filter.kind === "all",
      onSelect: () => setFilter(EVERY_PROJECT),
    },
    ...projects.map((p) => ({
      group: "Show conversations from",
      label: p.name,
      checked: filter.kind === "project" && filter.id === p.id,
      onSelect: () => setFilter({ kind: "project", id: p.id, name: p.name }),
    })),
    ...ecosystems.map((e) => ({
      group: "Ecosystem",
      label: e.name,
      checked: filter.kind === "ecosystem" && filter.id === e.id,
      onSelect: () => setFilter({ kind: "ecosystem", id: e.id, name: e.name }),
    })),
    { group: "Other", label: "Archived", icon: "archive", checked: archived, onSelect: () => setArchived((v) => !v) },
  ];
  const filterLabel = [filter.kind === "all" ? null : filter.name, archived ? "archived" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5" data-testid="chat-sidebar">
      <div className="flex" data-testid="new-chat">
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          className="min-w-0 flex-1 rounded-r-none"
          onClick={startInScope}
        >
          <span className="truncate">{scopeName ? `New chat · ${scopeName}` : "New chat"}</span>
        </Button>
        <Menu
          align="right"
          trigger={
            <Button
              variant="primary"
              size="sm"
              aria-label="Choose where the new chat starts"
              className="h-full rounded-l-none border-l border-l-[rgba(255,255,255,0.35)] px-2"
            >
              <Icon name="chevronDown" size={15} />
            </Button>
          }
          items={scopeItems}
          triggerClassName="flex h-full"
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Input
            aria-label="Search conversations"
            icon="search"
            placeholder="Search chats"
            className="min-w-0 flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Menu
            align="right"
            trigger={
              <span className="relative inline-flex">
                <IconButton
                  icon="filter"
                  variant="secondary"
                  aria-label={filtered ? `Filter conversations, showing ${filterLabel}` : "Filter conversations"}
                  aria-pressed={filtered}
                  className={cn(filtered && "border-accent bg-accent-tint text-accent-text")}
                />
                {filtered && (
                  <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2 rounded-pill bg-accent" />
                )}
              </span>
            }
            items={filterItems}
          />
        </div>
        {filtered && (
          <div className="flex items-center gap-1.5 px-1" data-testid="active-filter">
            <span className="fg-caption min-w-0 flex-1 truncate text-muted">Showing {filterLabel}</span>
            <button
              type="button"
              className="fg-caption flex-none font-semibold text-link hover:underline"
              onClick={() => {
                setFilter(EVERY_PROJECT);
                setArchived(false);
              }}
            >
              Show all
            </button>
          </div>
        )}
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
