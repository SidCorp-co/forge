"use client";

import { EmptyState } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** What an empty page says: a module with nothing tagged, a filter that matched nothing, nothing waiting, or a new project. */
export function IssuesEmptyState({
  moduleName,
  inModule,
  creatorName,
  isFiltered,
  projectHasIssues,
  onClear,
  onNewIssue,
}: {
  moduleName: string | null;
  inModule: boolean;
  /** Set when the list is filtered to one creator. */
  creatorName: string | null;
  isFiltered: boolean;
  projectHasIssues: boolean;
  onClear: () => void;
  onNewIssue?: () => void;
}) {
  const t = useCopy();
  return (
    <div className="border-t border-line px-4 py-6 sm:px-6">
      <EmptyState
        title={
          inModule
            ? t("issues.empty.moduleTitle")
            : isFiltered
              ? t("issues.empty.filteredTitle")
              : projectHasIssues
                ? t("issues.empty.notYoursTitle")
                : t("issues.empty.noneTitle")
        }
        message={
          inModule
            ? t("issues.empty.module", { module: moduleName ?? t("issues.empty.thisModule") })
            : creatorName !== null
              ? t("issues.empty.creator", { name: creatorName })
              : isFiltered
                ? t("issues.empty.filtered")
                : projectHasIssues
                  ? t("issues.empty.notYours")
                  : t("issues.empty.none")
        }
        mascot={!isFiltered}
        action={
          isFiltered
            ? {
                label: t("issues.empty.clearFilters"),
                onClick: onClear,
              }
            : onNewIssue
              ? { label: t("issues.newIssue"), onClick: onNewIssue }
              : undefined
        }
      />
    </div>
  );
}
