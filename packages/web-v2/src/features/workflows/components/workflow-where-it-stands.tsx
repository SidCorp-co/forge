// Where a design stands, as marks (REQ-10, REQ-43, ISS-781): who it waits on and what is next (its
// step is the header's pill, said once), whether it is approved, its requirement, whether the code matches, and what Needs you counts
// on it; and the one act that roots a design no requirement roots yet.

import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import type { ReactNode } from "react";
import { Button, Fact, FactsGroup, Icon } from "@/design";
import { TONE_META } from "@/design/status";
import { formatApiError } from "@/lib/api/error";
import { refusalsOf } from "@/lib/api/refusals";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { Link, useRouter } from "@/lib/navigation/router";
import { requirementHref } from "@/lib/routes/requirements";
import { useDraftRequirementFromDesign, useLinkRequirementToDesign } from "../hooks";
import type { WorkflowDesign } from "../types";

/**
 * FB-86: a design no requirement roots offers to draft one from it: a requirement titled after the
 * design and linked to it at birth, which the assistant then drafts from the design (REQ-34 BC-10).
 */
function DraftFromDesign({ projectId, slug, workflowId, flow, title }: { projectId: string; slug: string; workflowId: string; flow: string; title: string }) {
  const t = useCopy();
  const router = useRouter();
  const create = useDraftRequirementFromDesign(projectId, workflowId);
  const refused = create.error ? (refusalsOf(create.error)[0]?.detail ?? formatApiError(create.error)) : null;
  return (
    <div className="mt-2 grid gap-1">
      <Button size="sm" variant="secondary" loading={create.isPending} onClick={() => create.mutate({ title, designs: [flow] }, { onSuccess: (r) => router.push(requirementHref(slug, r.key)) })} data-testid="draft-from-design">
        {t("workflows.facts.draftRequirement")}
      </Button>
      {refused ? (
        <p role="alert" className="text-13 text-danger-11">
          {refused}
        </p>
      ) : null}
    </div>
  );
}

/** ISS-805: the project's requirement named after this design is linked to it, rather than a second one drafted. */
function LinkRequirement({ projectId, workflowId, match }: { projectId: string; workflowId: string; match: { key: string; title: string } }) {
  const t = useCopy();
  const link = useLinkRequirementToDesign(projectId, workflowId);
  const refused = link.error ? (refusalsOf(link.error)[0]?.detail ?? formatApiError(link.error)) : null;
  return (
    <div className="mt-2 grid gap-1">
      <Button size="sm" variant="secondary" loading={link.isPending} onClick={() => link.mutate(match.key)} title={match.title} data-testid="link-requirement">
        {t("workflows.facts.linkRequirement", { key: match.key })}
      </Button>
      {refused ? (
        <p role="alert" className="text-13 text-danger-11">
          {refused}
        </p>
      ) : null}
    </div>
  );
}

type Stand = "yes" | "no" | "differs";

const STAND: Record<Stand, { icon: "check" | "dot" | "alert"; colour: string }> = {
  yes: { icon: "check", colour: TONE_META.success.fg },
  no: { icon: "dot", colour: TONE_META.neutral.fg },
  differs: { icon: "alert", colour: TONE_META.attention.fg },
};

/** One fact of Where it stands: a mark and at most three words, never a sentence (REQ-43 BC-1, BC-4). */
function StandingMark({ label, stand, testId, title, children }: { label: string; stand: Stand; testId: string; title?: string | undefined; children: ReactNode }) {
  const m = STAND[stand];
  return (
    <Fact label={label} testId={testId}>
      <span className="inline-flex min-w-0 items-center gap-1.5" title={title} data-stand={stand}>
        <span className="flex-none" style={{ color: m.colour }} aria-hidden>
          <Icon name={m.icon} size={14} />
        </span>
        {children}
      </span>
    </Fact>
  );
}

/** Whether the code matches the approved design, as a mark and a word or two. */
export function codeMatchOf(health: WorkflowHealth | undefined): { stand: Stand; key: ProductCopyKey } {
  if (!health || !health.rooted.rooted || health.observation === null) return { stand: "no", key: "workflows.stands.notCompared" };
  if (health.markers.length > 0) return { stand: "differs", key: "workflows.stands.differs" };
  if (health.reconciliation.state === "reconciled") return { stand: "yes", key: "workflows.stands.matches" };
  return { stand: "no", key: "workflows.stands.notConfirmed" };
}

/**
 * Who the design waits on and what is next, read off core's design standing
 * (`workflows/design-standing.ts:designWaitingOn`), never derived here: "Design approver · approve or
 * return the design" on a proposed design; on one whose step owes nobody, what it still owes a person
 * as Needs you lists it on the design (pin-only changes to approve, places the code and the design
 * differ), and "Nobody · nothing next" only where nothing is owed (REQ-68 BC-5; ISS-687 c2, judged
 * short at dev.485 for saying neither, and at dev.489 for "Nobody · nothing next" beside "Needs you 2").
 * The step is the header's design pill, said once on the page (REQ-43 BC-5), never again here.
 */
function WaitsOnMark({ d }: { d: WorkflowDesign }) {
  const t = useCopy();
  const w = saidView(d.waitingOn, useInterfaceLanguage());
  const stand: Stand = w.kind === "none" ? "yes" : w.kind === "you" || w.kind === "person" ? "differs" : "no";
  return (
    <StandingMark label={t("workflows.stands.waitsOn")} stand={stand} testId="stands-waits-on" title={w.rule}>
      <span className="min-w-0">
        {w.who} · {w.act || t("workflows.stands.nothingNext")}
      </span>
    </StandingMark>
  );
}

/** Where the design stands, as marks (REQ-10, ISS-781): approved, its requirement, whether the code matches. */
export function WhereItStands({ d, health, slug, projectId, title }: { d: WorkflowDesign; health: WorkflowHealth | undefined; slug: string; projectId: string | undefined; title: string }) {
  const t = useCopy();
  const time = useTimeFormat();
  const approved = d.revisions.find((r) => r.revision === d.approvedRevision) ?? null;
  const by = approved ? [approved.decidedByName, approved.decidedAt ? time.dateTime(approved.decidedAt) : null].filter(Boolean).join(" · ") : undefined;
  const code = codeMatchOf(health);
  return (
    <FactsGroup title={t("workflows.facts.whereItStands")} testId="facts-plain-status">
      <div data-testid="plain-status">
        <WaitsOnMark d={d} />
        {/* the header pill says the design's state, so a draft's "not approved" is not said again; the row stays where an earlier revision is approved and the pill says something else (ISS-805) */}
        {d.approvedRevision !== null && d.status !== "approved" ? (
          <StandingMark label={t("workflows.facts.approved")} stand="yes" testId="stands-approved" title={by || undefined}>
            {t("workflows.stands.yes")}
          </StandingMark>
        ) : null}
        <StandingMark label={t("workflows.facts.requirement")} stand={d.requirements.length ? "yes" : "no"} testId="stands-requirement">
          {d.requirements.length ? (
            d.requirements.map((r) => (
              <Link key={r.key} href={requirementHref(slug, r.key)} className="font-mono text-12 font-semibold text-link hover:underline" title={r.title}>
                {r.key}
              </Link>
            ))
          ) : (
            <span className="text-muted">{t("workflows.facts.none")}</span>
          )}
        </StandingMark>
        <StandingMark label={t("workflows.stands.code")} stand={code.stand} testId="stands-code">
          {t(code.key)}
        </StandingMark>
        {health && health.needsYou > 0 ? (
          <StandingMark label={t("workflows.needsYou")} stand="differs" testId="stands-needs-you">
            {String(health.needsYou)}
          </StandingMark>
        ) : null}
        {/* the act follows the marks, never sits between them; a match is linked before a new one is offered (ISS-805) */}
        {d.requirements.length === 0 && d.canDraftRequirement && projectId ? (
          d.matchingRequirement ? (
            <LinkRequirement projectId={projectId} workflowId={d.workflowId} match={d.matchingRequirement} />
          ) : (
            <DraftFromDesign projectId={projectId} slug={slug} workflowId={d.workflowId} flow={d.flow} title={title} />
          )
        ) : null}
      </div>
    </FactsGroup>
  );
}
