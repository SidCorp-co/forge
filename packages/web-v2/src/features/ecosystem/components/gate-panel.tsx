"use client";

import { useState } from "react";
import { Button, Input, Textarea } from "@/design";
import { type AgentQuestion, currentRoundOf } from "@/features/questions/types";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { useAnswerGate, useGateQuestion } from "../hooks";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";
import { useCopy } from "@/lib/i18n/interface-language";

type GateDecision =
  | { kind: "notice"; notice: React.ReactNode }
  | {
      kind: "open";
      question: AgentQuestion;
      prompt: string | undefined;
      note: string;
      setNote: (note: string) => void;
      decide: (optionId: string) => void;
      locked: (optionId: string) => boolean;
      pending: (optionId: string) => boolean;
      refusal: React.ReactNode;
    };

/**
 * The approve gate on a submitted document, decided by answering its question
 * (`POST /api/questions/:id/answer`), which is the only door core keeps for it.
 */
function useGateDecision(projectId: string, questionId: string | null): GateDecision {
  const reading = readingOf(useGateQuestion(projectId, questionId));
  const t = useCopy();
  const answer = useAnswerGate(projectId);
  const [note, setNote] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  if (reading.kind === "loading") return { kind: "notice", notice: <Loading what={t("ecosystem.gate.loading")} /> };
  if (reading.kind === "unread") return { kind: "notice", notice: <UnreadNotice what={t("ecosystem.gate.unread")} refusals={reading.refusals} /> };
  const q = reading.value;
  if (!q) return { kind: "notice", notice: <p className="fg-caption">{t("ecosystem.gate.none")}</p> };
  const current = currentRoundOf(q);
  const round = current?.round;
  if (round === undefined) {
    return {
      kind: "notice",
      notice: (
        <UnreadNotice
          what={t("ecosystem.gate.roundUnread")}
          refusals={[{ code: "QUESTION_ROUND_UNREAD", path: "", detail: t("ecosystem.gate.roundUnreadDetail", { id: q.id }) }]}
        />
      ),
    };
  }
  return {
    kind: "open",
    question: q,
    prompt: current?.prompt,
    note,
    setNote,
    decide: (optionId) => {
      setChosen(optionId);
      const trimmed = note.trim();
      answer.mutate({ questionId: q.id, round, optionId, ...(trimmed ? { note: trimmed } : {}) });
    },
    locked: (optionId) => Boolean(q.options.find((o) => o.id === optionId)?.locked),
    pending: (optionId) => answer.isPending && chosen === optionId,
    refusal: answer.isError ? <RefusalNotice title={t("ecosystem.gate.refused")} refusals={refusalsOf(answer.error)} /> : null,
  };
}

export function GatePanel({ projectId, slug, questionId }: { projectId: string; slug: string; questionId: string | null }) {
  const gate = useGateDecision(projectId, questionId);
  if (gate.kind === "notice") return gate.notice;
  const { question: q, note } = gate;
  return (
    <section aria-label="Approve gate" className="space-y-2 rounded-md border border-line p-3">
      <h2 className="fg-label text-fg">Waiting at the approve gate</h2>
      <p className="text-13-5 break-words">{gate.prompt}</p>
      {q.options.every((o) => o.locked) ? (
        <p className="fg-caption">Your role on {slug} cannot decide this gate; an admin of {slug} approves or returns it.</p>
      ) : (
        <>
          <Textarea
            aria-label="Gate note"
            rows={2}
            placeholder="Note to the writer (required when returning it)"
            value={note}
            onChange={(e) => gate.setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => (
              <Button
                key={o.id}
                variant={o.id === "approve" ? "primary" : "secondary"}
                size="sm"
                disabled={o.locked || (o.id === "return" && note.trim() === "")}
                title={o.locked ? "Your role cannot choose this option" : o.label}
                loading={gate.pending(o.id)}
                onClick={() => gate.decide(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </>
      )}
      {gate.refusal}
    </section>
  );
}

/** The same gate, as the two buttons at the end of a Threads row. */
export function InlineGate({ projectId, questionId }: { projectId: string; questionId: string | null }) {
  const t = useCopy();
  const gate = useGateDecision(projectId, questionId);
  const [returning, setReturning] = useState(false);
  if (gate.kind === "notice") return gate.notice;
  return (
    <span className="grid justify-items-end gap-1.5">
      {returning ? (
        <span className="flex gap-1.5">
          <Input aria-label={t("ecosystem.gate.whyBack")} placeholder={t("ecosystem.gate.whyBack")} value={gate.note} onChange={(e) => gate.setNote(e.target.value)} />
          <Button size="sm" disabled={!gate.note.trim() || gate.locked("return")} loading={gate.pending("return")} onClick={() => gate.decide("return")}>
            {t("ecosystem.gate.return")}
          </Button>
        </span>
      ) : (
        <span className="flex gap-1.5">
          <Button size="sm" disabled={gate.locked("return")} onClick={() => setReturning(true)}>
            {t("ecosystem.gate.returnOpen")}
          </Button>
          <Button size="sm" variant="primary" disabled={gate.locked("approve")} loading={gate.pending("approve")} onClick={() => gate.decide("approve")}>
            {t("ecosystem.gate.approve")}
          </Button>
        </span>
      )}
      {gate.refusal}
    </span>
  );
}
