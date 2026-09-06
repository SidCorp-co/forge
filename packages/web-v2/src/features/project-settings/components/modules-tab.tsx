"use client";

// Project settings → Modules (ISS-594). The project's module taxonomy: create,
// rename, recolour, re-describe, re-parent and delete.
//
// A module IS a label with `kind: 'module'` (ISS-593) — there is no /modules
// endpoint, and everything here rides `POST /projects/:id/labels`,
// `PATCH /labels/:id` and `DELETE /labels/:id`.
//
// Hierarchy is an indented flat list plus a parent <Select> per row, not a
// drag-drop tree: the design system has no tree primitive and inventing one
// here would be a one-off outside it. Depth carries the shape; the Select
// carries the edit.

import { useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Select,
  type SelectOption,
  Skeleton,
  Textarea,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from "../hooks";
import type { ProjectLabel } from "../types";

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
export function flattenModules(modules: ProjectLabel[]): ModuleNode[] {
  const byParent = new Map<string, ProjectLabel[]>();
  const ids = new Set(modules.map((m) => m.id));
  for (const m of modules) {
    const key = m.parentId && ids.has(m.parentId) ? m.parentId : NO_PARENT;
    byParent.set(key, [...(byParent.get(key) ?? []), m]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const out: ModuleNode[] = [];
  // cm:guard the `seen` set bounds the walk — `parentId` is only acyclic because the server
  // refuses a cycle (CIRCULAR_HIERARCHY); a row written around that route would recurse forever.
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
export function descendantIds(modules: ProjectLabel[], moduleId: string): Set<string> {
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

function ModuleRow({
  node,
  modules,
  canEdit,
  onPatch,
  onDelete,
  saving,
}: {
  node: ModuleNode;
  modules: ProjectLabel[];
  canEdit: boolean;
  onPatch: (patch: { name?: string; color?: string; parentId?: string | null; description?: string | null }) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const { module: m, depth } = node;
  const [name, setName] = useState(m.name);
  const [description, setDescription] = useState(m.description ?? "");
  const [expanded, setExpanded] = useState(false);

  // cm:why the options exclude this module and its whole subtree — the server refuses exactly those with CIRCULAR_HIERARCHY, and offering a choice that can only fail is worse than not offering it
  const parentOptions = useMemo<SelectOption[]>(() => {
    const banned = descendantIds(modules, m.id);
    return [
      { value: NO_PARENT, label: "No parent" },
      ...modules
        .filter((o) => !banned.has(o.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((o) => ({ value: o.id, label: o.name })),
    ];
  }, [modules, m.id]);

  function commitName() {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === m.name) {
      setName(m.name);
      return;
    }
    onPatch({ name: trimmed });
  }

  function commitDescription() {
    const next = description.trim();
    if (next === (m.description ?? "")) return;
    onPatch({ description: next === "" ? null : next });
  }

  return (
    <li className="rounded-md border border-line" style={{ marginLeft: depth * INDENT_PER_DEPTH_PX }}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full border border-line"
          style={{ background: m.color }}
        />
        {canEdit ? (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setName(m.name);
            }}
            aria-label={`Module name for ${m.name}`}
            maxLength={64}
            className="min-w-0 flex-1 sm:max-w-56"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg">{m.name}</span>
        )}
        {canEdit && (
          <>
            <input
              type="color"
              value={m.color}
              onChange={(e) => onPatch({ color: e.target.value })}
              aria-label={`Colour for ${m.name}`}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1"
            />
            <Select
              aria-label={`Parent of ${m.name}`}
              value={m.parentId ?? NO_PARENT}
              options={parentOptions}
              disabled={saving}
              onChange={(v) => onPatch({ parentId: v === NO_PARENT ? null : v })}
              className="w-44"
            />
            <IconButton
              icon={expanded ? "chevronUpDown" : "chevronDown"}
              aria-label={expanded ? `Hide description of ${m.name}` : `Describe ${m.name}`}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            />
            <IconButton
              icon="trash"
              aria-label={`Delete module ${m.name}`}
              onClick={onDelete}
              disabled={saving}
            />
          </>
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
            aria-label={`Description of ${m.name}`}
            placeholder="What this module covers"
            maxLength={2000}
            rows={2}
          />
        </div>
      )}
    </li>
  );
}

export function ModulesTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const labelsQ = useLabels(projectId);
  const create = useCreateLabel(projectId);
  const update = useUpdateLabel(projectId);
  const remove = useDeleteLabel(projectId);

  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProjectLabel | null>(null);

  const modules = useMemo(
    () => (labelsQ.data ?? []).filter((l) => l.kind === "module"),
    [labelsQ.data],
  );
  const tree = useMemo(() => flattenModules(modules), [modules]);

  function add() {
    const trimmed = newName.trim();
    if (trimmed === "") return;
    // cm:why no colour is sent — the server derives a stable one from the name (`autoModuleColor`), so a module never arrives grey and the create form stays one field
    create.mutate({ name: trimmed, kind: "module" }, { onSuccess: () => setNewName("") });
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Modules</h2>
        <p className="fg-body-sm mb-4 text-muted">
          The parts of this project issues are attributed to. Each issue has one primary module and
          any number of secondary ones.
        </p>

        {labelsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-md" />
            <Skeleton className="h-12 w-5/6 rounded-md" />
            <Skeleton className="h-12 w-2/3 rounded-md" />
          </div>
        ) : labelsQ.isError ? (
          <ErrorState
            title="Couldn't load modules"
            message={formatApiError(labelsQ.error)}
            onRetry={() => labelsQ.refetch()}
          />
        ) : modules.length === 0 ? (
          <EmptyState
            title="No modules yet"
            message="Add a module to attribute issues to a part of this project."
            mascot={false}
          />
        ) : (
          <ul className="space-y-1.5">
            {tree.map((node) => (
              <ModuleRow
                key={node.module.id}
                node={node}
                modules={modules}
                canEdit={canEdit}
                saving={update.isPending || remove.isPending}
                onPatch={(patch) => update.mutate({ labelId: node.module.id, patch })}
                onDelete={() => setPendingDelete(node.module)}
              />
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New module name"
                aria-label="New module name"
                maxLength={64}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
            </div>
            <Button
              variant="secondary"
              icon="plus"
              loading={create.isPending}
              disabled={newName.trim() === ""}
              onClick={add}
              className="min-h-11"
            >
              Add
            </Button>
          </div>
        )}

        <ConfirmDialog
          open={pendingDelete !== null}
          title="Delete module"
          message={`${pendingDelete?.name ?? ""} is removed from the taxonomy. Issues tagged with it keep their other modules. This cannot be undone.`}
          confirmLabel="Delete"
          tone="danger"
          loading={remove.isPending}
          onConfirm={() => {
            if (!pendingDelete) return;
            remove.mutate(pendingDelete.id, { onSettled: () => setPendingDelete(null) });
          }}
          onClose={() => setPendingDelete(null)}
        />
      </CardContent>
    </Card>
  );
}
