import type { Said } from "@forge/contracts/said";
import { forecastWait, RULE, say, sentence, waitingOn } from "./said";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { feedbackForecastKey } from "@/features/forecast/hooks";
import { FeedbackBanner, FeedbackFacts } from "@/features/feedback/components/feedback-facts";
import { FeedbackHistory } from "@/features/feedback/components/feedback-detail";
import { FeedbackForm } from "@/features/feedback/components/feedback-form";
import { FeedbackItemScreen } from "@/features/feedback/components/feedback-item-screen";
import { FeedbackPeek } from "@/features/feedback/components/feedback-peek";
import { MessagePreview } from "@/features/feedback/components/feedback-messages";
import { RetargetEditor } from "@/features/feedback/components/feedback-retarget";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { AcceptForm, DeclineForm, DuplicateForm, SnoozeForm } from "@/features/feedback/components/feedback-verbs";
import type { FeedbackSummary, FeedbackView } from "@/features/feedback/types";
import { useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { Seeded as SeededQueries } from "./vi-chrome-requirements";

// The Feedback screens for the vi walking test, filled from a seeded query cache so they draw at once.
// Fixture content (titles, names, bodies) carries no English chrome word; core's sentences (whom an item
// waits on, why nobody was told) are said by their registry keys, as core says them, and the screen
// reads them in vi from there.

const P = "p1";
const AT = "2026-10-05T08:00:00.000Z";
const LAN = say("standing.who.named", { name: "Lan" });
/** A reason core sends as English beside what it said. */
const noted = (s: Said) => ({ reason: sentence(s), says: { reason: s } });
const CAN = { triage: true, verify: true, reopen: true, askVerify: true, redact: true, retarget: true, accept: true, snooze: true, message: true, tellShipped: false, note: true, attach: true };

const summary = (n: number, over: Partial<FeedbackSummary> = {}): FeedbackSummary =>
  ({
    id: `f${n}`,
    key: `FB-${n}`,
    title: `Muc FB-${n}`,
    kind: "bug",
    severity: "high",
    status: "new",
    phase: "new",
    attentionGroup: "needs_you",
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: RULE }),
    target: { type: "requirement", key: "REQ-1", title: "Dang nhap" },
    route: null,
    reporter: { id: "u1", name: "Lan", agency: "human" },
    dueAt: null,
    snoozed: null,
    redacted: false,
    redactedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  }) as FeedbackSummary;

const ROWS: FeedbackSummary[] = [
  summary(1),
  summary(2, { target: { type: "screen", key: "Bang dieu khien", title: null }, snoozed: { until: "2026-10-10T09:00:00.000Z", reason: "cho" } }),
  summary(3, { phase: "planned", status: "triaged", attentionGroup: "moving", waitingOn: waitingOn("issue", { who: say("standing.who.linkedIssue"), act: say("standing.act.beResolved"), rule: RULE }, { ref: "ISS-4" }) as never }),
  summary(4, { phase: "resolved", status: "triaged", attentionGroup: "waiting", waitingOn: waitingOn("person", { who: LAN, act: say("standing.act.verifyFixIn", { v: "0.2.0" }), rule: RULE }, { ref: "0.2.0" }) as never }),
  summary(5, { phase: "verified", status: "verified", attentionGroup: "done", waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }) as never }),
  summary(6, { phase: "declined", status: "declined", attentionGroup: "done", waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }) as never }),
  summary(7, { phase: "reopened", status: "reopened" }),
];

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    ...summary(2),
    target: { type: "screen", key: "Bang dieu khien", title: null },
    verified: null,
    autoVerify: { at: "2026-10-20T08:00:00.000Z", windowDays: 14 },
    shipNotice: null,
    body: "Noi dung",
    whereSeen: "/du-an",
    duplicateOf: null,
    duplicates: ["FB-9"],
    source: null,
    decisions: [
      { decision: "triaged", route: "issue", carrier: "ISS-4", reason: null, says: { reason: null }, decidedBy: "u2", decidedByName: "Minh", decidedAgency: "human", decidedAt: AT, fromSuggestionId: null, acceptReason: "co the" },
      { decision: "verified", route: null, carrier: null, ...noted(say("feedback.notice.autoVerified", { n: 14 })), decidedBy: null, decidedByName: null, decidedAgency: "system", decidedAt: AT, fromSuggestionId: null, acceptReason: null },
      { decision: "snoozed", route: null, carrier: null, reason: null, says: { reason: null }, decidedBy: "a1", decidedByName: "Tro ly", decidedAgency: "agent", decidedAt: AT, fromSuggestionId: null, acceptReason: null },
    ],
    attachments: [{ id: "a1", from: "Lan", name: "anh.png", mime: "image/png", size: 4096, flagged: true, createdAt: AT, url: "/api/projects/p/feedback/FB-2/attachments/a1" }],
    reporters: [
      { id: "u1", name: "Lan", agency: "human", from: null },
      { id: "u3", name: null, agency: "human", from: "FB-9" },
    ],
    messages: [
      { id: "m1", audience: "internal", text: "Ghi chu", sentBy: "u2", sentByName: "Minh", sentAgency: "human", sentAt: AT, recipients: [] },
      { id: "m2", audience: "reporter", text: "Chao ban", sentBy: "u2", sentByName: "Minh", sentAgency: "human", sentAt: AT, recipients: [{ id: "u1", name: null }] },
    ],
    clarification: null,
    openSuggestions: 1,
    can: CAN,
    ...over,
  }) as FeedbackView;

const ITEM = view();

const SUGGESTIONS = {
  suggestions: [
    { id: "s1", producerKind: "agent", payload: { route: "issue", createIssue: {}, note: "Ghi chu", dedup: { ran: true, nearest: null } } },
    { id: "s2", producerKind: "person", payload: { route: "issue", issue: ["ISS-4", "ISS-5"], dedup: { ran: true, nearest: "FB-9", similarity: 0.91 } } },
    { id: "s3", producerKind: "agent", payload: { route: "new_requirement", title: "Yeu cau moi", dedup: { ran: false } } },
  ],
};

const SEED: [QueryKey, unknown][] = [
  [["feedback", P], { feedback: ROWS, counts: {}, sensitive: false }],
  [["feedback-item", P, ITEM.key], { feedback: ITEM }],
  [feedbackForecastKey(P), { projectId: P, items: [] }],
  [["suggestions", P, { feedback: ITEM.id }], SUGGESTIONS],
  [["mockups", P, "feedback", ITEM.key], { mockups: [], returned: 0 }],
  [["feedback-choices", P, "requirement"], [{ key: "REQ-1", title: "Dang nhap" }]],
  [["projects"], [{ id: P, role: "admin" }]],
];

const Seeded = ({ children }: { children: ReactNode }) => <SeededQueries data={SEED}>{children}</SeededQueries>;

const peek = { open: ITEM.key, position: { at: 2, of: 7 }, set: () => {}, move: () => {} };

export const feedbackList = () => (
  <Seeded>
    <FeedbackScreen projectId={P} slug="hop" />
  </Seeded>
);

export const feedbackDetail = () => (
  <Seeded>
    <FeedbackItemScreen projectId={P} slug="hop" fbKey={ITEM.key} />
  </Seeded>
);

export const feedbackPeek = () => (
  <Seeded>
    <FeedbackPeek projectId={P} slug="hop" fbKey={ITEM.key} peek={peek} onOpenFull={() => {}} />
  </Seeded>
);

/** The rail with both of its time rows, ETA and the forecast line, in the language the screen reads in. */
function FactsWithForecast({ f }: { f: FeedbackView }) {
  const lang = useInterfaceLanguage();
  const forecast = { key: f.key, triage: { label: "forecast", asOf: AT, kind: "paused", ...forecastWait(say("standing.who.holderOf", { perm: "project.write" }), say("standing.act.triageIt"), say("feedback.rule.triagerTriages", { phase: "new" })), ref: null, since: null, late: null }, delivery: null };
  return <FeedbackFacts slug="hop" f={f} forecast={forecast as never} clock={{ lang, now: Date.parse(AT), timeZone: "UTC" }} />;
}

export const feedbackFacts = () => (
  <Seeded>
    <FactsWithForecast f={view({ phase: "new", attentionGroup: "needs_you" })} />
    <FeedbackFacts
      slug="hop"
      f={view({
        phase: "resolved",
        attentionGroup: "waiting",
        waitingOn: waitingOn("person", { who: LAN, act: say("standing.act.verifyFixIn", { v: "0.2.0" }), rule: RULE }, { ref: "0.2.0" }) as never,
        route: { route: "issue", carriers: [{ key: "ISS-4", status: "closed", release: "0.2.0" }], answer: null },
        shipNotice: { state: "not_told", ...noted(say("feedback.notice.turnedOff")), shipped: { at: AT, release: "0.2.0" }, beforeNotices: false, noticesBegan: null },
        snoozed: { until: "2026-10-10T09:00:00.000Z", reason: "cho" },
        source: { agentReport: { id: "0123456789ab", kind: "bug", severity: "high", target: "issue", targetRef: "ISS-4", createdAt: AT } },
        sensitive: true,
      } as never)}
    />
    <FeedbackFacts slug="hop" f={view({ phase: "verified", attentionGroup: "done", verified: { at: AT, how: "automatic", by: null, byName: null, byReporter: false, ...noted(say("feedback.notice.autoVerified", { n: 14 })) }, shipNotice: { state: "told", how: "notice", at: AT, release: "0.2.0", by: null, shipped: { at: AT, release: "0.2.0" }, told: null, says: { told: null } }, route: null })} />
    <FeedbackFacts slug="hop" f={view({ phase: "verified", attentionGroup: "done", verified: { at: AT, how: "person", by: "u1", byName: "Lan", byReporter: true, reason: null, says: { reason: null } }, autoVerify: null })} />
    <FeedbackFacts slug="hop" f={view({ verified: { at: AT, how: "person", by: "u2", byName: null, byReporter: false, reason: null, says: { reason: null } }, shipNotice: { state: "not_told", ...noted(say("feedback.notice.noRelease")), shipped: { at: null, release: null }, beforeNotices: false, noticesBegan: null } })} />
    <FeedbackBanner slug="hop" f={view({ phase: "verified", attentionGroup: "done", waitingOn: waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }) as never })} />
    <FeedbackBanner slug="hop" f={view({ attentionGroup: "needs_you", route: { route: "issue", carriers: [{ key: "ISS-4", status: "closed", release: "0.2.0" }], answer: null }, waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveReleaseV", { v: "0.2.0" }), rule: RULE }, { ref: "0.2.0" }) as never })} />
    <FeedbackBanner slug="hop" f={view({ attentionGroup: "waiting", route: { route: "issue", carriers: [{ key: "ISS-4", status: "closed", release: "0.2.0" }], answer: null }, waitingOn: waitingOn("person", { who: LAN, act: say("standing.act.verifyFixIn", { v: "0.2.0" }), rule: RULE }, { ref: "0.2.0" }) as never })} />
    <FeedbackBanner
      slug="hop"
      f={view({
        attentionGroup: "waiting",
        route: { route: "answer", carriers: [], answer: "Tra loi" },
        decisions: [{ decision: "triaged", route: "answer", carrier: null, reason: null, says: { reason: null }, decidedBy: "u2", decidedByName: "Minh", decidedAgency: "human", decidedAt: AT, fromSuggestionId: null, acceptReason: null }],
        waitingOn: waitingOn("person", { who: LAN, act: say("standing.act.confirmAnswer"), rule: RULE }) as never,
      })}
    />
    <FeedbackHistory f={ITEM} />
  </Seeded>
);

export const feedbackFilingForm = () => (
  <Seeded>
    <FeedbackForm projectId={P} onDone={() => {}} />
    <FeedbackForm projectId={P} onDone={() => {}} agentReport="0123456789ab" />
  </Seeded>
);

export const feedbackForms = () => (
  <Seeded>
    <AcceptForm projectId={P} f={ITEM} done={() => {}} />
    <DeclineForm projectId={P} f={ITEM} done={() => {}} />
    <DuplicateForm projectId={P} f={ITEM} done={() => {}} />
    <SnoozeForm projectId={P} f={ITEM} done={() => {}} />
    <RetargetEditor projectId={P} f={ITEM} onClose={() => {}} onMoved={() => {}} />
    <MessagePreview
      shown={{ audience: "reporter", title: "Tieu de", body: "Noi dung", recipients: [{ id: "u1", name: "Lan" }, { id: "u3", name: null }], notReached: [{ id: "u4", name: null, why: "khong co chuong" }] }}
    />
  </Seeded>
);
