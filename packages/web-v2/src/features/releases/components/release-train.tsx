"use client";

import { RELEASE_PROOF_LABELS, RELEASE_PROOF_TONES, RELEASE_STATE_TONES } from "@forge/contracts/releases";
import Link from "next/link";
import { LEGEND, MarkStrip, StatusBadge } from "@/design";
import { cn } from "@/lib/utils/cn";
import { releaseHref } from "../routes";
import type { ReleaseContentGroup, ReleaseSummary } from "../types";

const SHOWN = 8;
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function Contents({ groups }: { groups: ReleaseContentGroup[] }) {
  return (
    <span className="grid gap-0.5">
      {groups.map((g) => (
        <span key={g.requirement?.key ?? "maintenance"} className="flex items-center gap-2 text-12">
          <span className={cn(g.requirement ? "font-mono text-fg" : "text-subtle")} title={g.requirement?.title}>
            {g.requirement?.key ?? "Maintenance"}
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
    </span>
  );
}

function Node({ r, slug, selected }: { r: ReleaseSummary; slug: string; selected: boolean }) {
  const at = r.releasedAt ?? r.openedAt;
  const tone = LEGEND[RELEASE_STATE_TONES[r.state]].dot;
  return (
    <Link
      href={releaseHref(slug, r.version)}
      aria-current={selected ? "page" : undefined}
      className={cn("grid min-w-[210px] max-w-[260px] flex-1 content-start gap-1 py-1.5 pl-3 pr-3 no-underline hover:bg-hover", selected && "bg-sunken")}
      style={{ borderLeft: `3px solid ${tone}` }}
      data-testid="train-node"
      data-key={r.key}
    >
      <span className="font-mono text-12-5 font-semibold text-link">{r.version}</span>
      <span className="flex flex-wrap items-center gap-x-1.5 text-12 text-muted">
        <StatusBadge family="releaseState" value={r.state} />
        {at ? <span>{DAY.format(new Date(at))}</span> : null}
        <span>Issues {r.issueCount}</span>
      </span>
      <Contents groups={r.contents} />
    </Link>
  );
}

export function ReleaseTrain({ releases, slug, selected }: { releases: ReleaseSummary[]; slug: string; selected?: string }) {
  const ordered = [...releases].reverse();
  const shown = ordered.slice(-SHOWN);
  const earlier = ordered.length - shown.length;
  const hasDraft = releases.some((r) => r.state === "draft");
  return (
    <section aria-label="Release train" className="grid gap-2 px-5 pb-3 pt-3 max-md:px-3" data-testid="release-train">
      <p className="text-12 text-muted">
        <span className="font-semibold text-fg">Release train</span> Contents grouped by requirement; a bar is an issue
      </p>
      <ol className="m-0 flex list-none items-stretch gap-1 overflow-x-auto p-0">
        {earlier > 0 ? (
          <li className="grid flex-none content-center px-2 text-12 text-subtle">
            {earlier} earlier
          </li>
        ) : null}
        {shown.map((r, i) => (
          <li key={r.key} className="flex flex-none items-stretch gap-1">
            {i > 0 ? (
              <span aria-hidden className="grid flex-none place-items-center px-0.5 text-subtle">
                →
              </span>
            ) : null}
            <Node r={r} slug={slug} selected={r.key === selected} />
          </li>
        ))}
        {hasDraft ? null : (
          <li className="flex items-stretch gap-1">
            <span aria-hidden className="grid flex-none place-items-center px-0.5 text-subtle">
              →
            </span>
            <span className="grid min-w-[180px] max-w-[220px] content-start gap-0.5 py-1.5 pl-3" style={{ borderLeft: "3px dashed var(--paper-400)" }}>
              <b className="text-12-5 font-semibold">Next</b>
              <span className="text-12 text-muted">No release planned. Issues queue at Awaiting release.</span>
            </span>
          </li>
        )}
      </ol>
    </section>
  );
}
