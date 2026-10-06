"use client";

import { RELEASE_PROOF_LABELS, RELEASE_PROOF_TONES, RELEASE_STATE_LABELS, RELEASE_STATE_TONES } from "@forge/contracts/releases";
import Link from "next/link";
import { LEGEND, MarkStrip, ViewHeading } from "@/design";
import { cn } from "@/lib/utils/cn";
import { releaseHref } from "../../../lib/routes/releases";
import type { ReleaseContentGroup, ReleaseSummary } from "../types";

const SHOWN = 6;
const ROWS = 4;
const DAY = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });

const groupKey = (g: ReleaseContentGroup) => g.requirement?.key ?? "Maintenance";

function Contents({ groups }: { groups: ReleaseContentGroup[] }) {
  const shown = groups.slice(0, ROWS);
  const rest = groups.slice(ROWS);
  return (
    <span className="grid gap-0.5" data-testid="train-contents">
      {shown.map((g) => (
        <span key={groupKey(g)} className="flex items-center gap-2 text-12">
          <span className={cn(g.requirement ? "font-mono text-fg" : "text-subtle")} title={g.requirement?.title}>
            {groupKey(g)}
          </span>
          <MarkStrip
            size="sm"
            marks={g.issues.map((i) => ({
              key: i.key,
              label: `${i.key} ${i.title} · ${RELEASE_PROOF_LABELS[i.proof]}`,
              ...(i.proof === "unrecorded" || i.proof === "open" ? { fill: "var(--paper-300)" } : { tone: RELEASE_PROOF_TONES[i.proof] }),
            }))}
          />
        </span>
      ))}
      {rest.length > 0 ? (
        <span className="text-12 text-subtle" title={rest.map(groupKey).join(", ")} data-testid="train-more">
          +{rest.length} more {rest.length === 1 ? "group" : "groups"}
        </span>
      ) : null}
    </span>
  );
}

function meta(r: ReleaseSummary): string {
  const at = r.releasedAt ?? r.openedAt;
  return [RELEASE_STATE_LABELS[r.state], at ? DAY.format(new Date(at)) : null, `Issues ${r.issueCount}`].filter(Boolean).join(" · ");
}

const COLUMN = "grid w-[250px] flex-none content-start gap-1 py-1.5 pl-3 pr-3";

function Cut({ r, slug, selected }: { r: ReleaseSummary; slug: string; selected: boolean }) {
  return (
    <Link
      href={releaseHref(slug, r.version)}
      aria-current={selected ? "page" : undefined}
      className={cn(COLUMN, "no-underline hover:bg-hover", selected && "bg-sunken")}
      style={{ borderLeft: `3px solid ${LEGEND[RELEASE_STATE_TONES[r.state]].dot}` }}
      data-testid="train-node"
      data-key={r.key}
    >
      <span className="font-mono text-12-5 font-semibold text-link">{r.version}</span>
      <span className="text-12 text-muted">{meta(r)}</span>
      <Contents groups={r.contents} />
    </Link>
  );
}

function Next({ draft, slug, selected }: { draft: ReleaseSummary | undefined; slug: string; selected: boolean }) {
  const edge = { borderLeft: "3px dashed var(--ink-400)" };
  if (!draft) {
    return (
      <span className={COLUMN} style={edge} data-testid="train-next">
        <b className="text-12-5 font-semibold text-fg">Next</b>
        <span className="text-12 text-muted">No release planned. Issues queue at Awaiting release.</span>
      </span>
    );
  }
  return (
    <Link
      href={releaseHref(slug, draft.version)}
      aria-current={selected ? "page" : undefined}
      className={cn(COLUMN, "no-underline hover:bg-hover", selected && "bg-sunken")}
      style={edge}
      data-testid="train-next"
      data-key={draft.key}
    >
      <b className="text-12-5 font-semibold text-fg">Next</b>
      <span className="text-12 text-muted">
        <span className="font-mono font-semibold text-link">{draft.version}</span> · not cut · Issues {draft.issueCount}
      </span>
      <Contents groups={draft.contents} />
    </Link>
  );
}

const Arrow = () => (
  <span aria-hidden className="grid flex-none place-items-center px-1 text-subtle">
    →
  </span>
);

export function ReleaseTrain({ releases, slug, selected }: { releases: ReleaseSummary[]; slug: string; selected?: string }) {
  const draft = releases.find((r) => r.state === "draft");
  const cut = releases.filter((r) => r.state !== "draft").reverse();
  const shown = cut.slice(-SHOWN);
  const earlier = cut.length - shown.length;
  return (
    <section aria-label="Release train" className="px-5 pb-4 pt-4 max-md:px-3" data-testid="release-train">
      <ViewHeading hint="Contents grouped by requirement; a bar is an issue">Release train</ViewHeading>
      <ol className="m-0 flex list-none items-stretch gap-1 overflow-x-auto p-0">
        {earlier > 0 ? (
          <li className="grid flex-none content-center px-2 text-12 text-subtle" data-testid="train-earlier">
            {earlier} earlier
          </li>
        ) : null}
        {shown.map((r, i) => (
          <li key={r.key} className="flex flex-none items-stretch gap-1">
            {i > 0 || earlier > 0 ? <Arrow /> : null}
            <Cut r={r} slug={slug} selected={r.key === selected} />
          </li>
        ))}
        <li className="flex flex-none items-stretch gap-1">
          {shown.length > 0 ? <Arrow /> : null}
          <Next draft={draft} slug={slug} selected={draft !== undefined && draft.key === selected} />
        </li>
      </ol>
    </section>
  );
}
