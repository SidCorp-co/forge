"use client";

// Project settings → Labels. List + create (name + #rrggbb color) + delete.
// Core enforces `color` matches /^#[0-9a-f]{6}$/i, so a native colour input
// (which always emits #rrggbb) is the simplest valid control.
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCreateLabel, useDeleteLabel, useLabels } from "../hooks";

const DEFAULT_COLOR = "#6b7280";

export function LabelsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const labelsQ = useLabels(projectId);
  const create = useCreateLabel(projectId);
  const remove = useDeleteLabel(projectId);

  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(
      { name: trimmed, color },
      { onSuccess: () => { setName(""); setColor(DEFAULT_COLOR); } },
    );
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-4">Labels</h2>

        {labelsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-2/3 rounded-md" />
          </div>
        ) : labelsQ.isError ? (
          <ErrorState message={formatApiError(labelsQ.error)} onRetry={() => labelsQ.refetch()} />
        ) : (labelsQ.data ?? []).length === 0 ? (
          <EmptyState title="No labels yet" message="Create a label to organize issues." mascot={false} />
        ) : (
          <ul className="space-y-1.5">
            {labelsQ.data!.map((label) => (
              <li
                key={label.id}
                className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full border border-line"
                    style={{ background: label.color ?? "transparent" }}
                  />
                  <span className="truncate text-fg">{label.name}</span>
                  {label.color && <Badge tone="neutral">{label.color}</Badge>}
                </span>
                {canEdit && (
                  <IconButton
                    icon="trash"
                    aria-label={`Delete label ${label.name}`}
                    onClick={() => remove.mutate(label.id)}
                    disabled={remove.isPending}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New label name"
                maxLength={64}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                }}
              />
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Label color"
              className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1"
            />
            <Button
              variant="secondary"
              icon="plus"
              loading={create.isPending}
              disabled={name.trim() === ""}
              onClick={add}
              className="min-h-11"
            >
              Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
