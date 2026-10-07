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
// waits on, why nobody was told) are the real ones core writes, since they reach the screen through
// standing-copy patterns.

const P = "p1";
const AT = "2026-10-05T08:00:00.000Z";
const CAN = { triage: true, verify: true, reopen: true, askVerify: true, redact: true, retarget: true, accept: true, snooze: true, message: true, note: true, attach: true };

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
    waitingOn: { kind: "you", who: "You", act: "triage it", rule: "r", ref: null, dueAt: null },
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
  summary(3, { phase: "planned", status: "triaged", attentionGroup: "moving", waitingOn: { kind: "work", who: "The linked issue", act: "be resolved", rule: "r", ref: "ISS-4" } as never }),
  summary(4, { phase: "resolved", status: "triaged", attentionGroup: "waiting", waitingOn: { kind: "person", who: "Lan", act: "verify the fix shipped in 0.2.0", rule: "r", ref: "0.2.0" } as never }),
  summary(5, { phase: "verified", status: "verified", attentionGroup: "done", waitingOn: { kind: "none", who: "Nobody", act: "", rule: "r", ref: null } as never }),
  summary(6, { phase: "declined", status: "declined", attentionGroup: "done", waitingOn: { kind: "none", who: "Nobody", act: "", rule: "r", ref: null } as never }),
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
      { decision: "triaged", route: "issue", carrier: "ISS-4", reason: null, decidedBy: "u2", decidedByName: "Minh", decidedAgency: "human", decidedAt: AT, fromSuggestionId: null, acceptReason: "co the" },
      { decision: "verified", route: null, carrier: null, reason: "Verified automatically after 14 days with no reply", decidedBy: null, decidedByName: null, decidedAgency: "system", decidedAt: AT, fromSuggestionId: null, acceptReason: null },
      { decision: "snoozed", route: null, carrier: null, reason: null, decidedBy: "a1", decidedByName: "Tro ly", decidedAgency: "agent", decidedAt: AT, fromSuggestionId: null, acceptReason: null },
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
  const forecast = { key: f.key, triage: { label: "forecast", asOf: AT, kind: "paused", who: "A project writer", act: "triage it", reason: "new", ref: null, since: null, late: null }, delivery: null };
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
        waitingOn: { kind: "person", who: "Lan", act: "verify the fix shipped in 0.2.0", rule: "r", ref: "0.2.0" } as never,
        route: { route: "issue", carriers: [{ key: "ISS-4", status: "closed", release: "0.2.0" }], answer: null },
        shipNotice: { state: "not_told", reason: "The reporter has turned this notice off, so it reached nobody: tell them yourself.", shipped: { at: AT, release: "0.2.0" }, beforeNotices: false },
        snoozed: { until: "2026-10-10T09:00:00.000Z", reason: "cho" },
        source: { agentReport: { id: "0123456789ab", kind: "bug", severity: "high", target: "issue", targetRef: "ISS-4", createdAt: AT } },
        sensitive: true,
      } as never)}
    />
    <FeedbackFacts slug="hop" f={view({ phase: "verified", attentionGroup: "done", verified: { at: AT, how: "automatic", by: null, byName: null, byReporter: false, reason: "Verified automatically after 14 days with no reply" }, shipNotice: { state: "told", how: "notice", at: AT, release: "0.2.0", by: null, shipped: { at: AT, release: "0.2.0" } }, route: null })} />
    <FeedbackFacts slug="hop" f={view({ phase: "verified", attentionGroup: "done", verified: { at: AT, how: "person", by: "u1", byName: "Lan", byReporter: true, reason: null }, autoVerify: null })} />
    <FeedbackFacts slug="hop" f={view({ verified: { at: AT, how: "person", by: "u2", byName: null, byReporter: false, reason: null }, shipNotice: { state: "not_told", reason: "No release carries it, so none told the reporter: tell them yourself.", shipped: { at: null, release: null }, beforeNotices: false } })} />
    <FeedbackBanner slug="hop" f={view({ phase: "verified", attentionGroup: "done", waitingOn: { kind: "none", who: "Nobody", act: "", rule: "r", ref: null } as never })} />
    <FeedbackBanner slug="hop" f={view({ attentionGroup: "needs_you", route: { route: "issue", carriers: [{ key: "ISS-4", status: "closed", release: "0.2.0" }], answer: null }, waitingOn: { kind: "you", who: "You", act: "Approve release 0.2.0", rule: "r", ref: "0.2.0" } as never })} />
    <FeedbackBanner slug="hop" f={view({ attentionGroup: "waiting", route: { route: "issue", carriers: [{ key: "ISS-4", status: "closed", release: "0.2.0" }], answer: null }, waitingOn: { kind: "person", who: "Lan", act: "verify the fix shipped in 0.2.0", rule: "r", ref: "0.2.0" } as never })} />
    <FeedbackBanner
      slug="hop"
      f={view({
        attentionGroup: "waiting",
        route: { route: "answer", carriers: [], answer: "Tra loi" },
        decisions: [{ decision: "triaged", route: "answer", carrier: null, reason: null, decidedBy: "u2", decidedByName: "Minh", decidedAgency: "human", decidedAt: AT, fromSuggestionId: null, acceptReason: null }],
        waitingOn: { kind: "person", who: "Lan", act: "Confirm the answer", rule: "r", ref: null } as never,
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
