"use client";

import Link from "next/link";
import { StatusBadge, ViewHeading } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { Written } from "@/lib/i18n/written";
import { issueHref } from "@/lib/routes/issues";
import type { Copy } from "@/lib/i18n/product-copy";
import { releaseHref } from "@/lib/routes/releases";
import type { ReleaseContinuation, ReleaseCutView, ReleaseDetail, ReleaseVersionCarrier } from "../types";

const carriersOf = (list: readonly ReleaseVersionCarrier[], t: Copy) => list.map((c) => t(`releases.carrier.${c.kind}`, { name: c.name })).join(", ");

/** How this attempt came to wear its version, in the words its cut recorded (core `version-rule.ts`). */
function ruleLine(c: ReleaseCutView, t: Copy): string {
  const r = c.rule;
  if (r.decided === "first") return t("releases.rule.first", { v: c.version });
  if (r.decided === "reused") return t("releases.rule.reused", { v: c.version });
  if (r.decided === "bumped") {
    if (r.taken && r.carriers.length === 0 && !r.line) return t("releases.rule.bumpedTaken", { v: c.version, from: r.from ?? "" });
    return r.carriers.length > 0
      ? t("releases.rule.bumpedCarried", { v: c.version, from: r.from ?? "", carriers: carriersOf(r.carriers, t) })
      : t("releases.rule.bumpedLine", { v: c.version, from: r.from ?? "", line: r.line ?? "" });
  }
  return t("releases.rule.unrecorded");
}

function carriedLine(c: ReleaseCutView, t: Copy): string | null {
  if (c.outcome !== "aborted" && c.outcome !== "failed") return null;
  if (c.carried === null) return t("releases.carried.unknown", { v: c.version });
  if (c.carried.length === 0) return t("releases.carried.none", { v: c.version });
  return t("releases.carried.some", { carriers: carriersOf(c.carried, t) });
}

function Attempt({ c, release, slug }: { c: ReleaseCutView; release: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const ended = c.outcome === "aborted" || c.outcome === "failed" || c.outcome === "shipped";
  const carried = carriedLine(c, t);
  return (
    <li className="grid gap-1 border-b border-line-subtle py-2.5 text-13" data-testid="release-cut" data-n={c.n} data-outcome={c.outcome}>
      <span className="flex flex-wrap items-center gap-2">
        <b className="font-semibold">{t("releases.attemptN", { n: c.n })}</b>
        <StatusBadge family="releaseState" value={c.outcome} />
        {c.version === release ? null : (
          <Link href={releaseHref(slug, c.version)} className="font-mono text-12 text-link hover:underline">
            {t("releases.attemptWore", { v: c.version })}
          </Link>
        )}
        <span className="text-12 text-muted" title={time.dateTime(c.cutAt)}>
          {time.relative(c.cutAt)}
        </span>
        {c.cutBy ? <span className="text-12 text-muted">{t("releases.attemptCutBy", { who: c.cutBy.name })}</span> : null}
        {ended && c.outcome !== "shipped" ? (
          <span className="text-12 text-muted" data-testid="cut-decided-by">
            {c.decidedBy ? t("releases.attemptEndedBy", { who: c.decidedBy.name }) : t("releases.attemptEndedByForge")}
          </span>
        ) : null}
      </span>
      <span className="text-12-5 text-muted" data-testid="cut-rule">
        {ruleLine(c, t)}
      </span>
      {c.refusal ? (
        <span className="text-12-5" data-testid="cut-refusal">
          <span className="text-muted">{t("releases.attemptRefused")}</span> {said(c.refusal.says, language)}{" "}
          {c.refusal.code ? <code className="font-mono text-12">{c.refusal.code}</code> : null}
          <Written className="block text-12 text-muted" text={c.refusal.text} lang="en" />
        </span>
      ) : null}
      {c.abortReason ? (
        <span className="text-12-5" data-testid="cut-abort-reason">
          <span className="text-muted">{t("releases.attemptAbortReason")}</span> {c.abortReason}
        </span>
      ) : null}
      {carried ? (
        <span className="text-12-5 text-muted" data-testid="cut-carried">
          {carried}
        </span>
      ) : null}
    </li>
  );
}

/** Every attempt at this release, flat and first first: what each cut wore, how it ended, and who ended it. */
export function AttemptsSection({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  if (r.cuts.length === 0) return null;
  return (
    <section aria-label={t("releases.attempts")} data-testid="release-cuts">
      <ViewHeading hint={t("releases.attemptsHint")}>{t("releases.attempts")}</ViewHeading>
      <ol className="border-t border-line-subtle">
        {r.cuts.map((c) => (
          <Attempt key={c.runId} c={c} release={r.version} slug={slug} />
        ))}
      </ol>
    </section>
  );
}

/** A version whose roster went on under another version says where, so its history is read once. */
export function ContinuedAs({ to, slug, className }: { to: ReleaseContinuation; slug: string; className?: string }) {
  const t = useCopy();
  return (
    <p className={className} data-testid="release-continued-as">
      <Link href={releaseHref(slug, to.version)} className="text-13 text-link hover:underline">
        {t(to.shipped ? "releases.continuedAs.shipped" : "releases.continuedAs.recut", { v: to.version })}
      </Link>
    </p>
  );
}

/**
 * Why a version that did not ship ended, at the top of its own page: the attempt that wore it, the
 * refusal said in the reader's language with its words as recorded behind a fold, the abort reason,
 * what carries the version, and the roster that attempt was cut with — not the release it went on as.
 */
export function EndedAttempt({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (r.state !== "aborted" && r.state !== "failed") return null;
  const own = r.cuts.find((c) => c.version === r.version && c.runId === r.runId) ?? r.cuts.find((c) => c.version === r.version);
  if (!own) return null;
  const carried = carriedLine(own, t);
  return (
    <section aria-label={t(`releases.ended.title.${r.state}`, { v: r.version })} data-testid="release-ended" className="grid gap-2 border-b border-line-subtle px-8 py-4 text-13 max-md:px-4">
      <h2 className="fg-h3 text-[var(--accent-text)]">{t(`releases.ended.title.${r.state}`, { v: r.version })}</h2>
      {own.refusal ? (
        <div data-testid="release-ended-refusal">
          <p>{said(own.refusal.says, language)}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-12-5 text-link">{t("releases.ended.words")}</summary>
            <p className="mt-1 text-12-5 text-muted">
              {own.refusal.code ? <code className="font-mono text-12">{own.refusal.code}</code> : null} <Written text={own.refusal.text} lang="en" />
            </p>
          </details>
        </div>
      ) : null}
      {own.abortReason ? (
        <p data-testid="release-ended-abort">
          <span className="text-muted">{t("releases.attemptAbortReason")}</span> <Written text={own.abortReason} lang={null} />
        </p>
      ) : null}
      {!own.refusal && !own.abortReason ? <p className="text-muted">{t("releases.ended.noReason")}</p> : null}
      {carried ? <p className="text-12-5 text-muted">{carried}</p> : null}
      <div data-testid="release-ended-roster">
        <p className="text-12-5 text-muted">{t("releases.ended.roster", { n: own.roster.length })}</p>
        <ul className="mt-1 border-t border-line-subtle">
          {own.roster.map((i) => (
            <li key={i.key} className="flex gap-3 border-b border-line-subtle py-1.5">
              <Link href={issueHref(slug, i.key)} className="font-mono text-12 text-link hover:underline">
                {i.key}
              </Link>
              <Written className="min-w-0 flex-1" text={i.title} lang={null} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
