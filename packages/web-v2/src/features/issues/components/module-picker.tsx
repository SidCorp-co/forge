"use client";

// Issue detail → the module picker (ISS-594). One primary module and any number
// of secondary ones, saved as one `PATCH /api/issues/:id` label write.
//
// A SlideOver rather than a popover: primary and secondary are two sections and
// a popover has room for neither. The drawer already carries Esc-to-close, a
// Tab focus trap and focus-restore-to-trigger (`design/patterns/slide-over.tsx`),
// so nothing is hand-rolled here.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Radio,
  RadioGroup,
  Skeleton,
  SlideOver,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProjectModules, useSetIssueModules } from "../hooks";
import type { IssueLabel } from "../types";

const NO_PRIMARY = "";

export interface ModulePickerProps {
  open: boolean;
  onClose: () => void;
  issueId: string;
  projectId: string;
  /** The project slug — the empty state links to its settings. */
  slug: string;
  /** The issue's CURRENT labels, modules and plain labels alike. The write is a
   *  full replacement, so the plain ones have to travel with it. */
  labels: IssueLabel[];
}

export function ModulePicker({
  open,
  onClose,
  issueId,
  projectId,
  slug,
  labels,
}: ModulePickerProps) {
  const router = useRouter();
  const modulesQ = useProjectModules(projectId);
  const save = useSetIssueModules(issueId);

  const attached = useMemo(() => labels.filter((l) => l.kind === "module"), [labels]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [primary, setPrimary] = useState<string>(NO_PRIMARY);

  // cm:guard `attached` is memoized on `labels`, which is what keeps this from re-seeding on every render — an unmemoized dep here resets the drawer under the reader mid-edit, and a dep on `open` alone leaves it stale after the save invalidates `['issue', id]`
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(attached.map((l) => l.id)));
    setPrimary(attached.find((l) => l.isPrimary)?.id ?? NO_PRIMARY);
  }, [open, attached]);

  const modules = modulesQ.modules;

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
    // cm:why un-ticking the primary clears it rather than promoting a secondary — which module leads is the reader's call, and a silent promotion writes an attribution nobody chose
    if (!next && primary === id) setPrimary(NO_PRIMARY);
  }

  function choosePrimary(id: string) {
    setPrimary(id);
    if (id !== NO_PRIMARY) setSelected((prev) => new Set(prev).add(id));
  }

  function commit() {
    save.mutate(
      {
        current: labels,
        moduleIds: [...selected],
        primaryId: primary === NO_PRIMARY ? null : primary,
      },
      { onSuccess: () => onClose() },
    );
  }

  return (
    <SlideOver open={open} onClose={onClose} title="Modules" width="clamp(360px, 40vw, 560px)">
      {modulesQ.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-24 rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-5/6 rounded-md" />
        </div>
      ) : modulesQ.isError ? (
        <ErrorState
          title="Couldn't load modules"
          message={formatApiError(modulesQ.error)}
          onRetry={() => modulesQ.refetch()}
        />
      ) : modules.length === 0 ? (
        <EmptyState
          title="No modules defined"
          message="No modules defined — add modules in project settings."
          mascot={false}
          action={{
            label: "Open project settings",
            onClick: () => router.push(`/projects/${slug}/settings?tab=modules`),
          }}
        />
      ) : (
        <div className="flex h-full flex-col gap-6">
          <section>
            <h3 className="fg-overline mb-2">Primary</h3>
            <p className="fg-caption mb-2.5 text-muted">
              The one module this issue belongs to. Pick at most one.
            </p>
            <RadioGroup name="primary-module" value={primary} onChange={choosePrimary}>
              <Radio value={NO_PRIMARY} label="No primary module" disabled={save.isPending} />
              {modules.map((m) => (
                <Radio key={m.id} value={m.id} label={m.name} disabled={save.isPending} />
              ))}
            </RadioGroup>
          </section>

          <section>
            <h3 className="fg-overline mb-2">Also touches</h3>
            <p className="fg-caption mb-2.5 text-muted">
              Every other module this issue reaches into.
            </p>
            <div className="flex flex-col gap-2.5">
              {modules
                .filter((m) => m.id !== primary)
                .map((m) => (
                  <Checkbox
                    key={m.id}
                    checked={selected.has(m.id)}
                    onChange={(next) => toggle(m.id, next)}
                    disabled={save.isPending}
                    label={m.name}
                  />
                ))}
            </div>
          </section>

          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={commit}>
              Save
            </Button>
          </div>
        </div>
      )}
    </SlideOver>
  );
}
