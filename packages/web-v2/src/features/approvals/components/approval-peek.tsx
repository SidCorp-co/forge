// The peek beside the Approvals list (REQ-48 BC-11, r3 BC-13..15): what is asked or proposed, said
// once in one plain line; why, once; what it rests on, each fact opening its own page; then, held in
// the panel's foot above the phone's tab bar, the one answer list, each answer a button saying what it
// does. Flat: no tinted box, hierarchy from type and whitespace. Nothing here builds an act: every
// button presses one core gave.
//
// A question an agent asked (ISS-1006, owner 2026-11-05) is decided from the asker's own plain text
// alone: that text, then the answers as buttons naming their outcome. What is asked, why, what it
// rests on and what each answer does sit behind one closed "Technical" fold that is never needed to
// decide. Where the asker wrote no plain text, the peek says so in its place, so whether the teaching
// took is seen where the person decides, and the decision is still made from the buttons. That
// place reads no less than the peek did before plain text existed (ISS-1006 round 2): the
// question's own line, the "No summary" marker, and the answer recommended, the rest behind the fold.

import type { DecisionAnswer, DecisionEvidence, NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { decisionLineOf } from "@forge/contracts/plain-decision";
import { Disclosure, type FullPage, PeekExcerpt, PeekHead, PeekPanel, type PeekState, Table, TBody, TD, TH, THead, TR } from "@/design";
import { QuestionSubjectLine } from "@/features/questions";
import { ChangeRequestList } from "@/features/releases";
import { Link } from "@/lib/navigation/router";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { PeekMockup } from "./approval-mockup";
import { DecisionTags } from "./approval-row";
import { DecisionAnswers } from "./decision-answers";

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-11-5 font-semibold uppercase tracking-wide text-subtle">{children}</h3>;
}

/** The question's subject line, unless the evidence already names that requirement (each fact once, ISS-680). */
const subjectOf = (d: NeedsYouDecision) =>
  d.subject && !(d.subject.kind === "requirement" && d.evidence?.requirement?.key === d.subject.key) ? d.subject : null;

/** What is asked, or what the agent proposes: one plain line under a small label, no box. */
function Asked({ d, slug }: { d: NeedsYouDecision; slug: string }) {
  const t = useCopy();
  const p = d.proposal;
  const subject = subjectOf(d);
  return (
    <section data-testid="approval-peek-proposal">
      <Heading>{t(p ? "approvals.peek.proposes" : "approvals.peek.asks")}</Heading>
      <p className="text-15 font-semibold leading-snug text-fg">{p ? (p.what ? `${p.verb}: ${p.what}` : p.verb) : d.question}</p>
      {subject ? <QuestionSubjectLine subject={subject} slug={slug} className="mt-1.5" /> : null}
    </section>
  );
}

/** What deciding it changes and its impact (REQ-68 BC-1), each said once, as two properties. */
function Stakes({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  return (
    <dl className="divide-y divide-line-subtle border-y border-line-subtle text-13" data-testid="approval-peek-stakes">
      <Fact name={t("needsYou.decisions.changes")}>{d.changes}</Fact>
      <Fact name={t("needsYou.decisions.impact")}>{d.impact}</Fact>
    </dl>
  );
}

/** A fact's row: its name, and the value that opens its page. */
function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4 py-2">
      <dt className="w-24 flex-none text-muted">{name}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  );
}

const linkClass = "font-medium text-link hover:underline";

/** The requirement fact: its key and revision as a link, its title under it. */
function RequirementFact({ e, slug }: { e: DecisionEvidence; slug: string }) {
  const t = useCopy();
  const r = e.requirement;
  return (
    <Fact name={t("approvals.evidence.requirement")}>
      {r ? (
        <>
          <Link href={requirementHref(slug, r.key)} className={linkClass}>
            {r.revision ? t("approvals.evidence.revision", { key: r.key, n: r.revision }) : r.key}
          </Link>
          <span className="block text-12 text-muted">{r.title}</span>
        </>
      ) : (
        <span className="text-muted">{t("approvals.evidence.none")}</span>
      )}
    </Fact>
  );
}

/** What the decision rests on (REQ-48 r3 BC-15): the requirement and revision, the plan, the criteria, each a link. */
function Evidence({ e, slug }: { e: DecisionEvidence; slug: string }) {
  const t = useCopy();
  const criteriaHref = e.requirement ? requirementHref(slug, e.requirement.key) : null;
  const criteria = e.criteria.codes.length > 0 ? t("approvals.evidence.criteriaTraced", { n: e.criteria.count, codes: e.criteria.codes.join(", ") }) : t("approvals.evidence.criteriaCount", { n: e.criteria.count });
  return (
    <section data-testid="approval-peek-evidence">
      <Heading>{t("approvals.peek.evidence")}</Heading>
      <dl className="divide-y divide-line-subtle border-y border-line-subtle text-13">
        <RequirementFact e={e} slug={slug} />
        <Fact name={t("approvals.evidence.criteria")}>
          {criteriaHref ? (
            <Link href={criteriaHref} className={linkClass}>
              {criteria}
            </Link>
          ) : (
            criteria
          )}
        </Fact>
      </dl>
    </section>
  );
}

/** What approving changes, why, and the records that move: the proposal's own lines, in its order. */
function Reasons({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  const p = d.proposal;
  if (!p) {
    const why = d.recommended?.why ?? d.noRecommendation;
    return why ? (
      <section data-testid="approval-peek-why">
        <Heading>{t("approvals.peek.why")}</Heading>
        <p className="text-13 text-fg">{why}</p>
      </section>
    ) : null;
  }
  // a consequence an answer already says on its button is said there alone (REQ-48 r3 BC-14)
  const onButtons = new Set(d.answers.map((a) => a.effect));
  const consequences = p.consequences.filter((c) => !onButtons.has(c));
  return (
    <>
      {consequences.length > 0 ? (
        <section data-testid="approval-peek-consequences">
          <Heading>{t("approvals.peek.ifApprove")}</Heading>
          <ul className="flex flex-col gap-1.5 text-13 text-fg">
            {consequences.map((c) => (
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


/**
 * The asker's plain text the person decides from; where it wrote none, the question's own line as
 * the peek read it before, the plain word that no summary was written, and the answer recommended
 * (ISS-1006 round 2), so a decision raised before the asker was taught reads no less than it did.
 */
function PlainText({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  const said = decisionLineOf(d);
  if (said.fromPlain) {
    return (
      <p className="whitespace-pre-line text-15 leading-relaxed text-fg" data-testid="approval-peek-plain">
        {said.text}
      </p>
    );
  }
  const recommended = d.answers.find((a) => a.recommended);
  return (
    <section className="flex flex-col gap-1.5" data-testid="approval-peek-fallback">
      <p className="whitespace-pre-line text-15 font-semibold leading-snug text-fg" data-testid="approval-peek-question">
        {said.text}
      </p>
      <p className="text-13 text-muted">
        <span className="italic" data-testid="approval-peek-no-plain">
          {t("approvals.peek.noPlain")}
        </span>
        {recommended ? (
          <span data-testid="approval-peek-recommended">
            {" · "}
            {t("approvals.peek.recommendedAnswer", { label: recommended.label })}
          </span>
        ) : null}
      </p>
    </section>
  );
}

/** What each answer does, said once behind the fold: a plain decision's buttons carry only their outcome. */
function AnswerEffects({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  const said = d.answers.filter((a) => a.effect);
  if (said.length === 0) return null;
  return (
    <section data-testid="approval-peek-effects">
      <Heading>{t("approvals.peek.effects")}</Heading>
      <dl className="divide-y divide-line-subtle border-y border-line-subtle text-13">
        {said.map((a) => (
          <Fact key={a.id} name={a.label}>
            {a.effect}
          </Fact>
        ))}
      </dl>
    </section>
  );
}

/**
 * Everything behind a plain decision's one fold: what is asked, its stakes, why, and what it rests
 * on. Where the face already says the question (no plain text), the fold keeps only its subject.
 */
function Technical({ d, slug }: { d: NeedsYouDecision; slug: string }) {
  const t = useCopy();
  const subject = subjectOf(d);
  return (
    <Disclosure title={t("approvals.peek.technical")} testId="approval-peek-technical">
      <div className="flex flex-col gap-5 pt-1">
        {decisionLineOf(d).fromPlain ? <Asked d={d} slug={slug} /> : subject ? <QuestionSubjectLine subject={subject} slug={slug} /> : null}
        <Stakes d={d} />
        <DecisionTags d={d} />
        <Reasons d={d} />
        <AnswerEffects d={d} />
        {d.evidence ? <Evidence e={d.evidence} slug={slug} /> : null}
      </div>
    </Disclosure>
  );
}

/** A decision an agent writes plain text for: a question, where its asker's text is read or its absence said. */
const decidedFromPlain = (d: NeedsYouDecision): d is NeedsYouDecision & { plain: string | null } => d.plain !== undefined;

interface PeekProps {
  d: NeedsYouDecision;
  peek: PeekState;
  full: FullPage;
  slug: string;
  noun: string;
  typing: DecisionAnswer | null;
  onType: (a: DecisionAnswer | null) => void;
  onPress: (a: DecisionAnswer, words: string | null) => void;
}

/**
 * The key the head names. A question's own key is its id, never shown as text (ui-copy-rule), and the
 * item it opens is named where the question says it rests on it (its subject, its evidence, its
 * impact), once: so a question's head names the item's kind alone (ISS-687 round 5, judge run
 * 13b796d4 read a uuid beside "Feedback").
 */
const keyShown = (d: NeedsYouDecision): string | undefined => (d.entity === "question" ? undefined : d.key);

export function DecisionPeek({ d, peek, full, slug, noun, typing, onType, onPress }: PeekProps) {
  const t = useCopy();
  const time = useTimeFormat();
  const edit = d.proposal ? (
    <Link href={full.href} className="self-start text-13 font-semibold text-fg hover:underline" title={t("approvals.act.editTitle")} data-testid="approval-peek-edit">
      {t("approvals.act.edit")}
    </Link>
  ) : undefined;
  return (
    <PeekPanel
      peek={peek}
      listLabel={t("approvals.title")}
      noun={noun}
      full={full}
      testId="approval-peek"
      foot={<DecisionAnswers d={d} typing={typing} onType={onType} onPress={onPress} editHref={edit} outcomesOnly={decidedFromPlain(d)} />}
    >
      <PeekHead
        noun={noun}
        itemKey={keyShown(d)}
        badge={d.touchedAt ? <span className="text-12 text-subtle">· {t("approvals.waiting", { age: time.age(d.touchedAt) })}</span> : undefined}
        title={d.title || keyShown(d)}
      />
      {decidedFromPlain(d) ? (
        <div className="flex flex-col gap-4 px-4.5 pb-5" data-testid="approval-peek-decide">
          <PlainText d={d} />
          <Technical d={d} slug={slug} />
        </div>
      ) : (
      <div className="flex flex-col gap-5 px-4.5 pb-5">
        <Asked d={d} slug={slug} />
        <Stakes d={d} />
        <PeekMockup d={d} itemHref={full.href} />
        <DecisionTags d={d} />
        <Reasons d={d} />
        {d.evidence ? <Evidence e={d.evidence} slug={slug} /> : null}
        {d.changeRequests && d.changeRequests.length > 0 ? (
          <section data-testid="approval-peek-merges">
            <Heading>{t("approvals.peek.merges")}</Heading>
            <ChangeRequestList items={d.changeRequests} slug={slug} />
          </section>
        ) : null}
      </div>
      )}
    </PeekPanel>
  );
}
