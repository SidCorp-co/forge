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

  Button,
  PageSection,
  PageSectionBody,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  SectionTitle,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProjectLabel } from "../types";
import { useCreateLabel, useDeleteLabel, useLabels } from "../hooks";

const DEFAULT_COLOR = "#6b7280";

export function LabelsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const t = useCopy();
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
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1 text-accent-text!">{t("settings.project.work.labels")}</SectionTitle>
        <p className="fg-body-sm mb-4 max-w-[68ch] text-muted">{t("settings.project.work.labelsLead")}</p>

        {labelsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-2/3 rounded-md" />
          </div>
        ) : labelsQ.isError ? (
          <ErrorState message={formatApiError(labelsQ.error)} onRetry={() => labelsQ.refetch()} />
        ) : plainLabels.length === 0 ? (
          <EmptyState title={t("settings.project.work.noLabels")} message={t("settings.project.work.noLabelsBody")} mascot={false} />
        ) : (
          <ul className="divide-y divide-line-subtle">
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
            placeholder={t("settings.project.work.newLabel")}
            ariaLabel={t("settings.project.work.newLabel")}
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
              aria-label={t("settings.project.work.labelColor")}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1"
            />
          </AddByName>
        )}
        <ConfirmDelete
          target={pendingDelete}
          title={t("settings.project.work.deleteLabel")}
          consequence={t("settings.project.work.deleteLabelBody")}
          remove={remove}
          onClose={() => setPendingDelete(null)}
        />
      </PageSectionBody>
    </PageSection>
  );
}

function LabelRow({ label, onDelete, deleting }: { label: ProjectLabel; onDelete?: () => void; deleting: boolean }) {
  const t = useCopy();
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-3 w-3 shrink-0 rounded-full border border-line" style={{ background: label.color }} />
        <span className="truncate text-fg">{label.name}</span>
        <span className="fg-caption font-mono text-subtle" translate="no">
          {label.color}
        </span>
      </span>
      {onDelete && (
        <IconButton icon="trash" aria-label={t("settings.project.work.deleteLabelNamed", { name: label.name })} onClick={onDelete} disabled={deleting} />
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
  const t = useCopy();
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
        {t("settings.project.people.add")}
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
  const t = useCopy();
  return (
    <ConfirmDialog
      open={target !== null}
      title={title}
      message={`${target?.name ?? ""} ${consequence}`}
      confirmLabel={t("settings.project.raw.delete")}
      tone="danger"
      loading={remove.isPending}
      onConfirm={() => {
        if (target) remove.mutate(target.id, { onSettled: onClose });
      }}
      onClose={onClose}
    />
  );
}
