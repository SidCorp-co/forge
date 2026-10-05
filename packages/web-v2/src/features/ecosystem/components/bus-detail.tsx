"use client";

import { Badge, enumLabel, ProjectMark, StatusBadge, Tooltip } from "@/design";
import { contractHref, contractsHref } from "@/features/contracts/routes";
import {
  type Bus,
  type BusLink,
  type BusProject,
  type BusRow,
  impactLine,
  impactOf,
  projectMarkProps,
  STATE_MEANING,
  slugsOf,
} from "../bus";
import { ecosystemRoutes } from "../routes";
import { BuilderDetail } from "./bus-builder-detail";
import { BuilderSummary, Caption, Group, Head, PageLink } from "./bus-detail-kit";
import type { Selection } from "./bus-diagram";
import { LinkDetail } from "./bus-link-detail";

type Names = ReadonlyMap<string, string>;

function ProjectHead({ p, bus, mine }: { p: BusProject; bus: Bus; mine: Names }) {
  return (
    <Head>
      <ProjectMark {...projectMarkProps(p.slug)} size={22} />
      <h2 className="text-15 font-semibold">{p.slug}</h2>
      <Tooltip label={`${p.name} · a member of ${bus.ecosystem.name}`}>
        <span className="fg-caption">{p.name}</span>
      </Tooltip>
      {mine.has(p.id) ? (
        <span className="ml-auto flex gap-3">
          <PageLink href={contractsHref(p.slug)}>Contracts</PageLink>
          <PageLink href={ecosystemRoutes.apiPage(p.slug)}>Project API</PageLink>
        </span>
      ) : null}
    </Head>
  );
}

function ProvidesGroup({ bus, p, onSelect }: { bus: Bus; p: BusProject; onSelect: (s: Selection) => void }) {
  const provides = bus.contracts.filter((c) => c.provider === p.id);
  const into = bus.links.filter((l) => l.contract.provider === p.id);
  const names = slugsOf(bus);
  return (
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
  );
}

function ProjectDetail({ bus, id, mine, onSelect }: { bus: Bus; id: string; mine: Names; onSelect: (s: Selection) => void }) {
  const p = bus.projects.find((x) => x.id === id);
  if (!p) return <Caption>That project is no longer on this ecosystem&apos;s bus.</Caption>;
  const out = bus.links.filter((l) => l.consumer === p.id);
  return (
    <>
      <ProjectHead p={p} bus={bus} mine={mine} />
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
      <ProvidesGroup bus={bus} p={p} onSelect={onSelect} />
    </>
  );
}

function contractPage(row: BusRow, mine: Names, names: Names): string | null {
  const provider = names.get(row.ref.provider);
  if (!provider) return null;
  const reader = mine.get(row.ref.provider) ?? row.links.map((l) => mine.get(l.consumer)).find(Boolean);
  return reader ? contractHref(reader, `${provider}/${row.ref.slug}`) : null;
}

function ImpactGroup({ row, names }: { row: BusRow; names: Names }) {
  const breaks = row.links.filter((l) => impactOf(l) === "breaks");
  const unchecked = row.links.filter((l) => impactOf(l) === "unchecked");
  return (
    <Group title="Impact">
      <span className="text-13">
        {breaks.length === 0 && unchecked.length === 0
          ? row.links.length === 0
            ? "Nothing reads it, so no change to it reaches a member."
            : `Every mapped consumer passes against ${row.contract?.currentVersion ?? "the latest version"}.`
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
  );
}

function ContractDetail({ bus, rows, k, mine, onSelect }: { bus: Bus; rows: BusRow[]; k: string; mine: Names; onSelect: (s: Selection) => void }) {
  const row = rows.find((r) => r.key === k);
  if (!row) return <Caption>That contract is no longer on this ecosystem&apos;s bus.</Caption>;
  const names = slugsOf(bus);
  const provider = names.get(row.ref.provider) ?? "its provider";
  const c = row.contract;
  const page = contractPage(row, mine, names);
  return (
    <>
      <Head>
        <ProjectMark {...projectMarkProps(provider)} size={22} />
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
        {page ? (
          <span className="ml-auto">
            <PageLink href={page}>Versions and adoption</PageLink>
          </span>
        ) : null}
      </Head>
      <Group title="Used by" aside={row.links.length || undefined}>
        {row.links.length === 0 ? (
          <Caption>No member&apos;s master has mapped a link to {row.ref.slug}.</Caption>
        ) : (
          row.links.map((l: BusLink) => (
            <Tooltip key={l.id} label={`${l.module} · ${STATE_MEANING[l.state]} · ${impactLine(l)}`} multiline>
              <button
                type="button"
                onClick={() => onSelect({ kind: "link", id: l.id })}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-left text-13"
              >
                <b className="truncate">{names.get(l.consumer) ?? "a member"}</b>
                <span className="fg-caption font-mono">on {l.pinnedVersion}</span>
                <StatusBadge family="check" value={impactOf(l)} />
              </button>
            </Tooltip>
          ))
        )}
      </Group>
      <ImpactGroup row={row} names={names} />
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
  mine: Names;
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
