import type { ParkThreadQuestion } from "@forge/contracts/park";
import { fireEvent } from "@testing-library/react";
import type { QueryKey } from "@tanstack/react-query";
import { AgentsScreen } from "@/features/agents/components/agents-screen";
import { DecisionPanel } from "@/features/questions/components/decision-panel";
import { projectQuestionsKey } from "@/features/questions/hooks";
import type { AgentQuestion, QuestionOption, QuestionStep } from "@/features/questions/types";
import { Seeded } from "./vi-chrome-requirements";

// The question chrome for the vi walking test: the block on an issue (an open question of each shape,
// the earlier rounds, a settled one of every ending, the question a run asked in the thread, the issue
// with none) and the Questions tab of the Agents screen. A prompt, an option and a reason are what a run
// or a person wrote, so they are placeholder words here; everything else on the screen is chrome.

const P = "p1";
const I = "5a1c0e52-3b7d-4f0a-9d2e-6c1f8b4a7e30";
const AT = "2026-10-07T08:00:00.000Z";

const option = (id: string, over: Partial<QuestionOption> = {}): QuestionOption => ({
  id,
  label: `Phuong an ${id}`,
  authority: "writer",
  bindsTo: "this_call",
  executedBy: "agent",
  fingerprint: "bash:abc",
  ...over,
});

const freeStep = (round: number, over: Partial<QuestionStep> = {}): QuestionStep =>
  ({ round, prompt: `Cau hoi ${round}`, askedAt: AT, answerShape: "free_text", needed: "Danh muc vai tro", ...over }) as QuestionStep;

const question = (over: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id: "q1",
  projectId: P,
  issueId: I,
  status: "open",
  blockerKind: "human",
  steps: [freeStep(1)],
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: AT,
  updatedAt: AT,
  answerShape: "free_text",
  options: [],
  recommendedOptionId: "",
  needed: "Danh muc vai tro",
  locked: false,
  ...over,
});

const choiceOptions = [option("a"), option("b", { authority: "admin", bindsTo: "session", executedBy: "core" }), option("c", { bindsTo: "project", executedBy: "human", fingerprint: undefined as never })];
const choice = question({
  id: "q2",
  answerShape: "choice",
  options: choiceOptions.map((o) => ({ ...o, locked: o.id === "b" })),
  recommendedOptionId: "a",
  steps: [
    { round: 1, prompt: "Cau hoi 1", askedAt: AT, answerShape: "choice", options: choiceOptions, recommendedOptionId: "a", chosenOptionId: "a", answeredAt: AT } as QuestionStep,
    { round: 2, prompt: "Cau hoi 2", askedAt: AT, answerShape: "choice", options: choiceOptions, recommendedOptionId: "a" } as QuestionStep,
  ],
});

const earlier = question({
  id: "q3",
  steps: [freeStep(1, { answeredAt: AT, answerText: "Tra loi mot" }), freeStep(2, { answeredAt: AT, answerText: "Tra loi hai" }), freeStep(3)],
});

const hidden = question({ id: "q4", issueId: null, rounds: 3, steps: undefined, currentStep: freeStep(3) });

const settled = (id: string, over: Partial<AgentQuestion>, step: Partial<QuestionStep> = {}) =>
  question({ id, steps: [freeStep(1, { answeredAt: AT, answerText: "Tra loi", ...step })], ...over });

const answered = [
  settled("s1", { status: "answered" }, { hold: { reason: "Ban thiet ke mot", blockedBy: { id: "i2", key: "ISS-2" } }, resume: { kind: "held", at: AT } }),
  settled("s2", { status: "answered" }, { hold: { reason: "Ban thiet ke hai" }, resume: { kind: "resumed", to: "in_progress", at: AT } }),
  ...(["sent_to_run", "box_reads", "other_question", "no_left_status", "staged"] as const).map((kind, n) =>
    settled(`s3${n}`, { status: "answered" }, { resume: { kind, at: AT } as never }),
  ),
  settled("s4", { status: "answered" }, { resume: { kind: "refused", code: "ISSUE_REFUSED", detail: "Ly do", at: AT } }),
  settled("s5", { status: "void", voidReason: null }),
  settled("s6", { status: "expired", endedReason: null }),
  settled("s7", { status: "needs_info" }),
  settled("s8", { status: "answered", answerShape: "choice" } as never, { answerShape: "choice", options: choiceOptions, recommendedOptionId: "a", chosenOptionId: "zz", answerText: undefined } as never),
];

const seed = (questions: AgentQuestion[]): [QueryKey, unknown][] => [[["questions", I], { questions }]];
const panel = (questions: AgentQuestion[], extra: Partial<Parameters<typeof DecisionPanel>[0]> = {}) => () => (
  <Seeded data={seed(questions)}>
    <DecisionPanel issueId={I} {...extra} />
  </Seeded>
);

const tick = () => {
  const box = document.querySelector<HTMLElement>('[role="checkbox"]');
  if (!box) throw new Error("no still-waits box to tick");
  fireEvent.click(box);
};

const thread: ParkThreadQuestion = { prompt: "Cau hoi trong luong", why: "Ly do dung", readings: [{ choice: "Cach mot", outcome: "Ket qua mot" }], answer: null };

const paneSeed = (questions: AgentQuestion[]): [QueryKey, unknown][] => [
  [projectQuestionsKey(P), { pages: [{ questions, total: questions.length, hasMore: true, nextCursor: "c1" }], pageParams: [null] }],
];

export const QUESTION_SCREENS = [
  { name: "Decision · free text", render: panel([question()]) },
  { name: "Decision · free text, still waits", render: panel([question()]), act: tick },
  { name: "Decision · choice and earlier round", render: panel([choice]) },
  { name: "Decision · earlier rounds", render: panel([earlier, hidden]) },
  { name: "Decision · settled", render: panel(answered) },
  { name: "Decision · asked in the thread", render: panel([], { parkedForInfo: true, threadQuestion: thread, onAnswerInThread: async () => undefined }) },
  { name: "Decision · answered in the thread", render: panel([], { parkedForInfo: true, threadQuestion: { ...thread, answer: { text: "Tra loi" } as never } }) },
  { name: "Decision · none on the issue", render: panel([], { parkedForInfo: true }) },
  {
    name: "Agents · Questions tab",
    render: () => {
      window.history.replaceState(null, "", "/?tab=questions");
      return (
        <Seeded data={paneSeed([question({ id: "q5", issueId: null }), hidden])}>
          <AgentsScreen access={{ projectId: P, slug: "hop", canWrite: true }} />
        </Seeded>
      );
    },
  },
  {
    name: "Agents · Questions tab, empty",
    render: () => {
      window.history.replaceState(null, "", "/?tab=questions");
      return (
        <Seeded data={[[projectQuestionsKey(P), { pages: [{ questions: [], total: 0, hasMore: false, nextCursor: null }], pageParams: [null] }]]}>
          <AgentsScreen access={{ projectId: P, slug: "hop", canWrite: true }} />
        </Seeded>
      );
    },
  },
];
