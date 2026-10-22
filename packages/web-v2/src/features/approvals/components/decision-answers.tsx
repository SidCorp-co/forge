// The one answer list of a decision (REQ-48 r3 BC-13, BC-14): each answer once, a button carrying its
// label and, under it, what pressing it does, the recommended one first and primary. Labels wrap, so
// a long one ("Merge it into ISS-607: …") never runs past the panel's edge, and on a keyboard each
// button shows the digit that presses it. The words an act needs are asked in place of the list.

import type { DecisionAnswer, NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { useEffect, useRef, useState } from "react";
import { Button, Kbd, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { drawnAnswers } from "../derive";

/** The words an act needs before it is sent, and the send; empty words are refused in place. */
export function Words({ answer, onSend, onCancel }: { answer: DecisionAnswer; onSend: (words: string) => void; onCancel: () => void }) {
  const t = useCopy();
  const [words, setWords] = useState("");
  const [refused, setRefused] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // the words are asked for because a press asked for them: the caret goes where they are typed
  useEffect(() => fieldRef.current?.focus(), []);
  const decline = answer.declines;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (words.trim()) onSend(words.trim());
        else setRefused(true);
      }}
    >
      <Textarea
        ref={fieldRef}
        rows={3}
        aria-label={t("approvals.typedLabel", { label: answer.label })}
        placeholder={decline ? t("approvals.declineWhy") : answer.label}
        value={words}
        onChange={(e) => setWords(e.target.value)}
        data-testid="approval-words"
      />
      {refused ? (
        <p role="alert" className="text-12 text-danger-11">
          {t(decline ? "approvals.declineNeeded" : "approvals.wordsNeeded")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" data-testid="approval-words-send">
          {decline ? t("approvals.act.declineGo") : answer.label}
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          {t("approvals.act.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** One answer: its label, the digit that presses it, and what it does, all inside the one pressable button. */
function AnswerButton({ a, n, onPress }: { a: DecisionAnswer; n: number; onPress: (a: DecisionAnswer) => void }) {
  const t = useCopy();
  return (
    <Button
      variant={a.recommended ? "primary" : "secondary"}
      onClick={() => onPress(a)}
      className="h-auto w-full flex-col items-stretch gap-1 whitespace-normal px-3 py-2 text-left text-13 leading-snug"
      data-testid="approval-peek-answer"
      data-answer={a.id}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1 break-words" data-testid="approval-peek-answer-label">{a.label}</span>
        {a.recommended ? <span className="flex-none text-11 font-medium opacity-85">{t("approvals.peek.recommended")}</span> : null}
        {n <= 9 ? <Kbd className="flex-none max-lg:hidden">{n}</Kbd> : null}
      </span>
      {a.effect ? <span className={cn("break-words text-12 font-normal", a.recommended ? "opacity-90" : "text-muted")}>{a.effect}</span> : null}
    </Button>
  );
}

interface AnswersProps {
  d: NeedsYouDecision;
  typing: DecisionAnswer | null;
  onType: (a: DecisionAnswer | null) => void;
  onPress: (a: DecisionAnswer, words: string | null) => void;
  /** A proposal's own page, where it is changed before it is approved. */
  editHref?: React.ReactNode;
}

/** The answers that decide it, held in the peek's foot, with the keys that press them. */
export function DecisionAnswers({ d, typing, onType, onPress, editHref }: AnswersProps) {
  const t = useCopy();
  const answers = drawnAnswers(d);
  const press = (a: DecisionAnswer) => (a.needsReason ? onType(a) : onPress(a, null));
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="approval-peek-foot">
      {typing ? (
        <Words key={typing.id} answer={typing} onSend={(w) => onPress(typing, w)} onCancel={() => onType(null)} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("approvals.peek.answersLabel")}>
          {answers.map((a, i) => (
            <li key={a.id}>
              <AnswerButton a={a} n={i + 1} onPress={press} />
            </li>
          ))}
        </ul>
      )}
      {editHref}
      <p className="flex flex-wrap gap-x-3 text-12 text-subtle max-lg:hidden" data-testid="approval-peek-keys">
        <span>
          <Kbd>{answers.length > 1 ? `1–${Math.min(answers.length, 9)}` : "1"}</Kbd> {t("approvals.keys.answer")}
        </span>
        <span>
          <Kbd>x</Kbd> {t("approvals.keys.select")}
        </span>
      </p>
    </div>
  );
}
