"use client";

// Project settings → Modules (ISS-594). The project's module taxonomy: create,
// rename, recolour, re-describe, re-parent and delete.
//
// A module IS a label with `kind: 'module'` (ISS-593) — there is no /modules
// endpoint, and everything here rides `POST /projects/:id/labels`,
// `PATCH /labels/:id` and `DELETE /labels/:id`.
//
// The tree is grouped under each root module: the root heads its group on the
// sunken ground and its descendants follow, indented by depth, as flush rows
// under hairlines. A parent <Select> per row carries the re-parent edit.

import { useMemo, useState } from "react";
import {
  PageSection,
  PageSectionBody,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  SectionTitle,
  Select,
  Skeleton,
  Textarea,
  type SelectOption,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from "../hooks";
import type { ProjectLabel } from "../types";
import { AddByName, ConfirmDelete } from "./labels-tab";

const NO_PARENT = "";
const INDENT_PER_DEPTH_PX = 20;

interface ModuleNode {
  module: ProjectLabel;
  depth: number;
}

/**
 * Flatten the taxonomy depth-first, alphabetically within each level.
 *
 * A module whose `parentId` names a row that is not in this list — deleted, or a plain label the
 * server has since demoted — is rendered at the root rather than dropped, so it stays reachable
 * and re-parentable instead of vanishing from the only screen that can fix it.
 */
function flattenModules(modules: ProjectLabel[]): ModuleNode[] {
  const byParent = new Map<string, ProjectLabel[]>();
  const ids = new Set(modules.map((m) => m.id));
  for (const m of modules) {
    const key = m.parentId && ids.has(m.parentId) ? m.parentId : NO_PARENT;
    byParent.set(key, [...(byParent.get(key) ?? []), m]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const out: ModuleNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const m of byParent.get(parent) ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ module: m, depth });
      walk(m.id, depth + 1);
    }
  };
  walk(NO_PARENT, 0);
  return out;
}

/** Every module that would create a cycle if it became `moduleId`'s parent: itself + its subtree. */
function descendantIds(modules: ProjectLabel[], moduleId: string): Set<string> {
  const out = new Set<string>([moduleId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of modules) {
      if (m.parentId && out.has(m.parentId) && !out.has(m.id)) {
        out.add(m.id);
        grew = true;
      }
    }
  }
  return out;
}

type ModulePatch = { name?: string; color?: string; parentId?: string | null; description?: string | null };

function ModuleControls({
  module: m,
  modules,
  saving,
  expanded,
  onExpand,
  onPatch,
  onDelete,
}: {
  module: ProjectLabel;
  modules: ProjectLabel[];
  saving: boolean;
  expanded: boolean;
  onExpand: () => void;
  onPatch: (patch: ModulePatch) => void;
  onDelete: () => void;
}) {
  const t = useCopy();
  const parentOptions = useMemo<SelectOption[]>(() => {
    const banned = descendantIds(modules, m.id);
    return [
      { value: NO_PARENT, label: t("settings.project.work.noParent") },
      ...modules
        .filter((o) => !banned.has(o.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((o) => ({ value: o.id, label: o.name })),
    ];
  }, [modules, m.id, t]);

  return (
    <>
      <input
        type="color"
        value={m.color}
        onChange={(e) => onPatch({ color: e.target.value })}
        aria-label={t("settings.project.work.colourOf", { name: m.name })}
        className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1"
      />
      <Select
        aria-label={t("settings.project.work.parentOf", { name: m.name })}
        value={m.parentId ?? NO_PARENT}
        options={parentOptions}
        disabled={saving}
        onChange={(v) => onPatch({ parentId: v === NO_PARENT ? null : v })}
        className="w-44"
      />
      <IconButton
        icon={expanded ? "chevronUpDown" : "chevronDown"}
        aria-label={expanded ? t("settings.project.work.hideDescription", { name: m.name }) : t("settings.project.work.describe", { name: m.name })}
        aria-expanded={expanded}
        onClick={onExpand}
      />
      <IconButton icon="trash" aria-label={t("settings.project.work.deleteModuleNamed", { name: m.name })} onClick={onDelete} disabled={saving} />
    </>
  );
}

function ModuleName({ module: m, onPatch }: { module: ProjectLabel; onPatch: (patch: ModulePatch) => void }) {
  const t = useCopy();
  const [name, setName] = useState(m.name);
  function commit() {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === m.name) setName(m.name);
    else onPatch({ name: trimmed });
  }
  return (
    <Input
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setName(m.name);
      }}
      aria-label={t("settings.project.work.moduleName", { name: m.name })}
      maxLength={64}
      className="min-w-0 basis-full sm:basis-auto sm:flex-1 sm:max-w-56"
    />
  );
}

function ModuleRow({
  node,
  modules,
  canEdit,
  onPatch,
  onDelete,
  saving,
  childCount,
}: {
  node: ModuleNode;
  childCount?: number;
  modules: ProjectLabel[];
  canEdit: boolean;
  onPatch: (patch: ModulePatch) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const t = useCopy();
  const { module: m, depth } = node;
  const [description, setDescription] = useState(m.description ?? "");
  const [expanded, setExpanded] = useState(false);

  function commitDescription() {
    const next = description.trim();
    if (next === (m.description ?? "")) return;
    onPatch({ description: next === "" ? null : next });
  }

  return (
    <li
      className={cn("border-b border-line-subtle", depth === 0 && "bg-sunken")}
      style={{ paddingLeft: depth * INDENT_PER_DEPTH_PX }}
      data-testid={depth === 0 ? "module-group" : "module-row"}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full border border-line"
          style={{ background: m.color }}
        />
        {canEdit ? (
          <ModuleName module={m} onPatch={onPatch} />
        ) : (
          <span className={cn("min-w-0 basis-full truncate text-fg sm:basis-auto sm:flex-1", depth === 0 && "font-semibold")}>
            {m.name}
          </span>
        )}
        {childCount !== undefined ? (
          <span className="flex-none text-12 text-subtle">
            {childCount ? t("settings.project.work.children", { n: childCount }) : t("settings.project.work.noChildren")}
          </span>
        ) : null}
        {canEdit && (
          <ModuleControls
            module={m}
            modules={modules}
            saving={saving}
            expanded={expanded}
            onExpand={() => setExpanded((v) => !v)}
            onPatch={onPatch}
            onDelete={onDelete}
          />
        )}
      </div>

      {!canEdit && m.description && (
        <p className="fg-body-sm px-3 pb-2 text-muted">{m.description}</p>
      )}

      {canEdit && expanded && (
        <div className="px-3 pb-3">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            aria-label={t("settings.project.work.descriptionOf", { name: m.name })}
            placeholder={t("settings.project.work.descriptionPlaceholder")}
            maxLength={2000}
            rows={2}
          />
        </div>
      )}
    </li>
  );
}

export function ModulesTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const t = useCopy();
  const labelsQ = useLabels(projectId);
  const create = useCreateLabel(projectId);
  const update = useUpdateLabel(projectId);
  const remove = useDeleteLabel(projectId);

  const [pendingDelete, setPendingDelete] = useState<ProjectLabel | null>(null);

  const modules = useMemo(
    () => (labelsQ.data ?? []).filter((l) => l.kind === "module"),
    [labelsQ.data],
  );
  const tree = useMemo(() => flattenModules(modules), [modules]);

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1 text-accent-text!">{t("settings.project.work.modules")}</SectionTitle>
        <p className="fg-body-sm mb-4 max-w-[68ch] text-muted">{t("settings.project.work.modulesLead")}</p>

        {labelsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-5/6 rounded-md" />
            <Skeleton className="h-12 w-2/3 rounded-md" />
          </div>
        ) : labelsQ.isError ? (
          <ErrorState
            title={t("settings.project.work.modulesUnread")}
            message={formatApiError(labelsQ.error)}
            onRetry={() => labelsQ.refetch()}
          />
        ) : modules.length === 0 ? (
          <EmptyState
            title={t("settings.project.work.noModules")}
            message={t("settings.project.work.noModulesBody")}
            mascot={false}
          />
        ) : (
          <ul className="border-t border-line-subtle">
            {tree.map((node) => (
              <ModuleRow
                key={node.module.id}
                node={node}
                modules={modules}
                canEdit={canEdit}
                childCount={node.depth === 0 ? modules.filter((m) => m.parentId === node.module.id).length : undefined}
                saving={update.isPending || remove.isPending}
                onPatch={(patch) => update.mutate({ labelId: node.module.id, patch })}
                onDelete={() => setPendingDelete(node.module)}
              />
            ))}
          </ul>
        )}

        {canEdit && (
          <AddByName
            placeholder={t("settings.project.work.newModule")}
            ariaLabel={t("settings.project.work.newModule")}
            loading={create.isPending}
            onAdd={(name, done) => create.mutate({ name, kind: "module" }, { onSuccess: done })}
          />
        )}
        <ConfirmDelete
          target={pendingDelete}
          title={t("settings.project.work.deleteModule")}
          consequence={t("settings.project.work.deleteModuleBody")}
          remove={remove}
          onClose={() => setPendingDelete(null)}
        />
      </PageSectionBody>
    </PageSection>
  );
}
