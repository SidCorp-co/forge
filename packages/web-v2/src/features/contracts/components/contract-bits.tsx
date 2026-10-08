"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { type BannerTone, Button, LEGEND, MarkStrip, statusReading, WaitBanner } from "@/design";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { saidView } from "@/lib/i18n/said";
import { formatStamp } from "@/lib/utils/format";
import type { ContractAttentionGroup, ContractConsumerView, ContractStandingRow } from "../types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function windowLeft(dueAt: string, t: Copy): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms <= 0) {
    const ago = Math.max(1, Math.floor(-ms / DAY));
    return t("contracts.window.endedAgo", { d: ago });
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  if (d >= 7) return t("contracts.window.days", { d });
  if (d >= 1) return h > 0 ? t("contracts.window.daysHours", { d, h }) : t("contracts.window.days", { d });
  return t("contracts.window.hours", { h: Math.max(1, h) });
}

export function WindowText({ row }: { row: ContractStandingRow }) {
  const t = useCopy();
  const w = row.window;
  if (w?.open) {
    return (
      <span className="font-mono text-12-5 font-semibold" style={{ color: LEGEND.you.fg }} title={t("contracts.window.adaptBefore", { v: w.version, when: formatStamp(w.dueAt) })} data-testid="window-left">
        {windowLeft(w.dueAt, t)}
      </span>
    );
  }
  if (row.direction === "provided") {
    return (
      <span className="text-12-5 text-muted" title={t("contracts.window.noticeTitle")}>
        {row.noticeDays === null ? t("contracts.window.noNotice") : t("contracts.window.notice", { d: row.noticeDays })}
      </span>
    );
  }
  return <span className="text-12-5 text-muted">{row.state === "behind" ? t("contracts.window.behind", { v: row.current?.version ?? "" }).trim() : t("contracts.window.onLatest")}</span>;
}

const BANNER: Record<ContractAttentionGroup, BannerTone> = { needs_you: "you", waiting: "blocked", steady: "calm" };

function bannerHead(row: ContractStandingRow, who: string, t: Copy): string {
  if (row.attentionGroup === "needs_you") return t("contracts.banner.you");
  if (row.attentionGroup === "steady") return t("contracts.banner.steady");
  return t("contracts.banner.waitingOn", { who });
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
  const t = useCopy();
  const language = useInterfaceLanguage();
  const w = saidView(row.waitingOn, language);
  const link = row.direction === "provided" && w.ref?.startsWith("REQ-") ? refLink(slug, w.ref) : row.direction === "consumed" ? refLink(slug, w.ref) : null;
  return (
    <WaitBanner
      tone={BANNER[row.attentionGroup]}
      head={bannerHead(row, w.who, t)}
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

function contractActionOf(row: ContractStandingRow, t: Copy): { label: string; kind: "feedback" | "requirement" | "versions" } | null {
  if (row.attentionGroup !== "needs_you" || !row.waitingOn.ref) return null;
  const ref = row.waitingOn.ref;
  if (row.direction === "consumed") return { label: t("contracts.action.open", { ref }), kind: "feedback" };
  if (ref.startsWith("REQ-")) return { label: t("contracts.action.reply", { ref }), kind: "requirement" };
  return { label: t("contracts.action.decide", { ref }), kind: "versions" };
}

export function ContractAction({ row, slug, onVersions }: { row: ContractStandingRow; slug: string; onVersions: () => void }) {
  const router = useRouter();
  const t = useCopy();
  const act = contractActionOf(row, t);
  const ref = row.waitingOn.ref;
  if (!act || !ref) return null;
  const go = () => {
    if (act.kind === "feedback") router.push(feedbackHref(slug, ref));
    else if (act.kind === "requirement") router.push(requirementHref(slug, ref));
    else onVersions();
  };
  return (
    <Button type="button" variant="primary" size="sm" onClick={go} data-testid="contract-action">
      {act.label}
    </Button>
  );
}

export function AdoptionStrip({ consumers, latest }: { consumers: ContractConsumerView[]; latest: string | null }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (consumers.length === 0) return <span className="text-12-5 text-subtle">{t("contracts.adoption.none")}</span>;
  const on = consumers.filter((c) => c.adoption === "current").length;
  return (
    <span className="inline-flex items-center gap-2" data-testid="adoption-strip">
      <MarkStrip
        marks={consumers.map((c) => ({
          key: c.project.id,
          label: `${t("contracts.adoption.on", { project: c.project.slug, v: c.builtAgainst })} · ${statusReading("contractAdoption", c.adoption, language).label}${latest ? ` · ${t("contracts.adoption.latest", { v: latest })}` : ""}`,
          tone: statusReading("contractAdoption", c.adoption, language).tone,
        }))}
      />
      <span className="text-12-5 text-muted">
        {t("contracts.adoption.count", { on, of: consumers.length })}
      </span>
    </span>
  );
}

export function versionLine(row: ContractStandingRow, t: Copy): string {
  const cur = row.current?.version;
  if (row.direction === "consumed") {
    const ours = row.ours ? t("contracts.version.weUse", { v: row.ours }) : t("contracts.version.notPinned");
    return cur && cur !== row.ours ? `${ours} · ${t("contracts.version.current", { v: cur })}` : ours;
  }
  const pending = row.pending ? ` → ${t("contracts.version.proposed", { v: row.pending.version })}` : "";
  return cur ? `${cur}${pending}` : row.pending ? t("contracts.version.proposed", { v: row.pending.version }) : t("contracts.version.none");
}
