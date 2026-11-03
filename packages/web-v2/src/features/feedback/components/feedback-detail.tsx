
// A feedback item's full page: its screenshots, recordings and the step it hits, then, while it waits
// on triage, its triage checklist's answers and gaps (REQ-34 r2 BC-5), what the reporter said, and
// Reproduce and Messages shut to one line each (Overview); the acts open on demand (feedback-acts.tsx),
// never inline (ISS-903); the mockups proposed about it (Mockups), and every decision on it
// with the triage it passed (Activity: past items, REQ-43 BC-8), as tabs beside the sticky facts rail.
// The header's badge says the phase; the page leads with what the badge does not say (when it is
// expected, the release that shipped it), then whose turn it is, once (BC-5), then its progress: is
// work on it running, what carries it, and its estimate or why it has none. Overview also asks the
// reporter a clarification and lists the similar items already filed. A person's view leaves
// the agent text out — the assistant's draft, where an answer came from — and `?view=developer` draws
// it (BC-7).

import { Written, WrittenMark } from "@/lib/i18n/written";
import type { ReactNode } from "react";
import {
  DetailDrawer,
  Disclosure,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  enumLabel,
  FactsRail,
  StatusBadge,
  useRecordView,
  useRecordViewCommands,
  useUrlParams,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { FEEDBACK_UNTRIAGED_PHASES } from "@forge/contracts/feedback";
import { FeedbackChecklists } from "@/features/checklists";
import { IntakeDraft, ValueCheck } from "@/features/intake";
import { MockupList } from "@/features/mockups";
import { useMockups } from "@/features/mockups";
import { REPRODUCE_PARAM, Reproduction } from "@/features/previews";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useFeedbackForecasts } from "@/features/forecast";
import { useFeedbackItem } from "../hooks";
import type { FeedbackView } from "../types";
import { Proposals } from "./feedback-actions";
import { actLabel, FeedbackActSheet, FeedbackPaletteActs } from "./feedback-acts";
import { FeedbackAnswer } from "./feedback-answer";
import { FeedbackOccurrences } from "./feedback-occurrences";
import { FeedbackAttachments } from "./feedback-attachments";
import { FeedbackEvidence } from "./feedback-evidence";
import { FeedbackQuestions } from "./feedback-questions";
import { ClarifyReporter } from "./feedback-clarify";
import { FeedbackBanner, LinkedFeedback } from "./feedback-facts";
import { StewardNoteLines, useStewardNote } from "@/features/standing";
import { Messages } from "./feedback-messages";
import { FeedbackProgress } from "./feedback-progress";
import { FeedbackRoom } from "./feedback-room";
import { FeedbackStewardActs } from "./feedback-steward-acts";
import { SimilarFeedback } from "./feedback-similar";

const FEEDBACK_TABS = ["overview", "mockups", "activity"] as const;
type FeedbackTab = (typeof FEEDBACK_TABS)[number];
export const useFeedbackTab = () => useUrlTab(FEEDBACK_TABS);

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
      <FeedbackOccurrences f={f} />
    </section>
  );
}

/** Reproduce and the POC room, one fold shut until a reproduce rides the address. */
function ReproduceFold({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const [params] = useUrlParams();
  return (
    <Disclosure title={t("previews.reproduce.title")} defaultOpen={params.has(REPRODUCE_PARAM)} testId="feedback-reproduce" highlight="reproduce">
      <div className="grid gap-4">
        <Reproduction
          projectId={projectId}
          fbKey={f.key}
          carriers={f.route?.route === "issue" ? f.route.carriers.flatMap((c) => (c.key ? [c.key] : [])) : []}
          redacted={f.redacted}
        />
        <FeedbackRoom projectId={projectId} about={f.key} />
      </div>
    </Disclosure>
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
        <li key={d.id} className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13">
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
  const language = useInterfaceLanguage();
  const [view, onView] = useRecordView();
  const developer = view === "developer";
  useRecordViewCommands(view, onView);
  const q = useFeedbackItem(projectId, fbKey);
  const note = useStewardNote(projectId, "feedback", fbKey);
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
        // the triage checklist is the work while triage is owed and the reader may triage; once the item is
        // past triage it is a past item, whoever reads it, and sits under Activity (REQ-43 BC-8)
        const checklists = <FeedbackChecklists projectId={projectId} fbKey={f.key} canTriage={f.can.triage} developer={developer} />;
        const triageOwed = f.can.triage && (FEEDBACK_UNTRIAGED_PHASES as readonly string[]).includes(f.phase);
        // the suggested triage is the act sheet's where the reader has one, the page's where they read it only
        const acts = actLabel(f, t, language) !== null;
        return (
          <article className="min-h-full bg-app" data-testid="feedback-detail" data-key={f.key}>
            <FeedbackActSheet projectId={projectId} f={f} />
            <FeedbackPaletteActs projectId={projectId} f={f} />
            <DetailMobileTitle title={<span title={f.key}><Written text={f.title} lang={f.writtenLang} /></span>} badge={<StatusBadge family="feedbackPhase" value={f.phase} />} />
            <FeedbackAnswer f={f} slug={slug} forecast={forecasts.data?.items.find((i) => i.key === f.key)} clock={clock} className="px-8 pt-4 pb-2 max-md:px-4" />
            <FeedbackBanner f={f} slug={slug} className="px-8 py-2.5 max-md:px-4" />
            <StewardNoteLines note={note} slug={slug} className="px-8 max-md:px-4" />
            <FeedbackProgress projectId={projectId} slug={slug} fbKey={f.key} className="px-8 pt-3 pb-1 max-md:px-4" />
            {/* the facts are the Properties drawer's, the person / developer switch the palette's (ISS-903) */}
            <div className="flex items-end justify-between gap-3 pr-8 pt-3 max-md:pr-4" data-testid="feedback-tabs-bar">
              <div className="min-w-0 flex-1">
                <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="feedback-tabs" />
              </div>
              <DetailDrawer label={t("common.properties")} testId="feedback-properties">
                <FactsRail>
                  {/* the forecast is the answer line's, above: the facts do not say when a second time */}
                  <LinkedFeedback f={f} slug={slug} />
                </FactsRail>
              </DetailDrawer>
            </div>
            <DetailPane label={tabs.find((x) => x.value === tab)?.label ?? t("feedback.tab.overview")}>
              {tab === "mockups" ? <MockupList projectId={projectId} slug={slug} target={{ type: "feedback", key: f.key }} canPropose={!f.redacted} /> : null}
              {tab === "overview" ? (
                <div className="grid grid-cols-1 gap-8" data-testid="view-overview">
                  <FeedbackEvidence projectId={projectId} slug={slug} f={f} />
                  <ValueCheck projectId={projectId} slug={slug} itemKey={f.key} />
                  {acts ? null : <Proposals projectId={projectId} f={f} />}
                  {developer ? <IntakeDraft projectId={projectId} slug={slug} itemKey={f.key} assumptions /> : null}
                  {triageOwed ? checklists : null}
                  <ClarifyReporter projectId={projectId} f={f} />
                  <FeedbackQuestions projectId={projectId} f={f} />
                  <Body projectId={projectId} f={f} />
                  <SimilarFeedback projectId={projectId} slug={slug} fbKey={f.key} />
                  <div>
                    <ReproduceFold projectId={projectId} f={f} />
                    <Messages projectId={projectId} f={f} />
                  </div>
                </div>
              ) : null}
              {tab === "activity" ? (
                <section className="grid grid-cols-1 gap-8" aria-label={t("feedback.tab.activity")} data-testid="view-activity">
                  <FeedbackHistory f={f} />
                  <FeedbackStewardActs projectId={projectId} fbKey={f.key} />
                  {triageOwed ? null : checklists}
                </section>
              ) : null}
            </DetailPane>
          </article>
        );
      }}
    </QueryBoundary>
  );
}

