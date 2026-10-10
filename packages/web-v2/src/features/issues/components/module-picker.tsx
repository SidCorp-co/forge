"use client";

// Issue detail → the module picker (ISS-594). One primary module and any number
// of secondary ones, saved as one `PATCH /api/issues/:id` label write.
//
// A SlideOver rather than a popover: primary and secondary are two sections and
// a popover has room for neither. The drawer already carries Esc-to-close, a
// Tab focus trap and focus-restore-to-trigger (`design/patterns/slide-over.tsx`),
// so nothing is hand-rolled here.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  PageSectionTitle,
  Checkbox,
  EmptyState,
  ErrorState,
  Radio,
  RadioGroup,
  Skeleton,
  SlideOver,
} from "@/design";
import { ancestorsOf } from "@/features/modules";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useProjectModules, useSetIssueModules } from "../hooks";
import type { IssueLabel } from "../types";

const NO_PRIMARY = "";

interface ModulePickerProps {
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
  const t = useCopy();

  const attached = labels.filter((l) => l.kind === "module");

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [primary, setPrimary] = useState<string>(NO_PRIMARY);
  // each opening starts from the modules the issue carries now
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSelected(new Set(attached.map((l) => l.id)));
      setPrimary(attached.find((l) => l.isPrimary)?.id ?? NO_PRIMARY);
    }
  }

  // each module named under its ancestors ("Execution › Runs"), so the list reads in tree order
  const modules = modulesQ.modules
        .map((m) => ({ ...m, label: [...ancestorsOf(modulesQ.modules, m.id).map((a) => a.name), m.name].join(" › ") }))
        .sort((a, b) => a.label.localeCompare(b.label));

  function toggle(id: string, next: boolean) {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
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
    <SlideOver open={open} onClose={onClose} title={t("issues.modules.title")} width="clamp(360px, 40vw, 560px)">
      {modulesQ.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-6 w-24 rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-5/6 rounded-md" />
        </div>
      ) : modulesQ.isError ? (
        <ErrorState
          title={t("issues.modules.loadFailed")}
          message={formatApiError(modulesQ.error)}
          onRetry={() => void modulesQ.refetch()}
        />
      ) : modules.length === 0 ? (
        <EmptyState
          message={t("issues.modules.none")}
          mascot={false}
          action={{
            label: t("issues.modules.openSettings"),
            onClick: () => router.push(`/projects/${slug}/settings?tab=work#modules`),
          }}
        />
      ) : (
        <div className="flex h-full flex-col gap-6">
          <section>
            <PageSectionTitle className="fg-overline mb-2">{t("issues.modules.primary")}</PageSectionTitle>
            <RadioGroup name="primary-module" value={primary} onChange={choosePrimary}>
              <Radio value={NO_PRIMARY} label={t("issues.modules.noPrimary")} disabled={save.isPending} />
              {modules.map((m) => (
                <Radio key={m.id} value={m.id} label={m.label} disabled={save.isPending} />
              ))}
            </RadioGroup>
          </section>

          <section>
            <PageSectionTitle className="fg-overline mb-2">{t("issues.modules.also")}</PageSectionTitle>
            <div className="flex flex-col gap-2.5">
              {modules
                .filter((m) => m.id !== primary)
                .map((m) => (
                  <Checkbox
                    key={m.id}
                    checked={selected.has(m.id)}
                    onChange={(next) => toggle(m.id, next)}
                    disabled={save.isPending}
                    label={m.label}
                  />
                ))}
            </div>
          </section>

          <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={commit}>
              {t("issues.description.save")}
            </Button>
          </div>
        </div>
      )}
    </SlideOver>
  );
}
