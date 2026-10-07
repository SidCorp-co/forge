"use client";

// A feedback item's full page: what the reporter said and the acts a person can take (Overview), the
// mockups proposed about it (Mockups), and every decision on it (History), as tabs beside the sticky
// facts rail. The phase, whose turn and what carries it live in the rail only.

import type { ReactNode } from "react";
import {
  Button,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  enumLabel,
  FactsRail,
  LEGEND,
  StatusBadge,
  useUrlTab,
} from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { MockupsPanel } from "@/features/mockups/components/mockups-panel";
import { useMockups } from "@/features/mockups/hooks";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { useEtaClock, useFeedbackForecasts } from "@/features/forecast/hooks";
import { useFeedbackItem } from "../hooks";
import type { FeedbackView } from "../types";
import { FeedbackActions, Proposals } from "./feedback-actions";
import { FeedbackBanner, FeedbackFacts } from "./feedback-facts";

const FEEDBACK_TABS = ["overview", "mockups", "history"] as const;
type FeedbackTab = (typeof FEEDBACK_TABS)[number];
export const useFeedbackTab = () => useUrlTab(FEEDBACK_TABS);

/** The one primary act the header and the peek offer: it opens the form that commits it. */
export function FeedbackPrimary({ f, onAct }: { f: FeedbackView; onAct: () => void }) {
  if (!f.can.triage && !f.can.verify && !f.can.reopen) return null;
  return (
    <Button type="button" variant="primary" size="sm" onClick={onAct} data-testid="feedback-primary">
      {f.can.triage ? "Triage" : "Confirm the fix"}
    </Button>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-15 font-semibold leading-snug text-fg">{children}</h2>;
}

function Body({ f }: { f: FeedbackView }) {
  return (
    <section>
      <Heading>What the reporter said</Heading>
      {f.redacted ? (
        <p className="text-13 text-subtle">The reporter’s data was deleted; the item stays so its links resolve.</p>
      ) : (
        <p className="max-w-[80ch] whitespace-pre-wrap text-14 leading-relaxed" data-testid="feedback-body">
          {f.body?.trim() ? f.body : <span className="text-subtle">No description.</span>}
        </p>
      )}
      {f.attachments.length > 0 ? (
        <ul className="mt-3 grid gap-1 text-13">
          {f.attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <span className="font-mono">{a.name}</span>
              <span className="text-subtle">{Math.ceil(a.size / 1024)} KB</span>
              {a.flagged ? (
                <span
                  className="text-11 font-semibold"
                  style={{ color: LEGEND.you.fg }}
                  title="On a sensitive project an attachment may hold personal data; it never reaches a provider"
                >
                  Flagged
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function FeedbackHistory({ f }: { f: FeedbackView }) {
  if (f.decisions.length === 0) return <p className="text-13 text-subtle">No decision yet.</p>;
  return (
    <ol className="border-t border-line-subtle" data-testid="feedback-history">
      {[...f.decisions].reverse().map((d) => (
        <li key={`${d.decidedAt}-${d.decision}`} className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13">
          <span>
            <span className="font-semibold">{enumLabel("feedbackDecision", d.decision)}</span>
            {d.route ? ` as ${enumLabel("feedbackRoute", d.route).toLowerCase()}` : ""}
            {d.carrier ? <span className="font-mono"> {d.carrier}</span> : null}
            <span className="text-muted">
              {" "}
              · {d.decidedByName ?? d.decidedBy}
              {d.decidedAgency === "agent" ? " (agent)" : ""} · <span title={formatStamp(d.decidedAt)}>{formatRelativeTime(d.decidedAt)}</span>
            </span>
          </span>
          {d.reason ? <span className="text-muted">{d.reason}</span> : null}
          {d.acceptReason ? <span className="text-muted">Accepted: {d.acceptReason}</span> : null}
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
  const q = useFeedbackItem(projectId, fbKey);
  const forecasts = useFeedbackForecasts(projectId);
  const clock = useEtaClock(projectId);
  const mockups = useMockups(projectId, { type: "feedback", key: fbKey });
  return (
    <QueryBoundary query={q} loadingLabel="loading feedback…">
      {(data) => {
        const f = data.feedback;
        const tabs = [
          { value: "overview" as const, label: "Overview" },
          { value: "mockups" as const, label: "Mockups", count: mockups.data?.returned },
          { value: "history" as const, label: "History", count: f.decisions.length },
        ];
        return (
          <DetailLayout
            testId="feedback-detail"
            dataKey={f.key}
            rail={
              <FactsRail>
                <FeedbackFacts f={f} slug={slug} forecast={forecasts.data?.items.find((i) => i.key === f.key)} clock={clock} />
              </FactsRail>
            }
          >
            <DetailMobileTitle itemKey={f.key} title={f.title} badge={<StatusBadge family="feedbackPhase" value={f.phase} />} />
            <FeedbackBanner f={f} className="px-8 py-2.5 max-md:px-4" />
            <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="feedback-tabs" />
            <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Overview"}>
              {tab === "mockups" ? <MockupsPanel projectId={projectId} target={{ type: "feedback", key: f.key }} canPropose={!f.redacted} /> : null}
              {tab === "overview" ? (
                <div className="grid gap-8" data-testid="view-overview">
                  <Proposals projectId={projectId} f={f} />
                  {f.can.triage || f.can.verify || f.can.reopen || f.can.askVerify || f.can.redact ? (
                    <section id="feedback-act">
                      <FeedbackActions projectId={projectId} f={f} />
                    </section>
                  ) : null}
                  <Body f={f} />
                </div>
              ) : null}
              {tab === "history" ? (
                <section aria-label="History">
                  <FeedbackHistory f={f} />
                </section>
              ) : null}
            </DetailPane>
          </DetailLayout>
        );
      }}
    </QueryBoundary>
  );
}
