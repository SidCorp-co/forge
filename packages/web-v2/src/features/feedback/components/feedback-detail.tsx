
// A feedback item's full page: its screenshots, recordings and the step it hits, then, while it waits
// on triage, its triage checklist's answers and gaps (REQ-34 r2 BC-5), the acts a person can take and
// what the reporter said (Overview), the mockups proposed about it (Mockups), and every decision on it
// with the triage it passed (Activity: past items, REQ-43 BC-8), as tabs beside the sticky facts rail.
// The header's badge says the phase; the page leads with what the badge does not say (when it is
// expected, the release that shipped it), then whose turn it is, once (BC-5). A person's view leaves
// the agent text out — the assistant's draft, where an answer came from — and `?view=developer` draws
// it (BC-7).

import { Written, WrittenMark } from "@/lib/i18n/written";
import type { ReactNode } from "react";
import {
  Button,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  enumLabel,
  FactsRail,
  type RecordView,
  RecordViewSwitch,
  StatusBadge,
  useRecordView,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { FeedbackChecklists } from "@/features/checklists";
import { IntakeDraft } from "@/features/intake";
import { MockupList } from "@/features/mockups";
import { useMockups } from "@/features/mockups";
import { Reproduction } from "@/features/previews";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useFeedbackForecasts } from "@/features/forecast";
import { useFeedbackItem } from "../hooks";
import type { FeedbackView } from "../types";
import { FeedbackActions, Proposals } from "./feedback-actions";
import { FeedbackAnswer } from "./feedback-answer";
import { FeedbackAttachments } from "./feedback-attachments";
import { FeedbackEvidence } from "./feedback-evidence";
import { FeedbackBanner, LinkedFeedback } from "./feedback-facts";
import { Messages } from "./feedback-messages";
import { FeedbackRoom } from "./feedback-room";

const FEEDBACK_TABS = ["overview", "mockups", "activity"] as const;
type FeedbackTab = (typeof FEEDBACK_TABS)[number];
export const useFeedbackTab = () => useUrlTab(FEEDBACK_TABS);

/** The one primary act the header and the peek offer: it opens the form that commits it. */
export function FeedbackPrimary({ f, onAct }: { f: FeedbackView; onAct: () => void }) {
  const t = useCopy();
  if (!f.can.triage && !f.can.verify && !f.can.reopen) return null;
  return (
    <Button type="button" variant="primary" size="sm" onClick={onAct} data-testid="feedback-primary">
      {f.can.triage ? t("feedback.act.triage") : t("feedback.act.confirmFix")}
    </Button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-14 font-semibold leading-snug text-fg">{children}</h2>;
}

function Body({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  return (
    <section data-highlight="evidence">
      <Heading>{t("feedback.body.heading")}</Heading>
      {f.redacted ? (
        <p className="text-13 text-subtle">{t("feedback.body.redacted")}</p>
      ) : (
        <p className="max-w-2xl whitespace-pre-wrap text-14 leading-relaxed" data-testid="feedback-body" lang={f.writtenLang ?? undefined}>
          {f.body?.trim() ? (
            <>
              {f.body}
              <WrittenMark lang={f.writtenLang} />
            </>
          ) : (
            <span className="text-subtle">{t("feedback.body.none")}</span>
          )}
        </p>
      )}
      <FeedbackAttachments projectId={projectId} f={f} />
    </section>
  );
}

export function FeedbackHistory({ f }: { f: FeedbackView }) {
  const t = useCopy();
  const time = useTimeFormat();
  const language = useInterfaceLanguage();
  if (f.decisions.length === 0) return <p className="text-13 text-subtle">{t("feedback.history.none")}</p>;
  return (
    <ol className="border-t border-line-subtle" data-testid="feedback-history">
      {[...f.decisions].reverse().map((d) => (
        <li key={`${d.decidedAt}-${d.decision}`} className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13">
          <span>
            <span className="font-semibold">{enumLabel("feedbackDecision", d.decision, language)}</span>
            {d.route ? t("feedback.history.as", { route: enumLabel("feedbackRoute", d.route, language).toLowerCase() }) : ""}
            {d.carrier ? <span className="font-mono"> {d.carrier}</span> : null}
            <span className="text-muted">
              {" "}
              · {d.decidedAgency === "system" ? t("feedback.history.automatic") : (d.decidedByName ?? d.decidedBy)}
              {d.decidedAgency === "agent" ? t("feedback.history.agent") : ""} · <span title={time.dateTime(d.decidedAt)}>{time.relative(d.decidedAt)}</span>
            </span>
          </span>
          {d.says.reason ? <span className="text-muted">{said(d.says.reason, language)}</span> : null}
          {d.acceptReason ? <span className="text-muted">{t("feedback.history.accepted", { reason: d.acceptReason })}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** The person / developer switch, at the right above the tabs. */
function ViewBar({ view, onView }: { view: RecordView; onView: (v: RecordView) => void }) {
  return (
    <div className="flex justify-end px-8 pt-3 max-md:px-4" data-testid="feedback-view-bar">
      <RecordViewSwitch view={view} onView={onView} />
    </div>
  );
}

export function FeedbackPage({
  projectId,
  slug,
  fbKey,
  tab,
  onTab,
}: {
  projectId: string;
  slug: string;
  fbKey: string;
  tab: FeedbackTab;
  onTab: (t: FeedbackTab) => void;
}) {
  const t = useCopy();
  const [view, onView] = useRecordView();
  const developer = view === "developer";
  const q = useFeedbackItem(projectId, fbKey);
  const forecasts = useFeedbackForecasts(projectId);
  const clock = useEtaClock();
  const mockups = useMockups(projectId, { type: "feedback", key: fbKey });
  return (
    <QueryBoundary query={q} loadingLabel={t("feedback.loading")}>
      {(data) => {
        const f = data.feedback;
        const tabs = [
          { value: "overview" as const, label: t("feedback.tab.overview") },
          { value: "mockups" as const, label: t("feedback.tab.mockups"), count: mockups.data?.returned },
          { value: "activity" as const, label: t("feedback.tab.activity") },
        ];
        // the triage checklist is the work while triage is owed; once passed, it is a past item
        const checklists = <FeedbackChecklists projectId={projectId} fbKey={f.key} canTriage={f.can.triage} developer={developer} />;
        return (
          <DetailLayout
            testId="feedback-detail"
            dataKey={f.key}
            rail={
              <FactsRail>
                {/* the forecast is the answer line's, above: the rail does not say when a second time */}
                <LinkedFeedback f={f} slug={slug} developer={developer} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={f.key} title={<Written text={f.title} lang={f.writtenLang} />} badge={<StatusBadge family="feedbackPhase" value={f.phase} />} />
            <FeedbackAnswer f={f} slug={slug} forecast={forecasts.data?.items.find((i) => i.key === f.key)} clock={clock} className="px-8 pt-4 pb-2 max-md:px-4" />
            <FeedbackBanner f={f} slug={slug} className="px-8 py-2.5 max-md:px-4" />
            <ViewBar view={view} onView={onView} />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="feedback-tabs" />
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("feedback.tab.overview")}>
              {tab === "mockups" ? <MockupList projectId={projectId} target={{ type: "feedback", key: f.key }} canPropose={!f.redacted} /> : null}
              {tab === "overview" ? (
                <div className="grid gap-8" data-testid="view-overview">
                  <FeedbackEvidence projectId={projectId} slug={slug} f={f} />
                  <Proposals projectId={projectId} f={f} />
                  {developer ? <IntakeDraft projectId={projectId} slug={slug} itemKey={f.key} assumptions /> : null}
                  {f.can.triage ? checklists : null}
                  {f.can.triage || f.can.verify || f.can.reopen || f.can.askVerify || f.can.redact ? (
                    <section id="feedback-act" data-highlight="triage verify">
                      <FeedbackActions projectId={projectId} f={f} />
                    </section>
                  ) : null}
                  <Body projectId={projectId} f={f} />
                  <Reproduction
                    projectId={projectId}
                    fbKey={f.key}
                    carriers={f.route?.route === "issue" ? f.route.carriers.flatMap((c) => (c.key ? [c.key] : [])) : []}
                    redacted={f.redacted}
                  />
                  <FeedbackRoom projectId={projectId} about={f.key} />
                  <Messages projectId={projectId} f={f} />
                </div>
              ) : null}
              {tab === "activity" ? (
                <section className="grid gap-8" aria-label={t("feedback.tab.activity")} data-testid="view-activity">
                  <FeedbackHistory f={f} />
                  {f.can.triage ? null : checklists}
                </section>
              ) : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}

