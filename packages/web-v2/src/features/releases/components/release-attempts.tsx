
import { Link } from "@/lib/navigation/router";
import { StatusBadge, ViewHeading } from "@/design";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { Written } from "@/lib/i18n/written";
import { issueHref } from "@/lib/routes/issues";
import type { Copy } from "@/lib/i18n/product-copy";
import { releaseHref } from "@/lib/routes/releases";
import type { ReleaseAbortView, ReleaseContinuation, ReleaseCutView, ReleaseDetail, ReleaseVersionCarrier } from "../types";

const carriersOf = (list: readonly ReleaseVersionCarrier[], t: Copy) => list.map((c) => t(`releases.carrier.${c.kind}`, { name: c.name })).join(", ");

/** How this attempt came to wear its version, in the words its cut recorded (core `version-rule.ts`). */
function ruleLine(c: ReleaseCutView, t: Copy): string {
  const r = c.rule;
  if (r.decided === "first") return t("releases.rule.first", { v: c.version });
  if (r.decided === "reused") return t("releases.rule.reused", { v: c.version });
  if (r.decided === "given") return t("releases.rule.given", { v: c.version });
  if (r.decided === "bumped") {
    if (r.taken && r.carriers.length === 0 && !r.line) return t("releases.rule.bumpedTaken", { v: c.version, from: r.from ?? "" });
    if (r.overtaken && r.carriers.length === 0 && !r.line) return t("releases.rule.bumpedOvertaken", { v: c.version, from: r.from ?? "", above: r.overtaken });
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

/** The abort in one short line, who owes the next act where it named one; its reason opens on demand. */
function AbortLine({ a, testId }: { a: ReleaseAbortView; testId: string }) {
  const t = useCopy();
  if (!a.recorded) {
    return (
      <span className="text-13 text-muted" data-testid={`${testId}-unrecorded`}>
        {t("releases.abort.unrecorded")}
      </span>
    );
  }
  return (
    <details className="text-13" data-testid={testId}>
      <summary className="cursor-pointer text-muted">{a.blocker ? t(`releases.abort.owes.${a.blocker.owes}`, { what: a.blocker.waitingFor }) : t("releases.abort.reason")}</summary>
      <Written className="mt-1 block text-12 text-muted" text={a.reason} lang={null} />
    </details>
  );
}

/** The failure's code and the step it stood at, for the tooltip: the sentence is what is read. */
function failureTitle(f: NonNullable<ReleaseCutView["failure"]>): string {
  return f.step ? `${f.code} · ${f.step}` : f.code;
}

function Attempt({ c, release, slug }: { c: ReleaseCutView; release: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const ended = c.outcome === "aborted" || c.outcome === "failed" || c.outcome === "shipped" || c.outcome === "landed";
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
        {ended && c.outcome !== "shipped" && c.outcome !== "landed" ? (
          <span className="text-12 text-muted" data-testid="cut-decided-by">
            {c.decidedBy ? t("releases.attemptEndedBy", { who: c.decidedBy.name }) : t("releases.attemptEndedByForge")}
          </span>
        ) : null}
      </span>
      <span className="text-13 text-muted" data-testid="cut-rule">
        {ruleLine(c, t)}
      </span>
      {c.refusal ? (
        <span className="text-13" data-testid="cut-refusal">
          <span className="text-muted">{t("releases.attemptRefused")}</span> {said(c.refusal.says, language)}{" "}
          {c.refusal.code ? <code className="font-mono text-12">{c.refusal.code}</code> : null}
          <Written className="block text-12 text-muted" text={c.refusal.text} lang="en" />
        </span>
      ) : null}
      {c.abort ? <AbortLine a={c.abort} testId="cut-abort" /> : null}
      {c.failure ? (
        <span className="text-13" data-testid="cut-failure" title={failureTitle(c.failure)}>
          <span className="text-muted">{t("releases.attemptFailure")}</span> <Written text={c.failure.detail} lang="en" />
        </span>
      ) : null}
      {c.repair ? (
        <span className="text-13" data-testid="cut-repair" title={c.repair.evidence}>
          <span className="text-muted">{t("releases.attemptRepaired", { who: c.repair.by?.name ?? "—" })}</span> <Written text={c.repair.reason} lang={null} />
        </span>
      ) : null}
      {carried ? (
        <span className="text-13 text-muted" data-testid="cut-carried">
          {carried}
        </span>
      ) : null}
    </li>
  );
}

/** Every attempt at this release, flat and first first: what each cut wore, how it ended, and who ended it. */
export function ReleaseAttempts({ r, slug }: { r: ReleaseDetail; slug: string }) {
  const t = useCopy();
  if (r.cuts.length === 0) return null;
  return (
    <section aria-label={t("releases.attempts")} data-testid="release-cuts">
      <ViewHeading>{t("releases.attempts")}</ViewHeading>
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
 * refusal said in the reader's language with its words as recorded behind a fold, the abort's line,
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
      <h2 className="fg-h3 text-accent-text">{t(`releases.ended.title.${r.state}`, { v: r.version })}</h2>
      {own.refusal ? (
        <div data-testid="release-ended-refusal">
          <p>{said(own.refusal.says, language)}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-13 text-link">{t("releases.ended.words")}</summary>
            <p className="mt-1 text-13 text-muted">
              {own.refusal.code ? <code className="font-mono text-12">{own.refusal.code}</code> : null} <Written text={own.refusal.text} lang="en" />
            </p>
          </details>
        </div>
      ) : null}
      {own.abort ? <AbortLine a={own.abort} testId="release-ended-abort" /> : null}
      {own.failure ? (
        <p data-testid="release-ended-failure" title={failureTitle(own.failure)}>
          <span className="text-muted">{t("releases.attemptFailure")}</span> <Written text={own.failure.detail} lang="en" />
        </p>
      ) : null}
      {!own.refusal && !own.abort && !own.failure ? <p className="text-muted">{t("releases.ended.noReason")}</p> : null}
      {carried ? <p className="text-13 text-muted">{carried}</p> : null}
      <div data-testid="release-ended-roster">
        <p className="text-13 text-muted">{t("releases.ended.roster", { n: own.roster.length })}</p>
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
