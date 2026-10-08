"use client";

import Link from "next/link";
import { StatusBadge, ViewHeading } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
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
          <span className="text-muted">{t("releases.attemptRefused")}</span> {c.refusal.code ? <code className="font-mono text-12">{c.refusal.code}</code> : null} {c.refusal.text}
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
