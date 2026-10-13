
// The intake assistant's draft of a requirement or feedback item (REQ-34 BC-12..BC-16), as core keeps
// it: what the item duplicates, conflicts with, affects and relates to, each a link, and each workflow it
// touches but does not affect, with why; the gaps it filled, each with the record it came from; and at
// most three questions, each option with what it changes and the recommended one marked, or that it has
// nothing to ask and why. Rows, not prose; nothing shows before a
// draft exists.

import { Link } from "@/lib/navigation/router";
import { FieldLabel, ViewHeading } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import { INTAKE_DRAFT_ATTEMPTS, intakeRefParse } from "@forge/contracts/intake-drafts";
import { useIntakeDraft } from "../hooks";
import type { IntakeDraftRef, IntakeDraftView, IntakeQuestion } from "../types";

function hrefOf(slug: string, ref: Pick<IntakeDraftRef, "kind" | "key">): string {
  if (ref.kind === "requirement") return requirementHref(slug, ref.key);
  if (ref.kind === "feedback") return feedbackHref(slug, ref.key);
  if (ref.kind === "workflow") return workflowHref(slug, ref.key);
  return releaseHref(slug, ref.key);
}

/** One record a draft names, linked to its page. */
function IntakeRefLink({ slug, target: r }: { slug: string; target: Pick<IntakeDraftRef, "kind" | "key"> }) {
  return (
    <Link href={hrefOf(slug, r)} className="font-mono text-13 text-accent-text hover:underline" data-testid="intake-ref">
      {r.key}
    </Link>
  );
}

/** An assumption's source as a requirement's spec stores it (REQ-n, FB-n, workflow:<flow>, release:<v>), linked. */
export function IntakeSource({ slug, source }: { slug: string; source: string }) {
  const t = useCopy();
  const ref = intakeRefParse(source);
  return (
    <span data-testid="assumption-source">
      {t("intake.from")} {ref ? <IntakeRefLink slug={slug} target={ref} /> : source}
    </span>
  );
}

function Question({ q }: { q: IntakeQuestion }) {
  const t = useCopy();
  return (
    <li className="grid gap-1.5 border-t border-line-subtle py-3 first:border-t-0 first:pt-0" data-testid="intake-question">
      <p className="text-14 leading-snug text-fg">
        {q.prompt} <span className="text-12 text-subtle">· {t(q.changes === "scope" ? "intake.changes.scope" : "intake.changes.outcome")}</span>
      </p>
      <ul className="grid gap-1 pl-3">
        {q.options.map((o) => (
          <li key={o.id} className="text-13 leading-snug" data-testid="intake-option" data-recommended={o.id === q.recommended || undefined}>
            <span className="font-medium text-fg">{o.label}</span>
            {o.id === q.recommended ? <span className="ml-1.5 text-12 font-semibold text-accent-text">{t("intake.recommended")}</span> : null}
            <span className="text-muted"> · {o.effect}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Applied({ draft }: { draft: IntakeDraftView }) {
  const t = useCopy();
  const a = draft.applied;
  if (!a) return null;
  const said =
    a.as === "revision"
      ? t("intake.applied.revision", { revision: a.revision })
      : a.as === "suggestion"
        ? t("intake.applied.suggestion")
        : t("intake.applied.none");
  return (
    <span data-testid="intake-applied" title={a.as === "none" ? a.code : undefined}>
      {said}
    </span>
  );
}

/** The draft's rows. `assumptions` is false where the page already shows them, as a requirement's spec does. */
function IntakeDraftBody({ draft, slug, assumptions }: { draft: IntakeDraftView; slug: string; assumptions: boolean }) {
  const t = useCopy();
  if (draft.outcome === "failed") {
    return (
      <p className="text-13 text-subtle" data-testid="intake-failed" title={draft.detail ?? undefined}>
        {draft.retrying
          ? t("intake.retrying", { next: draft.attempts + 1, max: INTAKE_DRAFT_ATTEMPTS })
          : draft.code
            ? t(`intake.failed.${draft.code}`)
            : t("intake.applied.none")}
        {!draft.retrying && draft.attempts > 1 ? ` · ${t("intake.gaveUp", { attempts: draft.attempts })}` : null}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div>
        <FieldLabel>{t("intake.links")}</FieldLabel>
        {draft.links.length === 0 && draft.notAffected.length === 0 ? (
          <p className="text-13 text-subtle">{t("intake.none")}</p>
        ) : (
          <ul className="grid gap-1.5">
            {draft.links.map((l) => (
              <li key={`${l.relation} ${l.ref.kind} ${l.ref.key}`} className="text-13 leading-snug" data-testid="intake-link">
                <span className="mr-1.5 font-medium text-fg">{t(`intake.relation.${l.relation}`)}</span>
                <IntakeRefLink slug={slug} target={l.ref} /> <span className="text-muted">{l.ref.title}</span>
                <span className="text-subtle"> · {l.why}</span>
              </li>
            ))}
            {draft.notAffected.map((n) => (
              <li key={`not ${n.ref.kind} ${n.ref.key}`} className="text-13 leading-snug" data-testid="intake-not-affected">
                <span className="mr-1.5 font-medium text-fg">{t("intake.notAffected")}</span>
                <IntakeRefLink slug={slug} target={n.ref} /> <span className="text-muted">{n.ref.title}</span>
                <span className="text-subtle"> · {n.why}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {assumptions ? (
        <div>
          <FieldLabel>{t("intake.assumed")}</FieldLabel>
          {draft.assumptions.length === 0 ? (
            <p className="text-13 text-subtle">{t("intake.none")}</p>
          ) : (
            <ul className="grid gap-1.5">
              {draft.assumptions.map((a) => (
                <li key={`${a.field} ${a.value}`} className="text-13 leading-snug" data-testid="intake-assumption">
                  <span className="mr-1.5 font-medium text-fg">{t(`intake.field.${a.field}`)}</span>
                  <span className="text-fg">{a.value}</span>
                  <span className="text-subtle"> · {t("intake.from")} </span>
                  <IntakeRefLink slug={slug} target={a.source} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <div>
        <FieldLabel>{t("intake.questions")}</FieldLabel>
        {draft.questions.length === 0 ? (
          <p className="text-13 leading-snug" data-testid="intake-nothing-to-ask">
            <span className="font-medium text-fg">{t("intake.nothingToAsk")}</span>
            {draft.nothingToAsk ? <span className="text-subtle"> · {draft.nothingToAsk}</span> : null}
          </p>
        ) : (
          <ul className="grid">
            {draft.questions.map((q) => (
              <Question key={q.prompt} q={q} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The intake draft of `itemKey` (REQ-n or FB-n); nothing while none was made. */
export function IntakeDraft({ projectId, slug, itemKey, assumptions }: { projectId: string; slug: string; itemKey: string; assumptions: boolean }) {
  const t = useCopy();
  const q = useIntakeDraft(projectId, itemKey);
  const draft = q.data?.draft;
  if (!draft) return null;
  return (
    <section data-testid="intake-draft">
      <ViewHeading right={<Applied draft={draft} />}>{t("intake.heading")}</ViewHeading>
      <IntakeDraftBody draft={draft} slug={slug} assumptions={assumptions} />
    </section>
  );
}
