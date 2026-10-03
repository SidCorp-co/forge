"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, enumLabel, StatusBadge, Tooltip } from "@/design";
import { readingOf } from "@/lib/api/refusals";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  type Bus,
  type BusBuilder,
  type BusLink,
  type BusRow,
  builderProgress,
  callSiteAt,
  impactLine,
  impactOf,
  STATE_MEANING,
  shortSha,
  triggerRef,
  type StepStatus,
} from "../bus";
import { useBuilderRun, useLink } from "../hooks";
import { ecosystemRoutes } from "../routes";
import { ProjectMark, type Selection } from "./bus-diagram";
import { Loading, UnreadNotice } from "./notices";

function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 content-start gap-1.5 border-line-subtle px-4 pb-4 pt-1 sm:border-r sm:pl-7 sm:pr-[22px] sm:last:border-r-0">
      <h3 className="flex items-center gap-2 pt-2 text-11 font-semibold uppercase tracking-[0.07em] text-subtle">
        {title}
        {aside ? <span className="ml-auto normal-case tracking-normal">{aside}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Head({ children }: { children: ReactNode }) {
  return <div className="col-span-full flex min-w-0 flex-wrap items-center gap-2 px-4 pb-1 pt-3 sm:px-7">{children}</div>;
}

const Caption = ({ children }: { children: ReactNode }) => <p className="fg-caption break-words">{children}</p>;

const STEP_ICON: Record<StepStatus, string> = {
  succeeded: "✓",
  skipped: "–",
  running: "•",
  failed: "✕",
  pending: "",
  superseded: "↷",
};

const STEP_STYLE: Record<StepStatus, { background: string; color: string }> = {
  succeeded: { background: "var(--green-50)", color: "var(--green-600)" },
  skipped: { background: "var(--bg-sunken)", color: "var(--fg-subtle)" },
  running: { background: "var(--accent)", color: "var(--fg-on-accent)" },
  failed: { background: "var(--red-50)", color: "var(--red-600)" },
  pending: { background: "var(--bg-sunken)", color: "var(--fg-subtle)" },
  superseded: { background: "var(--bg-sunken)", color: "var(--fg-subtle)" },
};

function Steps({ builder }: { builder: BusBuilder }) {
  return (
    <ol className="grid gap-1.5">
      {builder.steps.map((s) => {
        const row = (
          <span className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2 text-13">
            <span
              className={`grid h-[18px] w-[18px] place-items-center rounded-full text-10 font-bold ${s.status === "running" ? "forge-pulse" : ""}`}
              style={STEP_STYLE[s.status]}
            >
              {STEP_ICON[s.status]}
            </span>
            <span className={s.status === "running" ? "font-semibold" : s.status === "pending" ? "text-subtle" : ""}>
              {s.name}
            </span>
          </span>
        );
        return (
          <li key={s.name}>
            {s.detail ? (
              <Tooltip label={`${s.status} · ${s.detail}`} multiline>
                {row}
              </Tooltip>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ol>
  );
}

function BuilderSummary({ builder }: { builder: BusBuilder }) {
  const prog = builderProgress(builder);
  return (
    <>
      <Steps builder={builder} />
      <Tooltip label={`Started ${new Date(builder.createdAt).toLocaleString()} · updated ${new Date(builder.updatedAt).toLocaleString()}`}>
        <span className="fg-caption">
          {prog.done}/{prog.total} steps · on {enumLabel("trigger", builder.trigger.kind).toLowerCase()} at <span className="font-mono">{triggerRef(builder.trigger)}</span>
          {builder.stepsStale ? " · steps stale for this source: supersede the run" : ""}
        </span>
      </Tooltip>
    </>
  );
}

const PageLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-12 font-semibold text-[var(--accent-text)] hover:underline">
    {children}
  </Link>
);

function ProjectDetail({
  bus,
  id,
  mine,
  onSelect,
}: {
  bus: Bus;
  id: string;
  mine: ReadonlyMap<string, string>;
  onSelect: (s: Selection) => void;
}) {
  const p = bus.projects.find((x) => x.id === id);
  if (!p) return <Caption>That project is no longer on this ecosystem&apos;s bus.</Caption>;
  const out = bus.links.filter((l) => l.consumer === p.id);
  const provides = bus.contracts.filter((c) => c.provider === p.id);
  const into = bus.links.filter((l) => l.contract.provider === p.id);
  const names = new Map(bus.projects.map((x) => [x.id, x.slug]));
  return (
    <>
      <Head>
        <ProjectMark slug={p.slug} size={22} />
        <h2 className="text-15 font-semibold">{p.slug}</h2>
        <Tooltip label={`${p.name} · a member of ${bus.ecosystem.name}`}>
          <span className="fg-caption">{p.name}</span>
        </Tooltip>
        {mine.has(p.id) ? (
          <span className="ml-auto flex gap-3">
            <PageLink href={ecosystemRoutes.contracts(p.slug)}>Contracts</PageLink>
            <PageLink href={ecosystemRoutes.apiPage(p.slug)}>Project API</PageLink>
          </span>
        ) : null}
      </Head>
      <Group title="Ecosystem builder">
        {p.builder ? (
          <button type="button" className="grid gap-1.5 text-left" onClick={() => onSelect({ kind: "builder", id: p.id })}>
            <BuilderSummary builder={p.builder} />
          </button>
        ) : (
          <Caption>No builder run is recorded for {p.slug} in this ecosystem.</Caption>
        )}
      </Group>
      <Group title="Links out" aside={out.length || undefined}>
        {out.length === 0 ? (
          <Caption>
            {p.slug}&apos;s master has not mapped its links{p.builder ? "; its builder has written none yet" : ""}.
          </Caption>
        ) : (
          out.map((l) => (
            <Tooltip key={l.id} label={`${l.module} · ${STATE_MEANING[l.state]}`} multiline>
              <button type="button" onClick={() => onSelect({ kind: "link", id: l.id })} className="flex min-w-0 items-center gap-2 text-left text-13">
                <span className="truncate font-mono">→ {l.contract.slug}</span>
                <StatusBadge family="link" value={l.state} />
              </button>
            </Tooltip>
          ))
        )}
      </Group>
      <Group title="Provides" aside={provides.length || undefined}>
        {provides.length === 0 ? (
          <Caption>{p.slug} publishes no contract to this ecosystem.</Caption>
        ) : (
          provides.map((c) => (
            <Tooltip key={c.slug} label={`${c.title} · ${c.type} · ${c.lifecycle}`} multiline>
              <button
                type="button"
                onClick={() => onSelect({ kind: "contract", key: `${c.provider}/${c.slug}` })}
                className="flex min-w-0 items-center gap-2 text-left text-13"
              >
                <span className="truncate font-mono">{c.slug}</span>
                <span className="fg-caption font-mono">{c.currentVersion ?? "no version"}</span>
              </button>
            </Tooltip>
          ))
        )}
        {into.length > 0 ? (
          <Caption>
            Used by {[...new Set(into.map((l) => names.get(l.consumer) ?? "a member"))].join(", ")}
          </Caption>
        ) : null}
      </Group>
    </>
  );
}

function LinkDetail({ bus, id }: { bus: Bus; id: string }) {
  const l = bus.links.find((x) => x.id === id);
  const reading = readingOf(useLink(l?.consumer, l?.id));
  if (!l) return <Caption>That link is no longer on this ecosystem&apos;s bus.</Caption>;
  const names = new Map(bus.projects.map((x) => [x.id, x.slug]));
  const consumer = names.get(l.consumer) ?? "a member";
  return (
    <>
      <Head>
        <ProjectMark slug={consumer} size={22} />
        <h2 className="text-15 font-semibold">
          {consumer} <span className="text-subtle">→</span> <span className="font-mono">{l.contract.slug}</span>
        </h2>
        <Tooltip label={STATE_MEANING[l.state]}>
          <StatusBadge family="link" value={l.state} />
        </Tooltip>
        <Tooltip label={`Only ${consumer}'s master writes this link · updated ${new Date(l.updatedAt).toLocaleString()}`}>
          <span className="fg-caption">
            {l.module} · on {l.pinnedVersion} · {formatRelativeTime(l.updatedAt)}
          </span>
        </Tooltip>
      </Head>
      {reading.kind === "loading" ? (
        <div className="col-span-full px-4">
          <Loading what="this link's guide" />
        </div>
      ) : null}
      {reading.kind === "unread" ? (
        <div className="col-span-full px-4 pb-3">
          <UnreadNotice what={`${consumer}'s guide for this link`} refusals={reading.refusals} />
        </div>
      ) : null}
      {reading.kind === "read" ? <Guide record={reading.value} /> : null}
    </>
  );
}

function Guide({ record }: { record: NonNullable<ReturnType<typeof useLink>["data"]> }) {
  const d = record.document;
  return (
    <>
      <Group title="Call sites" aside={d.callSites.length || undefined}>
        {d.callSites.length === 0 ? (
          <Caption>No call site is recorded.</Caption>
        ) : (
          d.callSites.map((s) => (
            <div key={`${callSiteAt(s)}:${s.operation}`} className="flex min-w-0 justify-between gap-2 font-mono text-11-5">
              <span className="truncate" style={{ color: "var(--cobalt-700)" }}>
                {callSiteAt(s)}
              </span>
              <span className="truncate">{s.operation}</span>
            </div>
          ))
        )}
      </Group>
      <Group title="Uses">
        {d.fieldsUsed.length === 0 ? (
          <Caption>No field is recorded.</Caption>
        ) : (
          <div className="flex flex-wrap gap-1">
            {d.fieldsUsed.map((f) => (
              <span key={f} className="rounded-pill bg-[var(--bg-sunken)] px-2 font-mono text-11">
                {f}
              </span>
            ))}
          </div>
        )}
        {d.outsideContract.length > 0 ? (
          <>
            <h4 className="pt-2 text-11 font-semibold uppercase tracking-[0.07em]" style={{ color: "var(--amberw-600)" }}>
              Outside the contract
            </h4>
            {d.outsideContract.map((o) => (
              <Tooltip key={o} label="The contract does not publish this, so a provider change here breaks the consumer without notice" multiline>
                <span className="font-mono text-11-5" style={{ color: "var(--amberw-600)" }}>
                  {o}
                </span>
              </Tooltip>
            ))}
          </>
        ) : null}
      </Group>
      <Group title="Notes">
        {d.notes.length === 0 ? (
          <Caption>The guide holds no notes.</Caption>
        ) : (
          d.notes.map((n) => (
            <p key={n} className="break-words text-13">
              {n}
            </p>
          ))
        )}
      </Group>
      <Group title="Written by">
        <Tooltip label={`Run ${d.writtenBy.runId ?? "not recorded"} · session ${d.writtenBy.sessionId ?? "not recorded"} · revision ${record.revision}`} multiline>
          <span className="text-13">
            {d.writtenBy.runId ? "a master run" : "its master"} at <span className="font-mono">{shortSha(d.writtenBy.sha)}</span>
          </span>
        </Tooltip>
        <span className="text-13">
          refreshed at <span className="font-mono">{shortSha(d.refreshedAtSha)}</span>
        </span>
        <Tooltip label="The provider's current version of the contract, as it recorded it">
          <span className="fg-caption">
            pins {d.pinnedVersion}
            {record.currentVersion && record.currentVersion !== d.pinnedVersion ? `, current ${record.currentVersion}` : ""}
          </span>
        </Tooltip>
      </Group>
    </>
  );
}

function contractPage(row: BusRow, mine: ReadonlyMap<string, string>): string | null {
  const own = mine.get(row.ref.provider);
  if (own) return ecosystemRoutes.contract(own, row.ref.slug);
  const reader = row.links.map((l) => mine.get(l.consumer)).find(Boolean);
  return reader ? ecosystemRoutes.contract(reader, row.ref.slug, row.ref.provider) : null;
}

function ContractDetail({
  bus,
  rows,
  k,
  mine,
  onSelect,
}: {
  bus: Bus;
  rows: BusRow[];
  k: string;
  mine: ReadonlyMap<string, string>;
  onSelect: (s: Selection) => void;
}) {
  const row = rows.find((r) => r.key === k);
  if (!row) return <Caption>That contract is no longer on this ecosystem&apos;s bus.</Caption>;
  const names = new Map(bus.projects.map((x) => [x.id, x.slug]));
  const provider = names.get(row.ref.provider) ?? "its provider";
  const c = row.contract;
  const breaks = row.links.filter((l) => impactOf(l) === "breaks");
  const unchecked = row.links.filter((l) => impactOf(l) === "unchecked");
  return (
    <>
      <Head>
        <ProjectMark slug={provider} size={22} />
        <h2 className="font-mono text-15 font-semibold">{row.ref.slug}</h2>
        {c ? (
          <Tooltip label={`${c.title} · ${c.type}`}>
            <span className="fg-caption">
              by {provider} · {c.currentVersion ?? "no version recorded"} · {enumLabel("lifecycle", c.lifecycle)}
            </span>
          </Tooltip>
        ) : (
          <Badge tone="amber">not published here</Badge>
        )}
        {contractPage(row, mine) ? (
          <span className="ml-auto">
            <PageLink href={contractPage(row, mine) as string}>Versions and measurements</PageLink>
          </span>
        ) : null}
      </Head>
      <Group title="Used by" aside={row.links.length || undefined}>
        {row.links.length === 0 ? (
          <Caption>No member&apos;s master has mapped a link to {row.ref.slug}.</Caption>
        ) : (
          row.links.map((l: BusLink) => {
            const v = impactOf(l);
            return (
              <Tooltip key={l.id} label={`${l.module} · ${STATE_MEANING[l.state]} · ${impactLine(l)}`} multiline>
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "link", id: l.id })}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-left text-13"
                >
                  <b className="truncate">{names.get(l.consumer) ?? "a member"}</b>
                  <span className="fg-caption font-mono">on {l.pinnedVersion}</span>
                  <StatusBadge family="check" value={v} />
                </button>
              </Tooltip>
            );
          })
        )}
      </Group>
      <Group title="Impact">
        <span className="text-13">
          {breaks.length === 0 && unchecked.length === 0
            ? row.links.length === 0
              ? "Nothing reads it, so no change to it reaches a member."
              : `Every mapped consumer passes against ${c?.currentVersion ?? "the latest version"}.`
            : [
                breaks.length ? `${breaks.length} breaking` : "",
                unchecked.length ? `${unchecked.length} unchecked` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        {breaks.map((l) => (
          <Caption key={l.id}>
            {names.get(l.consumer) ?? "a member"}: {impactLine(l)}
          </Caption>
        ))}
      </Group>
    </>
  );
}

function BuilderDetail({ bus, id }: { bus: Bus; id: string }) {
  const p = bus.projects.find((x) => x.id === id);
  const reading = readingOf(useBuilderRun(p?.id, p?.builder?.id));
  if (!p?.builder) return <Caption>No builder run is recorded for that project in this ecosystem.</Caption>;
  return (
    <>
      <Head>
        <ProjectMark slug={p.slug} size={22} />
        <h2 className="text-15 font-semibold">{p.slug} ecosystem builder</h2>
        <Tooltip label={`Run ${p.builder.id}`}>
          <span className="fg-caption">
            on {enumLabel("trigger", p.builder.trigger.kind).toLowerCase()} at <span className="font-mono">{triggerRef(p.builder.trigger)}</span> ·{" "}
            {formatRelativeTime(p.builder.updatedAt)}
          </span>
        </Tooltip>
      </Head>
      <Group title="Steps">
        <Steps builder={p.builder} />
      </Group>
      <Group title="Found" aside={p.builder.findings || undefined}>
        {reading.kind === "loading" ? <Loading what="what the builder found" /> : null}
        {reading.kind === "unread" ? (
          <UnreadNotice what={`${p.slug}'s builder findings`} refusals={reading.refusals} />
        ) : null}
        {reading.kind === "read" ? (
          reading.value.document.findings.length === 0 ? (
            <Caption>The builder has found no outbound call yet.</Caption>
          ) : (
            reading.value.document.findings.map((f) => (
              <Tooltip
                key={`${callSiteAt(f.site)}:${f.site.operation}`}
                label={`${callSiteAt(f.site)} · ${f.site.operation}`}
                multiline
              >
                <span className="flex min-w-0 justify-between gap-2 font-mono text-11-5">
                  <span className="truncate" style={{ color: "var(--cobalt-700)" }}>
                    {f.classification === "matched"
                      ? f.contract.slug
                      : f.classification === "outside_ecosystem"
                        ? f.host
                        : f.site.operation}
                  </span>
                  <StatusBadge family="finding" value={f.classification} />
                </span>
              </Tooltip>
            ))
          )
        ) : null}
      </Group>
      <Group title="Links written" aside={p.builder.links || undefined}>
        <Caption>
          {p.builder.links === 0
            ? "None yet."
            : `${p.builder.links} link${p.builder.links === 1 ? "" : "s"}, shown on the bus under ${p.slug}.`}
        </Caption>
      </Group>
    </>
  );
}

export function BusDetail({
  bus,
  rows,
  sel,
  mine,
  onSelect,
}: {
  bus: Bus;
  rows: BusRow[];
  sel: Selection;
  /** The reader's own projects in this ecosystem, id to slug: the ones whose pages it can open. */
  mine: ReadonlyMap<string, string>;
  onSelect: (s: Selection) => void;
}) {
  return (
    <section
      aria-label="Detail"
      className="grid min-h-0 min-w-0 flex-1 content-start border-t border-line-subtle bg-app sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]"
    >
      {sel.kind === "project" ? <ProjectDetail bus={bus} id={sel.id} mine={mine} onSelect={onSelect} /> : null}
      {sel.kind === "link" ? <LinkDetail bus={bus} id={sel.id} /> : null}
      {sel.kind === "contract" ? <ContractDetail bus={bus} rows={rows} k={sel.key} mine={mine} onSelect={onSelect} /> : null}
      {sel.kind === "builder" ? <BuilderDetail bus={bus} id={sel.id} /> : null}
    </section>
  );
}
