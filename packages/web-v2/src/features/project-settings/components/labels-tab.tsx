"use client";

// Project settings → Labels. List + create (name + #rrggbb color) + delete.
// Core enforces `color` matches /^#[0-9a-f]{6}$/i, so a native colour input
// (which always emits #rrggbb) is the simplest valid control.
// Modules are labels too (`kind: 'module'`, ISS-593) and come back on the same
// endpoint. They are filtered out here and edited in the Modules tab instead —
// a module's parent and description have no control on this screen, so editing
// one here could only ever be a partial edit.

import { type ReactNode, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  SectionTitle,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import type { ProjectLabel } from "../types";
import { useCreateLabel, useDeleteLabel, useLabels } from "../hooks";

const DEFAULT_COLOR = "#6b7280";

export function LabelsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const labelsQ = useLabels(projectId);
  const create = useCreateLabel(projectId);
  const remove = useDeleteLabel(projectId);

  const [color, setColor] = useState(DEFAULT_COLOR);
  const [pendingDelete, setPendingDelete] = useState<ProjectLabel | null>(null);

  const plainLabels = useMemo(
    () => (labelsQ.data ?? []).filter((l) => l.kind !== "module"),
    [labelsQ.data],
  );

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Labels</SectionTitle>

        {labelsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-2/3 rounded-md" />
          </div>
        ) : labelsQ.isError ? (
          <ErrorState message={formatApiError(labelsQ.error)} onRetry={() => labelsQ.refetch()} />
        ) : plainLabels.length === 0 ? (
          <EmptyState title="No labels yet" message="Create a label to organize issues." mascot={false} />
        ) : (
          <ul className="space-y-1.5">
            {plainLabels.map((label) => (
              <LabelRow
                key={label.id}
                label={label}
                onDelete={canEdit ? () => setPendingDelete(label) : undefined}
                deleting={remove.isPending}
              />
            ))}
          </ul>
        )}

        {canEdit && (
          <AddByName
            placeholder="New label name"
            loading={create.isPending}
            onAdd={(name, done) =>
              create.mutate(
                { name, color, kind: "label" },
                {
                  onSuccess: () => {
                    done();
                    setColor(DEFAULT_COLOR);
                  },
                },
              )
            }
          >
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Label color"
              className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1"
            />
          </AddByName>
        )}
        <ConfirmDelete
          target={pendingDelete}
          title="Delete label"
          consequence="is removed from every issue carrying it. This cannot be undone."
          remove={remove}
          onClose={() => setPendingDelete(null)}
        />
      </CardContent>
    </Card>
  );
}

function LabelRow({ label, onDelete, deleting }: { label: ProjectLabel; onDelete?: () => void; deleting: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-3 w-3 shrink-0 rounded-full border border-line" style={{ background: label.color }} />
        <span className="truncate text-fg">{label.name}</span>
        <Badge tone="neutral">{label.color}</Badge>
      </span>
      {onDelete && (
        <IconButton icon="trash" aria-label={`Delete label ${label.name}`} onClick={onDelete} disabled={deleting} />
      )}
    </li>
  );
}

/** The add row Labels and Modules share: a name, Enter or the button adds it; `done` clears it. */
export function AddByName({
  placeholder,
  ariaLabel,
  onAdd,
  loading,
  children,
}: {
  placeholder: string;
  ariaLabel?: string;
  onAdd: (name: string, done: () => void) => void;
  loading: boolean;
  children?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    if (value.trim()) onAdd(value.trim(), () => setValue(""));
  };
  return (
    <div className="mt-4 flex items-end gap-2">
      <div className="flex-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          maxLength={64}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
      </div>
      {children}
      <Button
        variant="secondary"
        icon="plus"
        loading={loading}
        disabled={value.trim() === ""}
        onClick={add}
        className="min-h-11"
      >
        Add
      </Button>
    </div>
  );
}

export function ConfirmDelete({
  target,
  title,
  consequence,
  remove,
  onClose,
}: {
  target: ProjectLabel | null;
  title: string;
  /** Read after the target's name. */
  consequence: string;
  remove: ReturnType<typeof useDeleteLabel>;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      title={title}
      message={`${target?.name ?? ""} ${consequence}`}
      confirmLabel="Delete"
      tone="danger"
      loading={remove.isPending}
      onConfirm={() => {
        if (target) remove.mutate(target.id, { onSettled: onClose });
      }}
      onClose={onClose}
    />
  );
}
