"use client";

import { EmptyState } from "@/design";

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
  return (
    <div className="border-t border-line px-4 py-6 sm:px-6">
      <EmptyState
        title={
          inModule
            ? "No issues in this module"
            : isFiltered
              ? "Nothing here"
              : projectHasIssues
                ? "Nothing is waiting on you"
                : "No issues yet"
        }
        message={
          inModule
            ? `No issues tagged to ${moduleName ?? "this module"}.`
            : creatorName !== null
              ? `No issues created by ${creatorName}.`
              : isFiltered
                ? "No issues match this search or filter."
                : projectHasIssues
                  ? "Work is moving without you — the other filters say where it is."
                  : "Issues for this project will appear here as work is filed."
        }
        mascot={!isFiltered}
        action={
          isFiltered
            ? {
                label: "Clear filters",
                onClick: onClear,
              }
            : onNewIssue
              ? { label: "New issue", onClick: onNewIssue }
              : undefined
        }
      />
    </div>
  );
}
