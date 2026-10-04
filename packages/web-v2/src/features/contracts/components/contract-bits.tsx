"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { type BannerTone, Button, EnumBadge, LEGEND, MarkStrip, StatusBadge, statusReading, WaitBanner } from "@/design";
import { feedbackHref } from "@/features/feedback/routes";
import { issueHref } from "@/features/issues/routes";
import { requirementHref } from "@/features/requirements/routes";
import { formatStamp } from "@/lib/utils/format";
import type { ContractAttentionGroup, ContractConsumerView, ContractStandingRow } from "../types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function ContractStateBadge({ row }: { row: Pick<ContractStandingRow, "state"> }) {
  return <StatusBadge family="contractState" value={row.state} />;
}

export function KindBadge({ kind }: { kind: string }) {
  return <EnumBadge family="interfaceType" value={kind} />;
}

function windowLeft(dueAt: string, now: number = Date.now()): string {
  const ms = new Date(dueAt).getTime() - now;
  if (ms <= 0) {
    const ago = Math.max(1, Math.floor(-ms / DAY));
    return `Ended ${ago}d ago`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  if (d >= 7) return `${d}d`;
  if (d >= 1) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  return `${Math.max(1, h)}h`;
}

export function WindowText({ row, now }: { row: ContractStandingRow; now?: number }) {
  const w = row.window;
  if (w?.open) {
    return (
      <span className="font-mono text-12-5 font-semibold" style={{ color: LEGEND.you.fg }} title={`${w.version}: consumers adapt before ${formatStamp(w.dueAt)}`} data-testid="window-left">
        {windowLeft(w.dueAt, now)}
      </span>
    );
  }
  if (row.direction === "provided") {
    return (
      <span className="text-12-5 text-muted" title="The notice this project commits to before a breaking version takes effect">
        {row.noticeDays === null ? "No notice declared" : `${row.noticeDays}-day notice`}
      </span>
    );
  }
  return <span className="text-12-5 text-muted">{row.state === "behind" ? `Behind ${row.current?.version ?? ""}`.trim() : "On latest"}</span>;
}

const BANNER: Record<ContractAttentionGroup, BannerTone> = { needs_you: "you", waiting: "blocked", steady: "calm" };

function bannerHead(row: ContractStandingRow): string {
  const w = row.waitingOn;
  if (row.attentionGroup === "needs_you") return "Waiting on you:";
  if (row.attentionGroup === "steady") return "Steady:";
  return `Waiting on ${w.who}:`;
}

function refLink(slug: string, ref: string | null): ReactNode {
  if (!ref) return null;
  const href = /^FB-\d+$/.test(ref) ? feedbackHref(slug, ref) : /^REQ-\d+$/.test(ref) ? requirementHref(slug, ref) : /^[A-Z][A-Z0-9]*-\d+$/.test(ref) ? issueHref(slug, ref) : null;
  return href ? (
    <Link href={href} className="font-mono text-12 font-semibold text-link hover:underline">
      {ref}
    </Link>
  ) : null;
}

export function ContractBanner({ row, slug, className }: { row: ContractStandingRow; slug: string; className?: string }) {
  const w = row.waitingOn;
  const link = row.direction === "provided" && w.ref?.startsWith("REQ-") ? refLink(slug, w.ref) : row.direction === "consumed" ? refLink(slug, w.ref) : null;
  return (
    <WaitBanner
      tone={BANNER[row.attentionGroup]}
      head={bannerHead(row)}
      body={
        <>
          {w.act}
          {link ? <> · {link}</> : null}
        </>
      }
      rule={w.rule}
      className={className}
      testId="contract-banner"
    />
  );
}

function contractActionOf(row: ContractStandingRow): { label: string; kind: "feedback" | "requirement" | "versions" } | null {
  if (row.attentionGroup !== "needs_you" || !row.waitingOn.ref) return null;
  const ref = row.waitingOn.ref;
  if (row.direction === "consumed") return { label: `Open ${ref}`, kind: "feedback" };
  if (ref.startsWith("REQ-")) return { label: `Reply on ${ref}`, kind: "requirement" };
  return { label: `Decide ${ref}`, kind: "versions" };
}

export function ContractAction({ row, slug, onVersions }: { row: ContractStandingRow; slug: string; onVersions?: () => void }) {
  const router = useRouter();
  const act = contractActionOf(row);
  const ref = row.waitingOn.ref;
  if (!act || !ref) return null;
  const go = () => {
    if (act.kind === "feedback") router.push(feedbackHref(slug, ref));
    else if (act.kind === "requirement") router.push(requirementHref(slug, ref));
    else onVersions?.();
  };
  if (act.kind === "versions" && !onVersions) return null;
  return (
    <Button type="button" variant="primary" size="sm" onClick={go} data-testid="contract-action">
      {act.label}
    </Button>
  );
}

export function AdoptionStrip({ consumers, latest }: { consumers: ContractConsumerView[]; latest: string | null }) {
  if (consumers.length === 0) return <span className="text-12-5 text-subtle">No consumer yet</span>;
  const on = consumers.filter((c) => c.adoption === "current").length;
  return (
    <span className="inline-flex items-center gap-2" data-testid="adoption-strip">
      <MarkStrip
        marks={consumers.map((c) => ({
          key: c.project.id,
          label: `${c.project.slug} on ${c.builtAgainst} · ${statusReading("contractAdoption", c.adoption).label}${latest ? ` · latest ${latest}` : ""}`,
          tone: statusReading("contractAdoption", c.adoption).tone,
        }))}
      />
      <span className="text-12-5 text-muted">
        {on} of {consumers.length} on latest
      </span>
    </span>
  );
}

export function versionLine(row: ContractStandingRow): string {
  const cur = row.current?.version;
  if (row.direction === "consumed") {
    const ours = row.ours ? `we use ${row.ours}` : "not pinned";
    return cur && cur !== row.ours ? `${ours} · ${cur} current` : ours;
  }
  const pending = row.pending ? ` → ${row.pending.version} proposed` : "";
  return cur ? `${cur}${pending}` : row.pending ? `${row.pending.version} proposed` : "No version";
}
