// The peek beside the Approvals list (REQ-48 BC-11): what the agent proposes, what approving changes,
// why, the records that move and what the reporter said, then a footer that stays in view with the
// acts that decide it and their keys. A decision a person asked (a question, a sign-off) reads by its
// question and offers its own answers. Nothing here builds an act: every button presses one core gave.

import type { DecisionAnswer, NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { useEffect, useRef, useState } from "react";
import { Button, type FullPage, Kbd, PeekExcerpt, PeekHead, PeekPanel, type PeekState, Table, TBody, TD, TH, THead, TR, Textarea } from "@/design";
import { Link } from "@/lib/navigation/router";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { approveOf, declineOf, otherAnswersOf } from "../derive";
import { PeekMockup } from "./approval-mockup";
import { DecisionTags } from "./approval-row";

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-11-5 font-semibold uppercase tracking-wide text-subtle">{children}</h3>;
}

function Proposal({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  const p = d.proposal;
  return (
    <div className="border-l-2 border-l-ai-9 bg-info-2 px-4 py-3" data-testid="approval-peek-proposal">
      <p className="text-12 font-semibold text-info-11">{t(p ? "approvals.peek.proposes" : "approvals.peek.asks")}</p>
      <p className="mt-0.5 text-14 font-semibold text-fg">{p ? (p.what ? `${p.verb}: ${p.what}` : p.verb) : d.question}</p>
    </div>
  );
}

/** What approving changes, why, and the records that move: the proposal's own lines, in its order. */
function Reasons({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  const p = d.proposal;
  if (!p) {
    return d.recommended ? (
      <section>
        <Heading>{t("approvals.peek.recommended")}</Heading>
        <p className="text-13 text-fg">{d.recommended.why}</p>
      </section>
    ) : null;
  }
  return (
    <>
      {p.consequences.length > 0 ? (
        <section data-testid="approval-peek-consequences">
          <Heading>{t("approvals.peek.ifApprove")}</Heading>
          <ul className="flex flex-col gap-1.5 text-13 text-fg">
            {p.consequences.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="text-subtle">→</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {p.why.length > 0 ? (
        <section data-testid="approval-peek-why">
          <Heading>{t("approvals.peek.why")}</Heading>
          <dl className="divide-y divide-line-subtle border-y border-line-subtle text-13">
            {p.why.map((w) => (
              <div key={w.label} className="flex gap-4 py-2">
                <dt className="w-28 flex-none text-muted">{w.label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap text-fg">{w.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {p.table ? (
        <section data-testid="approval-peek-table">
          <Heading>{p.table.title}</Heading>
          <Table className="text-13" aria-label={p.table.title}>
            <THead>
              <TR>
                {p.table.columns.map((c) => (
                  <TH key={c}>{c}</TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {p.table.rows.map((row) => (
                <TR key={row.join("|")} className="align-top">
                  {p.table?.columns.map((c, i) => (
                    <TD key={c} className={i === 0 ? "whitespace-pre-line font-mono text-12" : "whitespace-pre-line"}>
                      {row[i] ?? ""}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        </section>
      ) : null}
      {p.said ? (
        <section data-testid="approval-peek-said">
          <Heading>{t("approvals.peek.said")}</Heading>
          <PeekExcerpt>
            <p className="whitespace-pre-wrap border-l-2 border-l-line pl-3 text-fg">{p.said}</p>
          </PeekExcerpt>
        </section>
      ) : null}
    </>
  );
}

/** The words an act needs before it is sent, and the send; empty words are refused in place. */
function Words({ answer, onSend, onCancel }: { answer: DecisionAnswer; onSend: (words: string) => void; onCancel: () => void }) {
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

interface FootProps {
  d: NeedsYouDecision;
  full: FullPage;
  typing: DecisionAnswer | null;
  onType: (a: DecisionAnswer | null) => void;
  onPress: (a: DecisionAnswer, words: string | null) => void;
}

/** The acts that decide it, held in view at the foot of the peek, with the keys that press them. */
function Foot({ d, full, typing, onType, onPress }: FootProps) {
  const t = useCopy();
  const approve = approveOf(d);
  const decline = declineOf(d);
  const press = (a: DecisionAnswer) => (a.needsReason ? onType(a) : onPress(a, null));
  return (
    <div className="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-t border-line-subtle bg-surface px-4 py-3" data-testid="approval-peek-foot">
      {typing ? (
        <Words key={typing.id} answer={typing} onSend={(w) => onPress(typing, w)} onCancel={() => onType(null)} />
      ) : d.proposal ? (
        <div className="flex flex-wrap items-center gap-2">
          {approve ? (
            <Button variant="primary" onClick={() => onPress(approve, null)} data-testid="approval-peek-approve">
              {t("approvals.act.approve")}
            </Button>
          ) : null}
          {decline ? (
            <Button onClick={() => onType(decline)} data-testid="approval-peek-decline">
              {t("approvals.act.decline")}
            </Button>
          ) : null}
          {otherAnswersOf(d).map((a) => (
            <Button key={a.id} title={a.effect ?? undefined} onClick={() => press(a)} data-testid="approval-peek-answer">
              {a.label}
            </Button>
          ))}
          <Link href={full.href} className="px-2 text-13 font-semibold text-fg hover:underline" title={t("approvals.act.editTitle")} data-testid="approval-peek-edit">
            {t("approvals.act.edit")}
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {d.answers.map((a) => (
            <Button key={a.id} variant={a.recommended ? "primary" : "secondary"} title={a.effect ?? undefined} onClick={() => press(a)} data-testid="approval-peek-answer">
              {a.label}
            </Button>
          ))}
        </div>
      )}
      <p className="flex flex-wrap gap-x-3 text-12 text-subtle max-lg:hidden">
        <span>
          <Kbd>x</Kbd> {t("approvals.keys.select")}
        </span>
        {approve ? (
          <span>
            <Kbd>a</Kbd> {t("approvals.keys.approve")}
          </span>
        ) : null}
        {decline ? (
          <span>
            <Kbd>d</Kbd> {t("approvals.keys.decline")}
          </span>
        ) : null}
      </p>
    </div>
  );
}

interface PeekProps {
  d: NeedsYouDecision;
  peek: PeekState;
  full: FullPage;
  noun: string;
  typing: DecisionAnswer | null;
  onType: (a: DecisionAnswer | null) => void;
  onPress: (a: DecisionAnswer, words: string | null) => void;
}

export function DecisionPeek({ d, peek, full, noun, typing, onType, onPress }: PeekProps) {
  const t = useCopy();
  const time = useTimeFormat();
  return (
    <PeekPanel peek={peek} listLabel={t("approvals.title")} noun={noun} full={full} testId="approval-peek">
      <PeekHead
        noun={noun}
        itemKey={d.key}
        badge={d.touchedAt ? <span className="text-12 text-subtle">· {t("approvals.waiting", { age: time.age(d.touchedAt) })}</span> : undefined}
        title={d.title || d.key}
      />
      <div className="flex flex-col gap-5 px-4 pb-5">
        <Proposal d={d} />
        <PeekMockup d={d} itemHref={full.href} />
        <DecisionTags d={d} />
        <Reasons d={d} />
      </div>
      <Foot d={d} full={full} typing={typing} onType={onType} onPress={onPress} />
    </PeekPanel>
  );
}
