// One project's activity beside the list (ISS-951, MK-8 and MK-9): what its master's pane does and
// the dialog it is stopped on, what is in flight at its step, its backlog and why its last pass took
// none of it, what waits on the reader (a question by its own words), its release in flight or else
// its next release, its cleanup (ISS-1051), and a Recent list read only when opened. Titles and words a person reads; a record's key only in a link or a
// tooltip, never as text (ISS-951 round 4, the owner's UI rule), and never an id.

import type { OrgActivityEvent, OrgActivityProject, OrgActivityRelease, OrgActivityReleasingStage } from "@forge/contracts/org-activity";
import { type ReactNode, useState } from "react";
import { EnumBadge, enumLabel, type FullPage, LEGEND, PeekHead, PeekPanel, type PeekState, RowItem, RowList, StatusBadge, statusReading } from "@/design";
import { useCopy, useCopyLocale, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { issueHref } from "@/lib/routes/issues";
import { formatAge } from "@/lib/utils/format";
import { useProjectRecent } from "../hooks";
import { CleanupPart } from "./cleanup";
import { answerHref } from "./marks";
import { Doing, PaneMark } from "./pane";

/** A release run in flight's stage, in the legend's tones: running until it shipped. */
const RELEASING_TONE: Record<OrgActivityReleasingStage, "run" | "ready"> = { cut: "run", deploying: "run", shipped: "ready" };

/** Shipped (solid) over shipped-or-awaiting (lighter), and `shipped/total`; the scope's name on hover. */
export function ReleaseBar({ release }: { release: OrgActivityRelease }) {
  const t = useCopy();
  const pct = (n: number) => (release.total > 0 ? Math.round((n / release.total) * 100) : 0);
  const name = release.title ?? t("activity.release.draft");
  return (
    <span className="inline-flex items-center gap-2" title={name} data-testid="activity-release-bar">
      <span
        role="img"
        aria-label={t("activity.release.progress", { name, shipped: release.shipped, total: release.total })}
        className="relative block h-1 w-14 flex-none overflow-hidden rounded-pill bg-sunken"
      >
        <span className="absolute inset-y-0 left-0 bg-accent-7" style={{ width: `${pct(release.shipped + release.awaitingRelease)}%` }} />
        <span className="absolute inset-y-0 left-0 bg-ok-9" style={{ width: `${pct(release.shipped)}%` }} />
      </span>
      <span aria-hidden className="font-mono text-12 tabular-nums text-muted">
        {release.shipped}/{release.total}
      </span>
    </span>
  );
}

function Part({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section className="px-4.5 pt-4" aria-label={label}>
      <h3 className="flex items-baseline justify-between pb-1.5 text-11-5 font-semibold uppercase tracking-wide text-subtle">
        {label}
        {count > 0 ? <span className="font-mono normal-case tracking-normal">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Nothing() {
  return <p className="py-1.5 text-13 text-subtle">—</p>;
}

/** An event as one short line: what happened and the title of the issue it was on. */
function useEventLine() {
  const t = useCopy();
  const language = useInterfaceLanguage();
  return (e: OrgActivityEvent): string => {
    const on = e.issueTitle ? ` · ${e.issueTitle}` : "";
    switch (e.kind) {
      case "pass_opened":
        return `${t("activity.event.passOpened")}${e.verb ? ` · ${enumLabel("masterVerb", e.verb, language)}` : ""}${on}`;
      case "pass_settled":
        return `${t("activity.event.passSettled")} · ${t("activity.event.dispatched", { n: e.dispatched ?? 0 })}`;
      case "status":
        return `${e.issueTitle ?? ""} → ${e.to ? statusReading("issue", e.to, language).label : ""}`.trim();
      case "merged":
        return `${t("activity.event.merged")}${on}`;
      case "change_request":
        return `${t("activity.event.changeRequest")} ${e.ref ?? ""}${on}`;
      case "run_started":
        return `${t("activity.event.runStarted")}${on}`;
      case "run_ended":
        return `${t("activity.event.runEnded")}${on}`;
      case "dialog_started":
        return t("activity.event.dialogStarted");
      case "dialog_ended":
        return t("activity.event.dialogEnded");
    }
  };
}

function Recent({ orgId, projectId }: { orgId: string; projectId: string }) {
  const t = useCopy();
  const locale = useCopyLocale();
  const [open, setOpen] = useState(false);
  const q = useProjectRecent(orgId, projectId, open);
  const line = useEventLine();
  const items = q.data?.items ?? [];
  return (
    <details className="px-4.5 pt-4" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="activity-recent">
      <summary className="flex cursor-pointer list-none items-baseline justify-between pb-1.5 text-11-5 font-semibold uppercase tracking-wide text-subtle">
        {t("activity.recent")}
        {open && items.length > 0 ? <span className="font-mono normal-case tracking-normal">{items.length}</span> : null}
      </summary>
      {!open ? null : q.isLoading ? (
        <p className="py-1.5 text-13 text-subtle">…</p>
      ) : items.length === 0 ? (
        <Nothing />
      ) : (
        <RowList label={t("activity.recent")}>
          {items.map((e) => (
            <RowItem
              key={`${e.at}:${e.kind}:${e.issueKey ?? e.ref ?? ""}`}
              rowKey={`${e.at}:${e.kind}`}
              title={line(e)}
              tip={e.issueKey ?? undefined}
              lead={<span className="font-normal text-subtle">{new Date(e.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>}
            />
          ))}
        </RowList>
      )}
    </details>
  );
}

export function ActivityPeek({ row, orgId, peek, full, now }: { row: OrgActivityProject; orgId: string; peek: PeekState; full: FullPage; now: number }) {
  const t = useCopy();
  const m = row.master;
  return (
    <PeekPanel peek={peek} listLabel={t("activity.title")} noun={t("activity.noun")} full={full} testId="activity-peek">
      <PeekHead noun={t("activity.noun")} itemKey="" badge={<PaneMark master={m} now={now} />} title={row.name} />
      <div className="flex flex-col gap-1 px-4.5 text-13 text-muted">
        {m.doing ? <Doing master={m} /> : null}
        {m.dialog ? (
          <span className="truncate text-12" style={{ color: LEGEND.you.fg }} title={m.dialog} data-testid="activity-dialog">
            {m.dialog}
          </span>
        ) : null}
      </div>
      <Part label={t("activity.col.now")} count={row.now.length}>
        {row.now.length === 0 ? (
          <Nothing />
        ) : (
          <RowList label={t("activity.col.now")}>
            {row.now.map((n) => (
              <RowItem
                key={n.issueId}
                rowKey={n.issueId}
                title={n.title}
                tip={n.key}
                href={issueHref(row.slug, n.key)}
                trailing={
                  <>
                    {n.step ? <EnumBadge family="step" value={n.step} /> : <StatusBadge family="issue" value={n.status} />}
                    {n.stepSince ? (
                      <span className="font-mono text-11-5 text-subtle" title={t("activity.stepSince")}>
                        {formatAge(n.stepSince, now)}
                      </span>
                    ) : null}
                  </>
                }
              />
            ))}
          </RowList>
        )}
      </Part>
      <Part label={t("activity.col.backlog")} count={row.next.total}>
        {row.next.skip ? (
          <p className="pb-1 text-12" style={{ color: LEGEND.you.fg }} data-testid="activity-skip-line">
            {t("activity.skip.title", { why: t(`activity.skip.${row.next.skip}`) })}
          </p>
        ) : null}
        {row.next.items.length === 0 ? (
          <Nothing />
        ) : (
          <RowList label={t("activity.col.backlog")}>
            {row.next.items.map((n) => (
              <RowItem
                key={n.issueId}
                rowKey={n.issueId}
                title={n.title}
                tip={n.key}
                href={issueHref(row.slug, n.key)}
                trailing={n.priority ? <EnumBadge family="priority" value={n.priority} /> : null}
              />
            ))}
          </RowList>
        )}
      </Part>
      <Part label={t("activity.col.people")} count={row.people.total}>
        {row.people.items.length === 0 ? (
          <Nothing />
        ) : (
          <RowList label={t("activity.col.people")}>
            {row.people.items.map((d) => (
              <RowItem
                key={d.decisionId}
                rowKey={d.decisionId}
                title={d.title}
                tip={d.key ? `${d.key} · ${d.title}` : d.title}
                href={answerHref(row.slug, d)}
                trailing={<span className="text-12 font-medium" style={{ color: LEGEND.you.fg }}>{t(`activity.people.${d.group}`)}</span>}
              />
            ))}
          </RowList>
        )}
      </Part>
      {row.awaitingRelease > 0 ? (
        <Part label={t("activity.release.toRelease")} count={row.awaitingRelease}>
          {null}
        </Part>
      ) : null}
      {row.releasing ? (
        <Part label={t("activity.release.inFlight")} count={0}>
          <div className="flex items-center justify-between gap-3" data-testid="activity-releasing" data-stage={row.releasing.stage}>
            <span className="min-w-0 truncate font-mono text-13">{row.releasing.version}</span>
            <span className="text-12 font-medium" style={{ color: LEGEND[RELEASING_TONE[row.releasing.stage]].fg }}>
              {t(`activity.release.stage.${row.releasing.stage}`)}
            </span>
          </div>
        </Part>
      ) : row.release || row.releasePending ? (
        <Part label={t("activity.release.next")} count={0}>
          {row.release ? (
            <div className="flex items-center justify-between gap-3" data-testid="activity-release">
              <span className="min-w-0 truncate text-13">{row.release.title ?? t("activity.release.draft")}</span>
              <ReleaseBar release={row.release} />
            </div>
          ) : (
            <p className="py-1.5 text-13 text-subtle">…</p>
          )}
        </Part>
      ) : null}
      <CleanupPart projectId={row.projectId} now={now} />
      <Recent orgId={orgId} projectId={row.projectId} />
      <div className="pb-4" />
    </PeekPanel>
  );
}
