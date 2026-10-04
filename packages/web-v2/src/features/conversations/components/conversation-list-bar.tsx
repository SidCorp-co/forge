"use client";

import { useState } from "react";
import { Button, Icon, IconButton, Input, Menu, type MenuItem } from "@/design";
import type { ProjectListItem } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";
import type { ChatTarget } from "../dock-target";

export type ConversationFilter =
  | { kind: "all" }
  | { kind: "project"; id: string; name: string }
  | { kind: "ecosystem"; id: string; name: string };

export const EVERY_PROJECT: ConversationFilter = { kind: "all" };

type Named = { id: string; name: string };
type EcosystemScope = { projectId: string; ecosystemId: string; name: string };

/** "New chat" in the scope last picked, and the menu that picks another. */
export function NewChatButton({
  projects,
  current,
  ecosystems,
  ecosystemsNote,
  onSelect,
}: {
  projects: ProjectListItem[];
  current: ProjectListItem | undefined;
  ecosystems: Named[];
  ecosystemsNote: string | null;
  onSelect: (target: ChatTarget) => void;
}) {
  const [scope, setScope] = useState<EcosystemScope | null>(null);
  const startProject = (id: string) => {
    setScope(null);
    onSelect({ kind: "draft", projectId: id });
  };
  const startEcosystem = (s: EcosystemScope) => {
    setScope(s);
    onSelect({ kind: "draft", projectId: s.projectId, ecosystemId: s.ecosystemId });
  };
  const scopeName = scope?.name ?? current?.name;
  const items: MenuItem[] = [
    ...projects.map((p) => ({
      group: "Project",
      label: p.name,
      checked: scope === null && p.id === current?.id,
      onSelect: () => startProject(p.id),
    })),
    ...(ecosystemsNote ? [{ group: "Ecosystem", label: ecosystemsNote, disabled: true }] : []),
    ...ecosystems.map((e) => ({
      group: "Ecosystem",
      label: e.name,
      checked: scope?.ecosystemId === e.id,
      onSelect: () => current && startEcosystem({ projectId: current.id, ecosystemId: e.id, name: e.name }),
    })),
    {
      group: "With other people",
      label: "Start a room with other people…",
      icon: "users",
      onSelect: () => {
        setScope(null);
        onSelect({ kind: "people" });
      },
    },
  ];

  return (
    <div className="flex" data-testid="new-chat">
      <Button
        variant="secondary"
        size="sm"
        icon="plus"
        className="min-w-0 flex-1 rounded-r-none"
        onClick={() => (scope ? startEcosystem(scope) : current ? startProject(current.id) : onSelect({ kind: "people" }))}
      >
        <span className="truncate">{scopeName ? `New chat · ${scopeName}` : "New chat"}</span>
      </Button>
      <Menu
        align="right"
        trigger={
          <Button variant="secondary" size="sm" aria-label="Choose where the new chat starts" className="h-full rounded-l-none border-l-0 px-2">
            <Icon name="chevronDown" size={15} />
          </Button>
        }
        items={items}
        triggerClassName="flex h-full"
      />
    </div>
  );
}

/** Search, the scope filter, and the line naming a filter that is on. */
export function ListFilterBar(props: {
  projects: ProjectListItem[];
  ecosystems: Named[];
  current: ProjectListItem | undefined;
  search: string;
  onSearch: (s: string) => void;
  filter: ConversationFilter;
  picked: ConversationFilter | null;
  onPick: (f: ConversationFilter | null) => void;
  archived: boolean;
  onArchived: (a: boolean) => void;
}) {
  const { filter, archived, current } = props;
  const filtered = props.picked !== null || archived;
  const show = "Show conversations from";
  const items: MenuItem[] = [
    { group: show, label: "Every project", checked: filter.kind === "all", onSelect: () => props.onPick(EVERY_PROJECT) },
    ...props.projects.map((p) => ({
      group: show,
      label: p.name,
      checked: filter.kind === "project" && filter.id === p.id,
      onSelect: () => props.onPick({ kind: "project", id: p.id, name: p.name }),
    })),
    ...props.ecosystems.map((e) => ({
      group: "Ecosystem",
      label: e.name,
      checked: filter.kind === "ecosystem" && filter.id === e.id,
      onSelect: () => props.onPick({ kind: "ecosystem", id: e.id, name: e.name }),
    })),
    { group: "Other", label: "Archived", icon: "archive", checked: archived, onSelect: () => props.onArchived(!archived) },
  ];
  const label = [filter.kind === "all" ? "every project" : filter.name, archived ? "archived" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="Search conversations"
          icon="search"
          placeholder="Search chats"
          className="min-w-0 flex-1"
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
        />
        <Menu
          align="right"
          trigger={
            <span className="relative inline-flex">
              <IconButton
                icon="filter"
                variant="secondary"
                aria-label={filtered ? `Filter conversations, showing ${label}` : "Filter conversations"}
                aria-pressed={filtered}
                className={cn(filtered && "border-accent bg-accent-tint text-accent-text")}
              />
              {filtered && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2 rounded-pill bg-accent" />}
            </span>
          }
          items={items}
        />
      </div>
      {filtered && (
        <div className="flex items-center gap-1.5" data-testid="active-filter">
          <span className="fg-caption min-w-0 flex-1 truncate text-muted">Showing {label}</span>
          <button
            type="button"
            className="fg-caption flex-none font-semibold text-link hover:underline"
            onClick={() => {
              props.onPick(null);
              props.onArchived(false);
            }}
          >
            {current ? `Back to ${current.name}` : "Show all"}
          </button>
        </div>
      )}
    </>
  );
}
