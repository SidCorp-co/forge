"use client";

import { useState } from "react";
import { Button, Textarea } from "@/design";
import { currentRoundOf } from "@/features/questions/types";
import { useAnswerGate, useGateQuestion } from "../hooks";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";

/**
 * The approve gate on a submitted document, decided by answering its question
 * (`POST /api/questions/:id/answer`), which is the only door core keeps for it.
 */
export function GatePanel({ projectId, slug, documentId }: { projectId: string; slug: string; documentId: string }) {
  const reading = readingOf(useGateQuestion(projectId, documentId, true));
  const answer = useAnswerGate();
  const [note, setNote] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);

  if (reading.kind === "loading") return <Loading what="the approve gate" />;
  if (reading.kind === "unread") return <UnreadNotice what="The approve gate" refusals={reading.refusals} />;
  const q = reading.value;
  if (!q) {
    return <p className="fg-caption">No open gate question waits on this document.</p>;
  }
  const round = currentRoundOf(q)?.round;
  if (round === undefined) {
    return (
      <UnreadNotice
        what="The approve gate's round"
        refusals={[{ code: "QUESTION_ROUND_UNREAD", path: "", detail: `question ${q.id} came back with no round to answer.` }]}
      />
    );
  }
  const decide = (optionId: string) => {
    setChosen(optionId);
    const trimmed = note.trim();
    answer.mutate({ questionId: q.id, round, optionId, ...(trimmed ? { note: trimmed } : {}) });
  };
  const locked = q.options.every((o) => o.locked);
  return (
    <section aria-label="Approve gate" className="space-y-2 rounded-md border border-line p-3">
      <h2 className="fg-label text-fg">Waiting at the approve gate</h2>
      <p className="text-13-5 break-words">{currentRoundOf(q)?.prompt}</p>
      {locked ? (
        <p className="fg-caption">Your role on {slug} cannot decide this gate; an admin of {slug} approves or returns it.</p>
      ) : (
        <>
          <Textarea
            aria-label="Gate note"
            rows={2}
            placeholder="Note to the writer (required when returning it)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {q.options.map((o) => (
              <Button
                key={o.id}
                variant={o.id === "approve" ? "primary" : "secondary"}
                size="sm"
                disabled={o.locked || (o.id === "return" && note.trim() === "")}
                title={o.locked ? "Your role cannot choose this option" : o.label}
                loading={answer.isPending && chosen === o.id}
                onClick={() => decide(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        </>
      )}
      {answer.isError ? <RefusalNotice title="The gate refused that answer" refusals={refusalsOf(answer.error)} /> : null}
    </section>
  );
}
