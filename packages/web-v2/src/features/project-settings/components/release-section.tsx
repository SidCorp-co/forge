"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Banner, PageSectionTitle, ErrorState, Skeleton } from "@/design";
import { statusReading } from "@/design/vocabulary";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { inlineCode } from "./inline-code";
import { useReleaseReadiness } from "../hooks";
import type { ReleaseReadiness } from "../types";

const DOCUMENT_GAPS = new Set(["release-target", "verify-probes"]);

const FACT_GAPS = new Set(["build-commands", "test-commands", "release-procedure"]);

/** What the badge says about where a landed change goes — the words a reader of the screen uses. */
function pathText(r: ReleaseReadiness, t: Copy): string {
  if (!r.production) return t("runs.releaseCard.pathNone");
  if (r.promotions.length === 0) return t("runs.releaseCard.pathNoMove");
  return t(r.promotions.length === 1 ? "runs.releaseCard.pathPromotionsOne" : "runs.releaseCard.pathPromotionsMany", { n: r.promotions.length });
}

/** The path as its branches, each named with the promotion that reaches it. */
function pathBranches(r: ReleaseReadiness, t: Copy): string {
  const start = r.defaultBranch ?? t("runs.releaseCard.noGit");
  if (r.promotions.length === 0) return start;
  return [start, ...r.promotions.map((p) => `${p.via} → ${p.to}`)].join("  ");
}

// A sentence with one word in bold: the word stands in the copy as this mark and is split out here.
const MARK = "\u0001";
function withBold(sentence: string, word: string): ReactNode {
  const [before = "", after = ""] = sentence.split(MARK);
  return (
    <>
      {before}
      <b>{word}</b>
      {after}
    </>
  );
}

const awaitingRelease = (language: string) => statusReading("issue", "awaiting_release", language).label;

function stateLine(r: ReleaseReadiness, t: Copy, language: string) {
  // An unreadable declaration is not a project that declares nothing. Saying so
  // would be the substitution this whole section exists to stop (ISS-1127).
  if (!r.declarationRead) return <>{t("runs.releaseCard.stateUnread")}</>;
  if (r.hasReleaseGate) return withBold(t("runs.releaseCard.stateGate", { status: MARK }), awaitingRelease(language));
  if (r.targetUndeclared) return <>{t("runs.releaseCard.stateUndeclared")}</>;
  return <>{t("runs.releaseCard.stateNone")}</>;
}

function SectionShell({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-6 border-t border-line pt-5">
      {heading}
      {children}
    </div>
  );
}

export function ReleaseSection({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const q = useReleaseReadiness(projectId);
  const heading = (r?: ReleaseReadiness) => (
    <div>
      <PageSectionTitle className="fg-label text-fg">{t("runs.releaseCard.heading")}</PageSectionTitle>
      <p className="fg-caption mt-0.5 text-muted">
        {withBold(t("runs.releaseCard.intro", { status: MARK }), awaitingRelease(language))} {r ? stateLine(r, t, language) : null}
      </p>
    </div>
  );

  if (q.isLoading)
    return (
      <SectionShell heading={heading()}>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-1/2 rounded-md" />
        </div>
      </SectionShell>
    );
  if (q.isError)
    return (
      <SectionShell heading={heading()}>
        <div className="mt-3">
          <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
        </div>
      </SectionShell>
    );
  const r = q.data;
  if (!r) return null;

  return (
    <SectionShell heading={heading(r)}>
      {r.declarationRead && <ReadinessFacts r={r} />}
      {r.declarationRead && !r.hasReleaseGate && (
        <p className="fg-caption mt-3 text-muted">
          {r.targetUndeclared && r.targetUndeclaredReason ? (
            inlineCode(r.targetUndeclaredReason)
          ) : (
            t("runs.releaseCard.noGateNote")
          )}{" "}
          {inlineCode(t("runs.releaseCard.projectDocumentDoor"))}
        </p>
      )}
      <Notices
        title={t("runs.releaseCard.blockers")}
        items={r.blockers.map((b) => ({ ...b, tone: b.evaluated ? "danger" : "attention" }))}
      />
      <Notices
        title={t("runs.releaseCard.warnings")}
        items={r.warnings.map((w) => ({ ...w, tone: "attention" }))}
      />
      {r.gaps.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="fg-caption text-subtle">{t("runs.releaseCard.undeclared")}</h4>
          {r.gaps.map((g) => (
            <Banner key={g} tone="attention">
              {inlineCode(t(`runs.releaseCard.gap.${g}` as ProductCopyKey))}{" "}
              {FACT_GAPS.has(g) ? (
                inlineCode(t("runs.releaseCard.knowledgeDoor"))
              ) : DOCUMENT_GAPS.has(g) ? (
                inlineCode(t("runs.releaseCard.projectDocumentDoor"))
              ) : (
                <Link href={`/projects/${slug}/settings?tab=integrations`} className="underline">
                  {t("runs.releaseCard.setOnConnection")}
                </Link>
              )}
            </Banner>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function Notices({
  title,
  items,
}: {
  title: string;
  items: { code: string; message: string; tone: "danger" | "attention" }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      <h4 className="fg-caption text-subtle">{title}</h4>
      {items.map((n) => (
        <Banner key={`${n.code}:${n.message}`} tone={n.tone}>
          <span className="font-mono">{n.code}</span> — {inlineCode(n.message)}
        </Banner>
      ))}
    </div>
  );
}

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div>
      <dt className="fg-caption text-subtle">{label}</dt>
      <dd className={mono ? "fg-body-sm font-mono text-fg" : "fg-body-sm text-fg"}>{children}</dd>
    </div>
  );
}

function ReadinessFacts({ r }: { r: ReleaseReadiness }) {
  const t = useCopy();
  const unread = t("runs.releaseCard.unread");
  return (
    <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <Fact label={t("runs.releaseCard.fact.release")}>
        <Badge tone={r.hasReleaseGate ? "accent" : "neutral"}>{pathText(r, t)}</Badge>
      </Fact>
      <Fact label={t("runs.releaseCard.fact.path")} mono>
        {pathBranches(r, t)}
      </Fact>
      <Fact label={t("runs.releaseCard.fact.production")}>
        {r.production ? (
          <>
            <span className="font-mono">{r.production.environment}</span>
            {" — "}
            {!r.channelsRead ? unread : r.providers.join(", ")}, {t(`runs.releaseCard.trigger.${r.production.trigger}` as ProductCopyKey)}
          </>
        ) : (
          "—"
        )}
      </Fact>
      <Fact label={t("runs.releaseCard.fact.runnerLabel")}>
        {!r.channelsRead ? (
          unread
        ) : r.releaseRunnerLabel ? (
          <span className="font-mono">{r.releaseRunnerLabel}</span>
        ) : (
          t("runs.releaseCard.noRunnerLabel")
        )}
      </Fact>
      <Fact label={t("runs.releaseCard.fact.rollback")}>
        {!r.channelsRead ? unread : t(`runs.releaseCard.rollback.${r.rollbackMode ?? "none"}` as ProductCopyKey)}
      </Fact>
      <Fact label={t("runs.releaseCard.fact.verifiedBy")}>{!r.channelsRead ? unread : r.hasVerify ? t("runs.releaseCard.verifiedProbe") : t("runs.releaseCard.verifiedNothing")}</Fact>
    </dl>
  );
}
