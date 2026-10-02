"use client";

import { Tooltip } from "@/design";
import { cn } from "@/lib/utils/cn";
import {
  type Bus,
  type BusLink,
  type BusProject,
  type BusRow,
  builderActive,
  builderProgress,
  impactLine,
  impactOf,
  initials,
  STATE_MEANING,
  STATE_TONE,
  triggerRef,
  type Tone,
  VERDICT_TONE,
  type Verdict,
} from "../bus";

export type Lens = "live" | "impact";

export type Selection =
  | { kind: "project"; id: string }
  | { kind: "builder"; id: string }
  | { kind: "link"; id: string }
  | { kind: "contract"; key: string };

const ROW_H = 52;
const MARKS = ["var(--cobalt-50)", "var(--green-50)", "var(--flame-50)", "var(--paper-200)"];
const MARK_FG = ["var(--cobalt-700)", "var(--green-600)", "var(--flame-700)", "var(--fg-muted)"];

function markOf(slug: string) {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % MARKS.length;
}

export function ProjectMark({ slug, size = 20 }: { slug: string; size?: number }) {
  const m = markOf(slug);
  return (
    <span
      aria-hidden
      className="grid flex-none place-items-center rounded-[5px] font-bold"
      style={{ width: size, height: size, fontSize: size * 0.42, background: MARKS[m], color: MARK_FG[m] }}
    >
      {initials(slug)}
    </span>
  );
}

const VERDICT_LABEL: Record<Verdict, (l: BusLink) => string> = {
  breaks: () => "breaks",
  passes: () => "passes",
  unchecked: (l) => l.pinnedVersion,
};

// cm:why the line under a member's name is its builder run while one is running or has failed; nothing else core serves says what that project's master is doing, so otherwise the line is left out rather than guessed
function headerLine(p: BusProject) {
  const b = p.builder;
  if (!b) return null;
  const prog = builderProgress(b);
  if (prog.failed) {
    return {
      text: "builder failed",
      tone: "bad" as const,
      tip: `The ecosystem builder failed at ${prog.failed.name}${prog.failed.detail ? `: ${prog.failed.detail}` : ""}`,
      progress: null,
    };
  }
  if (!builderActive(b)) return null;
  return {
    text: `builder ${prog.done}/${prog.total}`,
    tone: "active" as const,
    tip: prog.running
      ? `The ecosystem builder is at ${prog.running.name}${prog.running.detail ? `: ${prog.running.detail}` : ""}`
      : "The ecosystem builder has steps still to run",
    progress: prog.total ? prog.done / prog.total : 0,
  };
}

function headerTip(p: BusProject, reader: boolean, linksOut: number, provides: number) {
  const mapped = linksOut === 0 ? "no link mapped" : `${linksOut} link${linksOut === 1 ? "" : "s"} out`;
  const built = p.builder ? ` · last built on ${p.builder.trigger.kind} ${triggerRef(p.builder.trigger)}${p.builder.stepsStale ? " (steps stale)" : ""}` : "";
  return `${p.name}${reader ? " · one of your projects" : ""} · ${mapped}${provides ? ` · provides ${provides}` : ""}${built}`;
}

function Header({
  p,
  col,
  reader,
  linksOut,
  provides,
  selected,
  onSelect,
}: {
  p: BusProject;
  col: number;
  reader: boolean;
  linksOut: number;
  provides: number;
  selected: boolean;
  onSelect: (s: Selection) => void;
}) {
  const line = headerLine(p);
  return (
    <div
      className={cn(
        "relative z-[1] mx-[3px] grid content-start gap-1 rounded-lg px-2 pb-3 pt-2.5",
        selected ? "bg-[var(--accent-tint)]" : "hover:bg-hover",
      )}
      style={{ gridRow: 1, gridColumn: col }}
    >
      <Tooltip label={headerTip(p, reader, linksOut, provides)} multiline>
        <button
          type="button"
          onClick={() => onSelect({ kind: "project", id: p.id })}
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-13 font-bold text-fg"
        >
          <ProjectMark slug={p.slug} />
          <span className="truncate">{p.slug}</span>
          {reader ? <span className="text-11" style={{ color: "var(--accent-text)" }}>●</span> : null}
        </button>
      </Tooltip>
      {line ? (
      <Tooltip label={line.tip} multiline>
        <button
          type="button"
          onClick={() => onSelect(p.builder ? { kind: "builder", id: p.id } : { kind: "project", id: p.id })}
          className={cn(
            "flex min-w-0 items-center gap-1.5 whitespace-nowrap text-left text-12",
            line.tone === "bad" ? "text-[var(--red-600)]" : line.tone === "active" ? "text-fg" : "text-subtle",
          )}
        >
          {line.tone === "active" ? (
            <i className="forge-pulse inline-block h-[7px] w-[7px] flex-none rounded-full" style={{ background: "var(--accent)" }} />
          ) : null}
          <span className="truncate">{line.text}</span>
        </button>
      </Tooltip>
      ) : null}
      {line && line.progress !== null ? (
        <span className="h-[3px] overflow-hidden rounded-sm bg-[var(--bg-sunken)]">
          <i className="block h-full" style={{ width: `${Math.round(line.progress * 100)}%`, background: "var(--accent)" }} />
        </span>
      ) : null}
    </div>
  );
}

function Chip({
  label,
  tone,
  tip,
  selected,
  work,
  outside,
  fade,
  onClick,
}: {
  label: string;
  tone: Tone;
  tip: string;
  selected: boolean;
  work?: boolean;
  outside?: number;
  fade?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={tip} multiline>
      <button
        type="button"
        className={cn("eco-chip", fade && "eco-fade")}
        data-tone={tone}
        data-sel={selected}
        data-work={Boolean(work)}
        onClick={onClick}
      >
        {label}
        {outside ? <i className="eco-out" aria-hidden /> : null}
      </button>
    </Tooltip>
  );
}

function linkTip(l: BusLink, names: Map<string, string>) {
  const out = l.outsideContract
    ? ` · uses ${l.outsideContract} operation${l.outsideContract === 1 ? "" : "s"} outside the contract`
    : "";
  return `${names.get(l.consumer) ?? "a member"} → ${l.contract.slug} from ${l.module} · on ${l.pinnedVersion} · ${l.state}: ${STATE_MEANING[l.state]}${out}`;
}

function Row({
  row,
  r,
  bus,
  lens,
  sel,
  names,
  onSelect,
}: {
  row: BusRow;
  r: number;
  bus: Bus;
  lens: Lens;
  sel: Selection;
  names: Map<string, string>;
  onSelect: (s: Selection) => void;
}) {
  const col = new Map(bus.projects.map((p, i) => [p.id, i + 2]));
  const focused = lens === "impact" && sel.kind === "contract";
  const isSel = focused && sel.key === row.key;
  const fade = focused && !isSel;
  const [a, z] = row.span;
  const span = z - a + 1;
  const providerCol = col.get(row.ref.provider);
  const byConsumer = new Map<string, BusLink[]>();
  for (const l of row.links) byConsumer.set(l.consumer, [...(byConsumer.get(l.consumer) ?? []), l]);
  const c = row.contract;
  const rowTip = c
    ? `${c.title} · ${c.type} · ${c.lifecycle} · by ${names.get(row.ref.provider) ?? "its provider"} · ${c.currentVersion ? `current ${c.currentVersion}` : "no version recorded"}`
    : `${row.ref.slug} is not published to this ecosystem by ${names.get(row.ref.provider) ?? "its provider"}, yet a link points at it`;
  const builders = new Map(bus.projects.map((p) => [p.id, builderActive(p.builder)]));
  return (
    <>
      <div className={cn("relative z-[1] flex items-center", fade && "eco-fade")} style={{ gridRow: r, gridColumn: 1, height: ROW_H }}>
        <Tooltip label={rowTip} multiline>
          <button
            type="button"
            onClick={() => onSelect({ kind: "contract", key: row.key })}
            className={cn(
              "truncate font-mono text-12 font-medium",
              isSel ? "text-[var(--red-600)]" : "text-fg hover:text-[var(--accent-text)]",
            )}
          >
            {row.ref.slug}
          </button>
        </Tooltip>
      </div>
      {span > 1 ? (
        <div
          aria-hidden
          className={cn("pointer-events-none relative", fade && "eco-fade")}
          style={{ gridRow: r, gridColumn: `${a + 2} / ${z + 3}`, height: ROW_H, margin: `0 calc(100% / ${span} / 2)` }}
        >
          <span className="eco-line" data-sel={isSel} />
        </div>
      ) : null}
      {providerCol ? (
        <div className={cn("relative z-[1] grid place-items-center", fade && "eco-fade")} style={{ gridRow: r, gridColumn: providerCol, height: ROW_H }}>
          <Chip
            label={c?.currentVersion ?? (c ? "no version" : "unpublished")}
            tone="own"
            tip={`Provided by ${names.get(row.ref.provider) ?? "its provider"} · ${rowTip}`}
            selected={sel.kind === "contract" && sel.key === row.key}
            onClick={() => onSelect({ kind: "contract", key: row.key })}
          />
        </div>
      ) : null}
      {[...byConsumer].map(([consumer, links]) => (
        <div
          key={consumer}
          className={cn("relative z-[1] flex flex-wrap place-content-center items-center gap-1", fade && "eco-fade")}
          style={{ gridRow: r, gridColumn: col.get(consumer), minHeight: ROW_H }}
        >
          {links.map((l) => {
            const verdict = isSel ? impactOf(l) : null;
            return (
              <Chip
                key={l.id}
                label={verdict ? VERDICT_LABEL[verdict](l) : l.pinnedVersion}
                tone={verdict ? VERDICT_TONE[verdict] : STATE_TONE[l.state]}
                tip={verdict ? `${linkTip(l, names)} · ${impactLine(l)}` : linkTip(l, names)}
                selected={sel.kind === "link" && sel.id === l.id}
                work={lens === "live" && builders.get(l.consumer)}
                outside={l.outsideContract}
                onClick={() => onSelect({ kind: "link", id: l.id })}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

export function BusDiagram({
  bus,
  rows,
  lens,
  sel,
  readers,
  onSelect,
}: {
  bus: Bus;
  rows: BusRow[];
  lens: Lens;
  sel: Selection;
  readers: ReadonlySet<string>;
  onSelect: (s: Selection) => void;
}) {
  const names = new Map(bus.projects.map((p) => [p.id, p.slug]));
  const R = Math.max(rows.length, 1);
  const selectedColumn =
    sel.kind === "project" || sel.kind === "builder"
      ? sel.id
      : sel.kind === "link"
        ? bus.links.find((l) => l.id === sel.id)?.consumer
        : undefined;
  return (
    <div className="eco-dots flex-none overflow-x-auto px-4 pb-2.5 pt-1 sm:px-7">
      <div
        className={cn("relative grid", lens === "live" && "eco-live")}
        style={{ gridTemplateColumns: `132px repeat(${bus.projects.length}, minmax(104px, 1fr))` }}
      >
        <div style={{ gridRow: 1, gridColumn: 1 }} />
        {bus.projects.map((p, i) => (
          <Header
            key={p.id}
            p={p}
            col={i + 2}
            reader={readers.has(p.id)}
            linksOut={bus.links.filter((l) => l.consumer === p.id).length}
            provides={bus.contracts.filter((c) => c.provider === p.id).length}
            selected={selectedColumn === p.id}
            onSelect={onSelect}
          />
        ))}
        {bus.projects.map((p, i) => (
          <div
            key={`col-${p.id}`}
            aria-hidden
            className="pointer-events-none ml-[50%] border-l border-dashed border-line"
            style={{ gridRow: `2 / span ${R}`, gridColumn: i + 2 }}
          />
        ))}
        {rows.length === 0 ? (
          <p
            className="fg-caption self-center py-4"
            style={{ gridRow: 2, gridColumn: `1 / span ${bus.projects.length + 1}` }}
          >
            No member publishes a contract to {bus.ecosystem.name}, and no member&apos;s master has mapped a link, so there is no line to draw yet.
          </p>
        ) : (
          rows.map((row, i) => (
            <Row key={row.key} row={row} r={i + 2} bus={bus} lens={lens} sel={sel} names={names} onSelect={onSelect} />
          ))
        )}
      </div>
    </div>
  );
}
