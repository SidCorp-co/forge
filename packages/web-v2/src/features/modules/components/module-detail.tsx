"use client";

// A module's full page: one main column in three views (Overview, Code, Landings) beside a sticky rail of
// its relations and properties. Whom it waits on is the banner's alone; each other fact is stated once,
// in the rail or in a view. Everything derived (attention, counts, landings, couplings) is core's read model.

import Link from "next/link";
import {
  CoverageBar,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  FactsRail,
  Markdown,
  NotAvailable,
  useUrlTab,
  ViewHeading,
} from "@/design";
import { issueHref } from "@/lib/routes/issues";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { moduleHref } from "../../../lib/routes/modules";
import type { ModuleCoupling, ModuleDetail, ModuleLanding } from "../types";
import { ActivityBars, AttentionBadge, ModuleBanner, openSegments } from "./module-bits";
import { ModuleFacts } from "./module-facts";

const MODULE_TABS = ["overview", "code", "landings"] as const;
type ModuleTab = (typeof MODULE_TABS)[number];

export const useModuleTab = () => useUrlTab(MODULE_TABS);

function Purpose({ d }: { d: ModuleDetail }) {
  const p = d.purpose;
  return (
    <section data-testid="module-purpose">
      <ViewHeading right={p.available ? <span className="text-12 text-subtle">From {p.value.entrySlug}</span> : undefined}>Purpose</ViewHeading>
      {p.available ? (
        <>
          <p className="max-w-[80ch] text-15 leading-relaxed text-fg">{p.value.summary}</p>
          {p.value.body.trim() !== p.value.summary ? (
            <details className="mt-2 max-w-[80ch]">
              <summary className="cursor-pointer select-none text-13 font-medium text-muted hover:text-fg">Read the whole entry</summary>
              <div className="mt-2">
                <Markdown>{p.value.body}</Markdown>
              </div>
              {p.value.bodyTruncated ? <p className="mt-1 text-12 text-subtle">The entry is longer than this view shows.</p> : null}
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-14">
          <NotAvailable reason={p.reason} showReason />
        </p>
      )}
    </section>
  );
}

function Overview({ d }: { d: ModuleDetail }) {
  const s = d.standing;
  const first = d.activity.days[0]?.date;
  const last = d.activity.days.at(-1)?.date;
  return (
    <div className="grid gap-8" data-testid="view-overview">
      <section>
        <ViewHeading right={<span className="text-12 text-subtle">Open {s.open}</span>}>Open issues by state</ViewHeading>
        {s.open === 0 ? <p className="text-13 text-subtle">Nothing is open in this module.</p> : <CoverageBar segments={openSegments(s)} />}
      </section>
      <section>
        <ViewHeading right={<span className="text-12 text-subtle">{d.activity.total} events · last {d.activity.days.length} days</span>}>Activity</ViewHeading>
        <ActivityBars days={d.activity.days} height={44} barWidth={18} />
        <div className="mt-1 flex max-w-[330px] justify-between font-mono text-11 text-subtle">
          <span>{first}</span>
          <span>{last}</span>
        </div>
      </section>
      <Purpose d={d} />
    </div>
  );
}

function CouplingRow({ c, slug }: { c: ModuleCoupling; slug: string }) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line-subtle py-2 text-13" data-testid="coupling-row">
      <Link href={moduleHref(slug, c.module.slug)} className="font-mono text-12-5 font-semibold text-link hover:underline">
        {c.module.path}
      </Link>
      <span className="text-muted">{c.module.name}</span>
      <span className="text-12 text-subtle" title="Issues that carry both modules">
        Shared by {c.issueCount} issues
      </span>
      {c.recentIssueKeys.map((k) => (
        <Link key={k} href={issueHref(slug, k)} className="font-mono text-11-5 text-link hover:underline">
          {k}
        </Link>
      ))}
    </li>
  );
}

function Code({ d, slug }: { d: ModuleDetail; slug: string }) {
  const k = d.keyPaths;
  const c = d.couplings;
  return (
    <div className="grid gap-8" data-testid="view-code">
      <section>
        <ViewHeading right={k.available ? <span className="text-12 text-subtle">Cited in the knowledge entry</span> : undefined}>Key paths</ViewHeading>
        {k.available ? (
          <ul className="grid gap-1 border-t border-line-subtle pt-2 font-mono text-13" data-testid="key-paths">
            {k.value.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-14">
            <NotAvailable reason={k.reason} showReason />
          </p>
        )}
      </section>
      <section>
        <ViewHeading>Couplings</ViewHeading>
        {c.length === 0 ? (
          <p className="text-13 text-subtle">The issue stream shows no coupling.</p>
        ) : (
          <div>
            <h3 className="mb-1 text-12-5 font-medium text-muted" title="Modules attributed to the same issues">
              Seen in the issue stream
            </h3>
            <ul className="border-t border-line-subtle">
              {c.map((x) => (
                <CouplingRow key={x.module.id} c={x} slug={slug} />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

const LANDING_COLS = "grid grid-cols-[96px_minmax(0,1fr)_110px_96px_minmax(0,150px)] gap-x-3.5 px-3 max-md:grid-cols-[84px_minmax(0,1fr)_88px]";

function LandingRow({ l, slug, here }: { l: ModuleLanding; slug: string; here: string }) {
  const where = [l.commitSha ? l.commitSha.slice(0, 7) : null, l.target ? `on ${l.target}` : null, l.landing].filter(Boolean).join(" · ");
  return (
    <li className={`${LANDING_COLS} items-baseline border-b border-line-subtle py-2.5 text-13`} data-testid="landing-row">
      <Link href={issueHref(slug, l.issueKey)} className="font-mono text-12 font-semibold text-link hover:underline">
        {l.issueKey}
      </Link>
      <span className="min-w-0 truncate" title={l.title}>
        {l.title}
      </span>
      <span className="text-12 text-muted" title={`${formatStamp(l.landedAt)}${where ? ` · ${where}` : ""}`}>
        {formatAge(l.landedAt)} ago
      </span>
      <span className="font-mono text-12 max-md:hidden">{l.release ?? <span className="font-sans text-subtle" title="Not part of a release yet">Not yet</span>}</span>
      <span className="truncate font-mono text-12 text-subtle max-md:hidden" title={l.modulePath}>
        {l.modulePath === here ? "" : l.modulePath}
      </span>
    </li>
  );
}

function Landings({ d, slug }: { d: ModuleDetail; slug: string }) {
  const l = d.landings;
  return (
    <div data-testid="view-landings">
      <ViewHeading right={<span className="text-12 text-subtle">Merged into the base branch</span>}>Recent landings and releases</ViewHeading>
      {l.recent.length === 0 ? (
        <p className="text-13 text-subtle">Nothing has landed in this module yet.</p>
      ) : (
        <>
          <div className={`${LANDING_COLS} h-8 items-center border-y border-line-subtle bg-sunken text-11-5 font-semibold text-subtle`} aria-hidden>
            <span>Issue</span>
            <span>Title</span>
            <span>Landed</span>
            <span className="max-md:hidden">Release</span>
            <span className="max-md:hidden">Module</span>
          </div>
          <ul>
            {l.recent.map((x) => (
              <LandingRow key={x.issueKey} l={x} slug={slug} here={d.module.path} />
            ))}
          </ul>
          {l.total > l.recent.length ? <p className="mt-2 text-12 text-subtle">The latest {l.recent.length} of {l.total} landings.</p> : null}
        </>
      )}
    </div>
  );
}

export function ModulePage({ d, slug, tab, onTab }: { d: ModuleDetail; slug: string; tab: ModuleTab; onTab: (t: ModuleTab) => void }) {
  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "code" as const, label: "Code" },
    { value: "landings" as const, label: "Landings", count: d.landings.total },
  ];
  const s = d.standing;
  return (
    <DetailLayout
      testId="module-detail"
      dataKey={d.module.slug}
      rail={
        <FactsRail testId="relations-rail">
          <ModuleFacts d={d} slug={slug} />
        </FactsRail>
      }
    >
      <DetailMobileTitle itemKey={d.module.path} title={d.module.name} badge={<AttentionBadge group={s.attentionGroup} />} />
      {s.attentionGroup !== "quiet" ? <ModuleBanner standing={s} slug={slug} className="px-8 py-2.5 max-md:px-4" /> : null}
      <DetailTabs tabs={tabs} value={tab} onChange={onTab} testId="module-tabs" />
      <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Overview"}>
        {tab === "overview" ? <Overview d={d} /> : null}
        {tab === "code" ? <Code d={d} slug={slug} /> : null}
        {tab === "landings" ? <Landings d={d} slug={slug} /> : null}
      </DetailPane>
    </DetailLayout>
  );
}
