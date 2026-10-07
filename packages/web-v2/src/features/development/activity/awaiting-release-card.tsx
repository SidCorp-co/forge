"use client";

// Awaiting-release card: the issues standing at `awaiting_release`, counted by core's issue list as
// the issue flow beside it counts them, and the draft release's turn read from the same draft
// forecast the dashboard's lateness reads (JU-8), so the page never says "nothing" beside a flow
// that says 72. Collapsed by default so a large backlog cannot push Runners below the fold.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  Checkbox,
  Icon,
  StatusChip,
} from "@/design";
import { useDraftReleaseForecast } from "@/features/forecast/hooks";
import { spanText } from "@/features/forecast/text";
import { BatchReleaseDialog, type BatchReleaseIssue } from "@/features/issues/components/batch-release-dialog";
import { useIssues } from "@/features/issues/hooks";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { issueHref, issuesHref } from "@/lib/routes/issues";

const COLLAPSED_LIMIT = 5;
/** The page the card reads; past it the card counts the rest and links the list. */
const READ_LIMIT = 50;

/** Who the draft release waits on, and how late, as the dashboard says it. */
function DraftTurn({ projectId }: { projectId: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const next = useDraftReleaseForecast(projectId, true).data?.next ?? null;
  if (!next) return null;
  const who = said(next.says.who, language);
  const line = next.late
    ? t("dash.lateWaiting", { who, by: spanText(next.late.byMinutes, language === "vi" ? "vi" : "en") })
    : t("fc.waitingOnTo", { who, act: said(next.says.act, language) });
  return (
    <p className="fg-body-sm pb-2 text-muted" title={said(next.says.reason, language)} data-testid="awaiting-release-turn">
      {line}
    </p>
  );
}

export function AwaitingReleaseCard({ slug, projectId }: { slug: string; projectId: string }) {
  const router = useRouter();
  const t = useCopy();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const read = useIssues(projectId, { status: ["awaiting_release"], sort: "createdAt:asc", pageSize: READ_LIMIT });
  const issues = read.data?.items ?? [];
  const total = read.data?.totalCount ?? issues.length;
  const visible = expanded ? issues : issues.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = issues.length - visible.length;
  const unread = total - issues.length;
  const selectedCount = selected.size;
  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));

  const selectedIssues: BatchReleaseIssue[] = issues
    .filter((i) => selected.has(i.id))
    .map((i) => ({ id: i.id, displayId: i.displayId, title: i.title }));

  const toggle = (issueId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(issueId);
      else next.delete(issueId);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of visible) {
        if (checked) next.add(i.id);
        else next.delete(i.id);
      }
      return next;
    });
  };

  return (
    <>
    <PageSection className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle py-3">
        <div className="flex items-center gap-2">
          <Icon name="check" size={16} className="text-subtle" />
          <PageSectionTitle>{t("overview.flow.awaiting_release")}</PageSectionTitle>
        </div>
        {total > 0 && <span className="fg-caption font-mono text-subtle" data-testid="awaiting-release-count">{total}</span>}
      </div>
      <PageSectionBody className="flex-1">
        {read.isSuccess && total === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">{t("overview.awaiting.empty")}</p>
        ) : (
          <>
            <DraftTurn projectId={projectId} />
            {visible.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={selectedCount > 0 && !allVisibleSelected}
                  onChange={toggleAllVisible}
                  ariaLabel={allVisibleSelected ? t("issues.bulk.clearSelection") : t("overview.awaiting.selectAll")}
                  label={allVisibleSelected ? t("overview.awaiting.clear") : t("overview.awaiting.selectAll")}
                />
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  disabled={selectedCount === 0}
                  onClick={() => setBatchDialogOpen(true)}
                >
                  {selectedCount > 0 ? t("overview.awaiting.releaseN", { n: selectedCount }) : t("overview.awaiting.release")}
                </Button>
              </div>
            )}
            <ul className="flex flex-col divide-y divide-line-subtle">
              {visible.map((i) => (
                <li key={i.id} className="flex items-center gap-2.5 py-2 transition-colors hover:bg-hover" data-testid="awaiting-release-issue">
                  <Checkbox
                    checked={selected.has(i.id)}
                    onChange={(checked) => toggle(i.id, checked)}
                    ariaLabel={t("overview.awaiting.select", { what: i.displayId })}
                  />
                  <button
                    type="button"
                    onClick={() => router.push(issueHref(slug, i.displayId))}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <StatusChip status="passed" domain="session" size="sm" />
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-muted">
                      <span className="font-mono text-fg">{i.displayId}</span> {i.title}
                    </span>
                    <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="fg-body-sm mt-2 w-full rounded-md py-1.5 text-center text-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                {t("overview.awaiting.showMore", { n: hiddenCount })}
              </button>
            )}
            {expanded && unread > 0 && (
              <Link
                href={`${issuesHref(slug)}?status=awaiting_release`}
                className="fg-body-sm mt-2 block text-center text-link hover:underline"
                data-testid="awaiting-release-all"
              >
                {t("overview.awaiting.onList", { n: unread })}
              </Link>
            )}
          </>
        )}
      </PageSectionBody>
    </PageSection>
    <BatchReleaseDialog
      projectId={projectId}
      selectedIssues={selectedIssues}
      open={batchDialogOpen}
      onClose={() => setBatchDialogOpen(false)}
      onSuccess={() => {
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: ["issues"] });
      }}
    />
    </>
  );
}
