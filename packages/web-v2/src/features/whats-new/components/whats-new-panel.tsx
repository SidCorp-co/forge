"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FilterChip, SlideOver } from "@/design";
import { type Copy, copyLocale, productCopy } from "@/lib/i18n/product-copy";
import { tourHref } from "@/features/tours/links";
import { tourById } from "@/features/tours/registry";
import { releaseHref } from "@/lib/routes/releases";
import { cn } from "@/lib/utils/cn";
import { entriesByKey, sectionsOf, type WhatsNewSection } from "../group";
import type { WhatsNewDigestView, WhatsNewEntry, WhatsNewFeed, WhatsNewKind } from "../types";

const KINDS: WhatsNewKind[] = ["new", "improved", "fixed"];
const WINDOW_DAYS = 30;

function shortDate(at: string | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(new Date(at));
}

function EntryRow({ entry, t, slug }: { entry: WhatsNewEntry; t: Copy; slug: string | null }) {
  const tour = tourById(entry.tour?.id);
  const tourLink = tour ? tourHref(tour, slug, { version: entry.version }) : null;
  return (
    <li className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-b border-line py-2.5" data-testid="whats-new-entry">
      <span
        className={cn(
          "pt-0.5 text-11 uppercase tracking-[0.05em]",
          entry.kind === "new" ? "font-semibold text-accent-text" : "text-subtle",
        )}
      >
        {t(`whatsNew.kind.${entry.kind}`)}
      </span>
      <span className="text-13-5 text-fg">{entry.text}</span>
      <span className="col-start-2 flex items-center gap-2.5 text-12 text-subtle">
        {tour && tourLink && (
          <Link href={tourLink} className="text-13 font-semibold text-accent-text hover:underline" data-testid="whats-new-tour-link">
            {t("tours.showMe", { count: tour.steps.length })}
          </Link>
        )}
        {slug ? (
          <Link href={releaseHref(slug, entry.version)} className="font-mono hover:text-fg">
            {entry.version}
          </Link>
        ) : (
          <span className="font-mono">{entry.version}</span>
        )}
      </span>
    </li>
  );
}

function FixesRow({ entries, t, slug }: { entries: WhatsNewEntry[]; t: Copy; slug: string | null }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <>
      <li className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-2.5 border-b border-line py-2.5">
        <span className="pt-0.5 text-11 uppercase tracking-[0.05em] text-subtle">{t("whatsNew.kind.fixed")}</span>
        <span className="text-13-5 text-fg">
          {t("whatsNew.fixes", { count: entries.length })}{" "}
          <button type="button" onClick={() => setOpen((o) => !o)} className="font-semibold text-accent-text">
            {open ? t("whatsNew.hide") : t("whatsNew.show")}
          </button>
        </span>
      </li>
      {open && entries.map((e) => <EntryRow key={e.key} entry={e} t={t} slug={slug} />)}
    </>
  );
}

function Digest({ digest, t, locale }: { digest: WhatsNewDigestView; t: Copy; locale: string }) {
  const date = shortDate(digest.writtenAt, locale);
  return (
    <div className="mt-2.5 rounded-md bg-sunken px-3 py-2.5 text-13-5 text-fg" data-testid="whats-new-digest">
      <span className="font-semibold">{t("whatsNew.digest.title")}</span> — {digest.body}
      <div className="mt-1 text-12 text-subtle">
        {digest.author.agency === "human" && digest.author.name
          ? t("whatsNew.digest.byPerson", { name: digest.author.name, date })
          : t("whatsNew.digest.byAgent", { date })}
      </div>
    </div>
  );
}

function Section({ section, t, locale, slug, collapseFixes }: { section: WhatsNewSection; t: Copy; locale: string; slug: string | null; collapseFixes: boolean }) {
  const label = t(section.label.key, section.label.date ? { date: shortDate(section.label.date, locale) } : undefined);
  const shown = collapseFixes ? section.entries.filter((e) => e.kind !== "fixed") : section.entries;
  const fixes = collapseFixes ? section.entries.filter((e) => e.kind === "fixed") : [];
  return (
    <section data-testid={`whats-new-section-${section.key}`}>
      <h3 className="mt-4 border-b border-line pb-1.5 text-11-5 font-semibold uppercase tracking-[0.06em] text-subtle">{label}</h3>
      {section.digest && <Digest digest={section.digest} t={t} locale={locale} />}
      <ul>
        {shown.map((e) => (
          <EntryRow key={e.key} entry={e} t={t} slug={slug} />
        ))}
        <FixesRow entries={fixes} t={t} slug={slug} />
      </ul>
    </section>
  );
}

function SinceLine({ feed, t, locale }: { feed: WhatsNewFeed; t: Copy; locale: string }) {
  const lead = feed.seenAt
    ? t("whatsNew.sinceLast", { date: shortDate(feed.seenAt, locale), count: feed.unread })
    : t("whatsNew.sinceWindow", { days: WINDOW_DAYS, count: feed.unread });
  return (
    <p className="pb-1.5 pt-3 text-13 text-muted" data-testid="whats-new-since">
      <span className="font-semibold text-fg">{lead}</span>
      {feed.unread > 0 && (
        <> · {t("whatsNew.breakdown", { new: feed.counts.new, improved: feed.counts.improved, fixed: feed.counts.fixed })}</>
      )}
    </p>
  );
}

function AwaySummary({ feed, t, locale, slug }: { feed: WhatsNewFeed; t: Copy; locale: string; slug: string | null }) {
  const away = feed.away;
  const byKey = useMemo(() => entriesByKey(feed), [feed]);
  if (!away) return null;
  const highlights = away.highlights.flatMap((k) => byKey.get(k) ?? []);
  return (
    <div data-testid="whats-new-away">
      <p className="pb-1.5 pt-3 text-13 font-semibold text-fg">
        {t("whatsNew.away", {
          date: shortDate(away.since, locale),
          screens: away.counts.screens,
          improved: away.counts.improved,
          fixed: away.counts.fixed,
        })}
      </p>
      <h3 className="mt-3 border-b border-line pb-1.5 text-11-5 font-semibold uppercase tracking-[0.06em] text-subtle">
        {t("whatsNew.highlights")}
      </h3>
      <ul>
        {highlights.map((e) => (
          <EntryRow key={e.key} entry={e} t={t} slug={slug} />
        ))}
      </ul>
    </div>
  );
}

export interface WhatsNewPanelProps {
  open: boolean;
  onClose: () => void;
  /** The feed as it stood when the panel opened, so the since-line still counts what was unread. */
  feed: WhatsNewFeed | undefined;
  failure: "unavailable" | "failed" | null;
  now?: Date;
}

/** What's new: Forge's changes since the reader last looked, by day, version as trailing meta. */
export function WhatsNewPanel({ open, onClose, feed, failure, now = new Date() }: WhatsNewPanelProps) {
  const [kind, setKind] = useState<WhatsNewKind | null>(null);
  const [showRest, setShowRest] = useState(false);
  const t = productCopy(feed?.contentLanguage);
  const locale = copyLocale(feed?.contentLanguage);
  const sections = useMemo(() => (feed ? sectionsOf(feed, now, kind) : []), [feed, now, kind]);
  const total = feed ? feed.days.reduce((n, d) => n + d.entries.length, 0) : 0;
  const countOf = (k: WhatsNewKind) => (feed ? feed.days.reduce((n, d) => n + d.entries.filter((e) => e.kind === k).length, 0) : 0);
  const away = feed?.away ?? null;
  const collapsed = away !== null && !showRest && kind === null;

  return (
    <SlideOver open={open} onClose={onClose} title={t("whatsNew.title")} width={440}>
      <div className="-mt-3" data-testid="whats-new-panel">
        {failure && <p className="pt-3 text-13 text-muted">{t(failure === "unavailable" ? "whatsNew.unavailable" : "whatsNew.failed")}</p>}
        {feed && (
          <>
            {away ? <AwaySummary feed={feed} t={t} locale={locale} slug={feed.projectSlug} /> : <SinceLine feed={feed} t={t} locale={locale} />}
            <div className="flex flex-wrap gap-1 pb-1.5 pt-2">
              <FilterChip on={kind === null} onToggle={() => setKind(null)} count={total} testId="whats-new-filter-all">
                {t("whatsNew.filter.all")}
              </FilterChip>
              {KINDS.map((k) => (
                <FilterChip key={k} on={kind === k} onToggle={() => setKind(kind === k ? null : k)} count={countOf(k)} testId={`whats-new-filter-${k}`}>
                  {t(`whatsNew.filter.${k}`)}
                </FilterChip>
              ))}
            </div>
            {collapsed ? (
              <button type="button" onClick={() => setShowRest(true)} className="mt-3 text-13 font-semibold text-accent-text" data-testid="whats-new-show-rest">
                {t("whatsNew.showRest", { count: Math.max(0, total - away.highlights.length) })}
              </button>
            ) : sections.length === 0 ? (
              <p className="pt-4 text-13 text-muted">{t("whatsNew.empty")}</p>
            ) : (
              sections.map((s) => (
                <Section key={s.key} section={s} t={t} locale={locale} slug={feed.projectSlug} collapseFixes={kind !== "fixed"} />
              ))
            )}
          </>
        )}
      </div>
    </SlideOver>
  );
}
