
import { EmptyState } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** What an empty list says, in a word or two (REQ-43 BC-6): a filter that matched nothing, nothing waiting on you, or no issues. */
export function IssuesEmptyState({
  inModule,
  isFiltered,
  projectHasIssues,
  onClear,
  onNewIssue,
}: {
  inModule: boolean;
  isFiltered: boolean;
  projectHasIssues: boolean;
  onClear: () => void;
  onNewIssue?: () => void;
}) {
  const t = useCopy();
  return (
    <div className="border-t border-line px-4 py-6 sm:px-6">
      <EmptyState
        message={
          isFiltered ? t("issues.empty.filtered") : projectHasIssues && !inModule ? t("issues.empty.notYours") : t("issues.empty.none")
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
