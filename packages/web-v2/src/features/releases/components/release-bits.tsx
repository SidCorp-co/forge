"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { type BannerTone, Icon, LEGEND, Tooltip, WaitBanner } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { ApiError } from "@/lib/api/client";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import { said, saidView } from "@/lib/i18n/said";
import { issueHref } from "@/lib/routes/issues";
import { cn } from "@/lib/utils/cn";
import type { ReleaseAttentionGroup, ReleaseDetail, ReleaseGateView } from "../types";

const BANNER_TONE: Record<ReleaseAttentionGroup, BannerTone> = {
  needs_you: "you",
  moving: "run",
  waiting: "calm",
  queued: "calm",
  stuck: "err",
  done: "calm",
  stopped: "calm",
};

export const shortSha = (sha: string) => sha.slice(0, 7);

const NAMED_IN_SENTENCE = 5;

export function DisclosureToggle({
  open,
  onToggle,
  className,
  testId,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  className: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn("inline-flex items-center gap-1 font-medium text-link", className)}
      aria-expanded={open}
      onClick={onToggle}
      data-testid={testId}
    >
      <Icon name="chevronDown" size={12} className={open ? "" : "-rotate-90"} />
      {children}
    </button>
  );
}

/** Each issue a gate names, as a link to it: the issue page is where its note is written and where a
 *  comment reaches the master that owes it (F73). */
function GateIssues({ issues, slug }: { issues: readonly string[]; slug: string }) {
  return (
    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-12" data-testid="gate-issues">
      {issues.map((key) => (
        <Link key={key} href={issueHref(slug, key)} className="text-link hover:underline">
          {key}
        </Link>
      ))}
    </span>
  );
}

/** How a reason reads: a `problem` stops a release and has someone to clear it, a `warning` changes how
 *  one runs, and a `state` is the project as it normally stands (nothing waiting, a release already running). */
export type GateTone = "problem" | "warning" | "state";

const GATE_DOT: Record<GateTone, string> = { problem: LEGEND.err.dot, warning: LEGEND.you.dot, state: LEGEND.neutral.dot };

export function GateLine({ gate, slug, tone }: { gate: ReleaseGateView; slug: string; tone?: GateTone }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const [open, setOpen] = useState(false);
  const more = gate.issues.length > NAMED_IN_SENTENCE;
  const owner = gate.owner;
  const title = said(gate.says.title, language);
  const read = tone ?? (gate.kind === "blocker" ? "problem" : "warning");
  return (
    <li className="flex items-start gap-2 py-2 text-13" data-testid="release-gate" data-code={gate.code} data-tone={read}>
      <span aria-hidden className="mt-[7px] size-1.5 flex-none rounded-full" style={{ background: GATE_DOT[read] }} />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">{title}.</b> {said(gate.says.sentence, language)}
        {owner.kind === "system" ? null : (
          <span className="mt-0.5 block text-12-5 text-muted" data-testid="gate-owner">
            {t("releases.gateOwes", { who: said(owner.says.who, language), act: said(owner.says.act, language) })}
          </span>
        )}
        {gate.issues.length > 0 && !more ? <GateIssues issues={gate.issues} slug={slug} /> : null}
        {more ? (
          <>
            {" "}
            <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12-5" testId="gate-issues-toggle">
              {open ? t("releases.gateHideIssues") : t("releases.gateAllIssues", { n: gate.issues.length })}
            </DisclosureToggle>
            {open ? <GateIssues issues={gate.issues} slug={slug} /> : null}
          </>
        ) : null}
      </span>
      <Tooltip label={`${gate.code} · ${gate.detail}`} multiline>
        <span className="mt-0.5 text-subtle" role="img" aria-label={t("releases.gateDetails", { title })}>
          <Icon name="info" size={14} />
        </span>
      </Tooltip>
    </li>
  );
}

export function ReleaseBanner({ r, className }: { r: ReleaseDetail; className?: string }) {
  const t = useCopy();
  const label = useLabel();
  const w = saidView(r.waitingOn, useInterfaceLanguage());
  const ended = r.attentionGroup === "done" || r.attentionGroup === "stopped";
  const stuck = r.attentionGroup === "stuck";
  const head = ended
    ? `${label("releaseState", r.state)}.`
    : stuck
      ? t("releases.bannerStuck")
      : w.kind === "you"
        ? t("releases.bannerWaitingYou")
        : t("releases.bannerWaitingOn", { who: w.who });
  const body = ended
    ? r.state === "shipped"
      ? r.current
        ? r.production?.url
          ? t("releases.bannerLiveAt", { where: r.production.url.replace(/^https?:\/\//, "").replace(/\/$/, "") })
          : t("releases.bannerLive")
        : t("releases.bannerSuperseded")
      : t("releases.bannerNothingOwed")
    : stuck
      ? `${w.who}: ${w.act}`
      : w.act;
  return <WaitBanner tone={BANNER_TONE[r.attentionGroup]} head={head} body={body} rule={w.rule || undefined} effect={w.effect} className={className} />;
}

export function RefusalText({ error }: { error: unknown }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : null;
  return (
    <p role="alert" className="text-12" style={{ color: "var(--red-600)" }} title={code ?? undefined} data-testid="release-refusal">
      {formatApiError(error)}
    </p>
  );
}
