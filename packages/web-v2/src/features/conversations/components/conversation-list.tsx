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
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { dockSections } from "../grouping";
import {
  type ListedConversation,
  useArchiveConversation,
  useConversationsAcrossProjects,
  useDeleteConversation,
  usePinConversation,
  useRenameConversation,
} from "../hooks";
import type { ChatTarget } from "@/features/chat-dock/dock-target";
import { conversationTitle } from "../types";
import { ConversationRow } from "./conversation-row";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4"];

type EcosystemScope = { projectId: string; ecosystemId: string; name: string };

export type ConversationFilter =
  | { kind: "all" }
  | { kind: "project"; id: string; name: string }
  | { kind: "ecosystem"; id: string; name: string };

const EVERY_PROJECT: ConversationFilter = { kind: "all" };

export function filterConversations(
  rows: ListedConversation[],
  opts: { filter: ConversationFilter; search: string; untitled?: string },
): ListedConversation[] {
  const term = opts.search.trim().toLowerCase();
  const { filter } = opts;
  return rows.filter(
    (r) =>
      (filter.kind === "all" ||
        (filter.kind === "project" ? r.projectId === filter.id : r.ecosystemId === filter.id)) &&
      (!term || conversationTitle(r, null, opts.untitled).toLowerCase().includes(term)),
  );
}

function ecosystemsReading(q: ReturnType<typeof useProjectEcosystems>, hasProject: boolean, t: Copy) {
  if (!hasProject) return { ecosystems: [], note: t("shell.list.ecoOpenProject") };
  if (q.isError) return { ecosystems: [], note: t("shell.list.ecoUnread", { why: formatApiError(q.error) }) };
  if (!q.data) return { ecosystems: [], note: t("shell.list.ecoReading") };
  const ecosystems = q.data.memberships.flatMap((m) =>
    m.document.state === "active" && m.ecosystem ? [{ id: m.ecosystem.id, name: m.ecosystem.name }] : [],
  );
  return { ecosystems, note: ecosystems.length ? null : t("shell.list.ecoNone") };
}

function filterMenu(o: {
  projects: Array<{ id: string; name: string }>;
  ecosystems: Array<{ id: string; name: string }>;
  filter: ConversationFilter;
  archived: boolean;
  onPick: (f: ConversationFilter) => void;
  onArchived: () => void;
  t: Copy;
}): MenuItem[] {
  const { filter, t } = o;
  const from = t("shell.list.showFrom");
  return [
    { group: from, label: t("shell.list.everyProject"), checked: filter.kind === "all", onSelect: () => o.onPick(EVERY_PROJECT) },
    ...o.projects.map((p) => ({
      group: from,
      label: p.name,
      checked: filter.kind === "project" && filter.id === p.id,
      onSelect: () => o.onPick({ kind: "project", id: p.id, name: p.name }),
    })),
    ...o.ecosystems.map((e) => ({
      group: t("nav.ecosystem"),
      label: e.name,
      checked: filter.kind === "ecosystem" && filter.id === e.id,
      onSelect: () => o.onPick({ kind: "ecosystem", id: e.id, name: e.name }),
    })),
    { group: t("shell.list.other"), label: t("shell.list.archived"), icon: "archive", checked: o.archived, onSelect: o.onArchived },
  ];
}

function FilterTrigger({ filtered, label }: { filtered: boolean; label: string }) {
  const t = useCopy();
  return (
    <span className="relative inline-flex">
      <IconButton
        icon="filter"
        variant="secondary"
        aria-label={filtered ? t("shell.list.filterShowing", { label }) : t("shell.list.filter")}
        aria-pressed={filtered}
        className={cn(filtered && "border-accent bg-accent-tint text-accent-text")}
      />
      {filtered && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2 rounded-pill bg-accent" />}
    </span>
  );
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
  // every project the person holds a role on, whatever org is active: a room is theirs to find wherever its project sits, and core still fences each read by role (ISS-34 F-4)
  const { data: allProjects } = useProjects();
  const projects = useMemo(() => allProjects ?? [], [allProjects]);
  const projectIds = useMemo(() => projects.map((p) => p.id).sort(), [projects]);
  const current = projects.find((p) => p.id === projectId);
  const t = useCopy();
  const untitled = t("shell.dock.newConversation");
  const { ecosystems, note: ecosystemsNote } = ecosystemsReading(useProjectEcosystems(current?.id ?? ""), current !== undefined, t);

  const [archived, setArchived] = useState(false);
  const list = useConversationsAcrossProjects(projectIds, archived);
  const [ecosystemScope, setEcosystemScope] = useState<EcosystemScope | null>(null);
  const [search, setSearch] = useState("");
  // the list opens on the project the dock is in; every project is one pick away in the filter
  const [picked, setPicked] = useState<ConversationFilter | null>(null);
  const filter: ConversationFilter =
    picked ?? (current ? { kind: "project", id: current.id, name: current.name } : EVERY_PROJECT);
  const [confirming, setConfirming] = useState<ListedConversation | null>(null);
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();
  const pin = usePinConversation();

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const rows = filterConversations(list.rows, { filter, search, untitled });
  const filtered = picked !== null || archived;
  const leave = (id: string) => {
    if (id === conversationId) onSelect(current ? { kind: "draft", projectId: current.id } : { kind: "people" });
  };

  const startProject = (id: string) => {
    setEcosystemScope(null);
    onSelect({ kind: "draft", projectId: id });
  };
  const startEcosystem = (scope: EcosystemScope) => {
    setEcosystemScope(scope);
    onSelect({ kind: "draft", projectId: scope.projectId, ecosystemId: scope.ecosystemId });
  };
  const scopeName = ecosystemScope?.name ?? current?.name;
  const startInScope = () =>
    ecosystemScope ? startEcosystem(ecosystemScope) : current ? startProject(current.id) : onSelect({ kind: "people" });

  const scopeItems: MenuItem[] = [
    ...projects.map((p) => ({
      group: t("common.nav.project"),
      label: p.name,
      checked: ecosystemScope === null && p.id === projectId,
      onSelect: () => startProject(p.id),
    })),
    ...(ecosystemsNote ? [{ group: t("nav.ecosystem"), label: ecosystemsNote, disabled: true }] : []),
    ...ecosystems.map((e) => ({
      group: t("nav.ecosystem"),
      label: e.name,
      checked: ecosystemScope?.ecosystemId === e.id,
      onSelect: () => current && startEcosystem({ projectId: current.id, ecosystemId: e.id, name: e.name }),
    })),
    {
      group: t("shell.list.withPeople"),
      label: t("shell.list.startWithPeople"),
      icon: "users",
      onSelect: () => {
        setEcosystemScope(null);
        onSelect({ kind: "people" });
      },
    },
  ];

  const filterItems = filterMenu({ projects, ecosystems, filter, archived, onPick: setPicked, onArchived: () => setArchived((v) => !v), t });
  const filterLabel = [filter.kind === "all" ? t("shell.list.everyProjectLower") : filter.name, archived ? t("shell.list.archivedLower") : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="conversation-list">
      <div className="flex flex-none flex-col gap-2 border-b border-line-subtle bg-surface px-3 py-2.5">
        <div className="flex" data-testid="new-chat">
          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            className="min-w-0 flex-1 rounded-r-none"
            onClick={startInScope}
          >
            <span className="truncate">{scopeName ? t("shell.list.newChatIn", { name: scopeName }) : t("shell.cmd.newChat")}</span>
          </Button>
          <Menu
            align="right"
            trigger={
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("shell.list.chooseScope")}
                className="h-full rounded-l-none border-l-0 px-2"
              >
                <Icon name="chevronDown" size={15} />
              </Button>
            }
            items={scopeItems}
            triggerClassName="flex h-full"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            aria-label={t("shell.list.search")}
            icon="search"
            placeholder={t("shell.list.searchPlaceholder")}
            className="min-w-0 flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Menu
            align="right"
            trigger={<FilterTrigger filtered={filtered} label={filterLabel} />}
            items={filterItems}
          />
        </div>
        {filtered && (
          <div className="flex items-center gap-1.5" data-testid="active-filter">
            <span className="fg-caption min-w-0 flex-1 truncate text-muted">{t("shell.list.showing", { label: filterLabel })}</span>
            <button
              type="button"
              className="fg-caption flex-none font-semibold text-link hover:underline"
              onClick={() => {
                setPicked(null);
                setArchived(false);
              }}
            >
              {current ? t("common.backTo", { label: current.name }) : t("shell.list.showAll")}
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-app">
        {list.error != null && (
          <ErrorState
            title={t("shell.dock.listUnread")}
            message={formatApiError(list.error)}
            onRetry={list.refetch}
          />
        )}
        {list.isLoading && SKELETON_ROWS.map((k) => <SessionRowSkeleton key={k} />)}
        {!list.isLoading && list.error == null && rows.length === 0 && (
          <EmptyState
            title={archived ? t("shell.list.noneArchived") : list.rows.length ? t("shell.list.noMatch") : t("shell.list.none")}
            message={archived ? t("shell.list.archivedHint") : t("shell.list.noneHint")}
          />
        )}
        {dockSections(rows, {
          projectId: current?.id ?? null,
          pageKey,
          projectName: (id) => byId.get(id)?.name ?? t("shell.list.closedProject"),
          words: { project: t("common.nav.project"), page: t("shell.dock.thisPage") },
        }).map((section) => (
          <section key={section.key} aria-label={section.label}>
            <h3 className="bg-sunken px-3 py-1 text-11-5 font-bold text-muted">{section.label}</h3>
            {section.rows.map((row) => {
              const p = byId.get(row.projectId);
              return (
                <ConversationRow
                  key={row.id}
                  row={row}
                  project={p}
                  open={row.id === conversationId}
                  onOpen={() => onSelect({ kind: "room", projectId: row.projectId, conversationId: row.id })}
                  onRename={(title) => rename.mutate({ id: row.id, title })}
                  onArchive={(a) =>
                    archive.mutate({ id: row.id, archived: a }, { onSuccess: () => leave(row.id) })
                  }
                  onDelete={() => setConfirming(row)}
                  onPin={(pinned) => pin.mutate({ id: row.id, pinned })}
                />
              );
            })}
          </section>
        ))}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={t("shell.list.deleteTitle")}
        message={
          confirming
            ? t("shell.list.deleteMessage", { title: conversationTitle(confirming, null, untitled) })
            : ""
        }
        confirmLabel={t("shell.list.delete")}
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
