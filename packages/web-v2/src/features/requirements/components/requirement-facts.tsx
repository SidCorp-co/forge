"use client";

// The at-a-glance facts of one requirement: status, owner, revision, issues, feedback, designs,
// needs and dates; whose turn, the lifecycle step and the verified count ride the strip above the
// main column (`standing-bits.tsx:RequirementProgress`), so the rail does not repeat them. The full page's sticky rail and the peek
// draw this one component through the shared FactsGroup/Fact rows, so the main column never repeats a
// fact and both surfaces read the same.

import Link from "next/link";
import { ActorChip, Fact, FactsEmpty, FactsGroup, LEGEND, StatusBadge, Tooltip } from "@/design";
import { FeedbackRailItem } from "@/features/feedback/components/feedback-rail-item";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { workflowHref } from "@/lib/routes/workflows";
import { useCopy, useLabel, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import type { FeedbackRoute } from "@forge/contracts/feedback";
import type { ScopeForecast } from "@forge/contracts/forecast";
import { ReleaseLine } from "@/features/forecast/components/release-line";
import { progressText } from "@/features/forecast/progress";
import { criteriaRestText } from "@/features/forecast/text";
import { useEtaClock, useRequirementForecast } from "@/features/forecast/hooks";
import type { RequirementDetail, RequirementFeedbackItem } from "../types";
import { LinkIssueControl } from "./link-issue";
import { PromoteDraftRow } from "./promote-drafts";
import { agreedTitle } from "./standing-bits";

/** "3 of 5 criteria proven · rest forecast live 14:10 – 18:50 today": the proof so far, then when the rest is in people's hands. */
export function CriteriaRest({ passing, criteria, scope, slug, className = "pb-1.5" }: { passing: number; criteria: number; scope: ScopeForecast; slug: string; className?: string }) {
  const read = criteriaRestText(passing, criteria, scope, useEtaClock());
  if (!read) return null;
  return (
    <p className={className} data-testid="facts-forecast">
      <ReleaseLine said={read} slug={slug} className="fg-body-sm text-muted" testId="criteria-rest-line" />
    </p>
  );
}

/** "On ISS-4", "On design checkout": where a feedback item reached the requirement from; one about it, or carried by its route, says nothing. */
const VIA_KEY: Partial<Record<RequirementFeedbackItem["via"]["type"], ProductCopyKey>> = {
  issue: "requirements.facts.via.issue",
  workflow: "requirements.facts.via.workflow",
  release: "requirements.facts.via.release",
};

/** Where a carrier's key links: an issue, a requirement or a root item; a revision suggestion has no page. */
function carrierHrefOf(route: FeedbackRoute, slug: string, key: string): string | null {
  if (route === "issue") return issueHref(slug, key);
  if (route === "new_requirement") return requirementHref(slug, key);
  return route === "duplicate" ? feedbackHref(slug, key) : null;
}

function FeedbackRow({ f, slug }: { f: RequirementFeedbackItem; slug: string }) {
  const t = useCopy();
  const label = useLabel();
  const r = f.route;
  const carriers = r ? r.carriers.flatMap((c) => (c.key && carrierHrefOf(r.route, slug, c.key) ? [{ key: c.key, href: carrierHrefOf(r.route, slug, c.key) as string }] : [])) : [];
  const viaKey = VIA_KEY[f.via.type];
  const via = viaKey ? t(viaKey, { key: f.via.key }) : null;
  return (
    <FeedbackRailItem slug={slug} itemKey={f.key} title={f.title} phase={f.phase}>
      {via || r ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-12 text-muted" data-testid="rail-feedback-route">
          {via ? <span>{via}</span> : null}
          {via && r ? <span aria-hidden>·</span> : null}
          {r ? <span>{label("feedbackRoute", r.route)}</span> : null}
          {carriers.map((c) => (
            <Link key={c.key} href={c.href} className="font-mono text-link hover:underline">
              {c.key}
            </Link>
          ))}
        </span>
      ) : null}
    </FeedbackRailItem>
  );
}

function FeedbackFacts({ items, slug }: { items: RequirementFeedbackItem[]; slug: string }) {
  const t = useCopy();
  const open = items.filter((f) => f.open);
  const closed = items.filter((f) => !f.open);
  return (
    <FactsGroup title={t("requirements.facts.feedback")} count={items.length ? t("requirements.facts.openOf", { a: open.length, b: items.length }) : undefined} testId="facts-feedback">
      {items.length === 0 ? (
        <FactsEmpty>{t("requirements.facts.noFeedback")}</FactsEmpty>
      ) : (
        <>
          {open.length ? (
            <ul className="grid gap-1.5">
              {open.map((f) => (
                <FeedbackRow key={f.id} f={f} slug={slug} />
              ))}
            </ul>
          ) : (
            <FactsEmpty>{t("requirements.facts.noOpenFeedback")}</FactsEmpty>
          )}
          {closed.length ? (
            <details className="mt-2" data-testid="rail-feedback-closed">
              <summary className="cursor-pointer select-none text-12-5 font-medium text-muted hover:text-fg">{t("requirements.facts.closedN", { n: closed.length })}</summary>
              <ul className="mt-1.5 grid gap-1.5">
                {closed.map((f) => (
                  <FeedbackRow key={f.id} f={f} slug={slug} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </FactsGroup>
  );
}

type Shipped = { version: string; at: string };

/** The releases that shipped the requirement's issues, each a link; nothing while none has (FB-102). */
export function RequirementShipped({ releases, slug }: { releases: readonly Shipped[]; slug: string }) {
  const t = useCopy();
  if (releases.length === 0) return null;
  return (
    <div data-testid="facts-shipped-in">
      <Fact label={t("issues.shippedIn")}>
        <span className="flex flex-wrap gap-x-2 gap-y-0.5">
          {releases.map((r) => (
            <Link key={r.version} href={releaseHref(slug, r.version)} className="font-mono text-12 text-link hover:underline">
              {r.version}
            </Link>
          ))}
        </span>
      </Fact>
    </div>
  );
}

/** The release that shipped one of its issues, beside the issue's status. */
export function IssueShippedLink({ shippedIn, slug }: { shippedIn: Shipped; slug: string }) {
  const t = useCopy();
  return (
    <Link
      href={releaseHref(slug, shippedIn.version)}
      aria-label={`${t("issues.shippedIn")} ${shippedIn.version}`}
      title={`${t("issues.shippedIn")} ${shippedIn.version}`}
      className="flex-none font-mono text-11 text-link hover:underline"
    >
      {shippedIn.version}
    </Link>
  );
}

export function RequirementFacts({
  d,
  slug,
  onOpenRevisions,
  projectId,
}: {
  d: RequirementDetail;
  slug: string;
  /** Reads when its issues are forecast to have landed. */
  projectId: string;
  /** Opens the revisions view; the peek, which has none, leaves it out and the revision reads as text. */
  onOpenRevisions?: () => void;
}) {
  const t = useCopy();
  const label = useLabel();
  const time = useTimeFormat();
  const forecast = useRequirementForecast(projectId, d.key).data;
  const s = d.standing;
  const f = s.facts;
  const baseline = d.baselines[0];
  const needs = baseline?.pins.filter((p) => p.kind === "contract-version") ?? [];
  const open = f.proposedRevision ?? f.draftRevision;
  return (
    <div data-testid="requirement-facts">
      <FactsGroup title={t("requirements.facts.status")}>
        <Fact label={t("requirements.facts.state")}>
          <StatusBadge family="requirement" value={s.state} />
        </Fact>
        <Fact label={t("requirements.facts.owner")}>
          {s.owner ? <ActorChip name={s.owner.name ?? t("requirements.unknown")} kind={s.owner.kind} /> : <span className="text-subtle">{t("requirements.noOwner")}</span>}
        </Fact>
        <RequirementShipped releases={d.releases} slug={slug} />
        <Fact label={t("requirements.facts.current")}>
          <span>{d.currentRevision !== null ? `r${d.currentRevision}` : t("requirements.facts.noneAccepted")}</span>
        </Fact>
        {d.request ? (
          <Fact label={t("requirements.facts.requestedBy")}>
            <span title={t("requirements.facts.requestTitle", { contract: d.request.contract })}>{d.request.project}</span>
          </Fact>
        ) : null}
        {open !== null ? (
          <Fact label={t(f.proposedRevision !== null ? "requirements.facts.proposed" : "requirements.facts.inDraft")}>
            {onOpenRevisions ? (
              <button type="button" onClick={onOpenRevisions} className="text-link hover:underline" data-testid="facts-open-revision">
                r{open}
              </button>
            ) : (
              <span>r{open}</span>
            )}
          </Fact>
        ) : null}
      </FactsGroup>

      <FactsGroup title={t("requirements.facts.issues")} count={f.issuesTotal && forecast ? progressText(forecast.progress, t) : undefined} testId="facts-issues">
        {d.issues.length > 0 && forecast?.forecast ? <CriteriaRest passing={f.passing} criteria={f.criteria} scope={forecast} slug={slug} /> : null}
        {d.issues.length === 0 ? (
          <FactsEmpty>{t("requirements.facts.notBrokenDown")}</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.issues.map((i) => (
              <li key={i.issueId} className="flex min-w-0 items-center gap-1.5 text-13" data-testid="rail-issue">
                <Link href={issueHref(slug, i.displayId)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
                  {i.displayId}
                </Link>
                <span className="min-w-0 flex-1 truncate" title={i.changedSincePlan ? t("requirements.facts.plannedOn", { title: i.title, r: i.plannedRevision ?? "—" }) : i.title}>
                  {i.title}
                </span>
                {i.changedSincePlan ? (
                  <span role="img" aria-label={t("requirements.facts.changedSincePlan")} title={t("requirements.facts.changedSincePlan")} className="size-1.5 flex-none rounded-full" style={{ background: LEGEND.you.dot }} />
                ) : null}
                <StatusBadge family="issue" value={i.status} tone={i.tone} />
                {i.shippedIn ? <IssueShippedLink shippedIn={i.shippedIn} slug={slug} /> : null}
                <PromoteDraftRow projectId={projectId} d={d} issue={i} />
              </li>
            ))}
          </ul>
        )}
        {s.attentionGroup !== "done" ? <LinkIssueControl projectId={projectId} reqKey={d.key} /> : null}
      </FactsGroup>

      <FeedbackFacts items={d.feedback} slug={slug} />

      <FactsGroup title={t("requirements.facts.design")} testId="facts-design">
        {d.workflows.length === 0 ? (
          <FactsEmpty>{t("requirements.facts.noDesign")}</FactsEmpty>
        ) : (
          <ul className="grid gap-1">
            {d.workflows.map((w) => (
              <li key={w.workflowId} className="flex min-w-0 items-center gap-1.5 text-13">
                <Link href={workflowHref(slug, w.flow)} className="min-w-0 flex-1 truncate text-link hover:underline">
                  {w.title}
                </Link>
                {w.designStatus ? (
                  <Tooltip label={w.approvedRevision !== null ? t("requirements.facts.newestApproved", { r: w.approvedRevision }) : t("requirements.facts.noApproved")}>
                    <span className="inline-flex">
                      <StatusBadge family="design" value={w.designStatus} />
                    </span>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </FactsGroup>

      {d.bindings.length > 0 ? (
        <FactsGroup title={t("requirements.facts.bindings")} count={`${d.bindings.length}`} testId="facts-bindings">
          <ul className="grid gap-1">
            {d.bindings.map((b) => (
              <li
                key={`${b.workflowId}|${b.step}|${b.contract}|${b.element}`}
                className="grid min-w-0 gap-0.5 text-13"
                data-testid="rail-binding"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate" title={t("requirements.facts.bindingTitle", { flow: b.flow, r: b.designRevision, step: b.step, contract: `${b.contract}${b.pinnedVersion ? `@${b.pinnedVersion}` : ""}` })}>
                    {b.step} <span className="font-mono text-12 text-subtle">{b.element}</span>
                  </span>
                  {b.brokenBy ? (
                    <span className="flex-none text-12 text-danger" title={t("requirements.facts.brokeTitle", { contract: b.contract, v: b.brokenBy })}>
                      {t("requirements.facts.brokenBy", { v: b.brokenBy })}
                    </span>
                  ) : null}
                </span>
                {b.buildingIssues.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1 text-12 text-subtle" data-testid="rail-binding-builds">
                    {t("requirements.facts.builtBy")}
                    {b.buildingIssues.map((i) => (
                      <Link key={i.issueId} href={issueHref(slug, i.displayId)} title={`${i.title} (${label("issueStatus", i.status)})`} className="font-mono text-link hover:underline">
                        {i.displayId}
                      </Link>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </FactsGroup>
      ) : null}

      {needs.length > 0 ? (
        <FactsGroup title={t("requirements.facts.needs")}>
          <ul className="grid gap-1">
            {needs.map((p) => (
              <li key={`${p.contractSlug}@${p.contractVersion}`} className="font-mono text-12" title={t("requirements.facts.pinned")}>
                {p.contractSlug} ≥ {p.contractVersion}
              </li>
            ))}
          </ul>
        </FactsGroup>
      ) : null}

      <div className="border-t border-line-subtle pt-3 text-12 text-subtle" data-testid="facts-dates">
        <span title={time.dateTime(d.createdAt)}>{t("requirements.facts.created", { when: time.relative(d.createdAt) })}</span>
        {baseline ? (
          <>
            {" · "}
            <span title={agreedTitle(t, time.dateTime(baseline.agreedAt), baseline.agreedByName)}>
              {t("requirements.facts.agreedR", { r: baseline.revision, when: time.relative(baseline.agreedAt) })}
            </span>
          </>
        ) : null}
        {" · "}
        <span title={time.dateTime(s.touchedAt)}>{t("requirements.facts.updated", { when: time.relative(s.touchedAt) })}</span>
      </div>
    </div>
  );
}
