"use client";

import { LANDING_SURFACE_LABELS } from "@forge/contracts/landing-artifacts";
import type { ReleaseChanges, ReleaseSurfaceChanges } from "@forge/contracts/releases";
import Link from "next/link";
import { useState } from "react";
import { EnumBadge, FieldLabel, LEGEND, ViewHeading } from "@/design";
import { issueHref } from "@/lib/routes/issues";
import { DisclosureToggle } from "./release-bits";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function IssueKeys({ keys, slug }: { keys: string[]; slug?: string }) {
  return (
    <span className="flex flex-wrap gap-x-2 font-mono text-12">
      {keys.map((k) =>
        slug ? (
          <Link key={k} className="text-link hover:underline" href={issueHref(slug, k)}>
            {k}
          </Link>
        ) : (
          <span key={k} className="text-link">
            {k}
          </span>
        ),
      )}
    </span>
  );
}

/** One line of what the release changes, e.g. "Deploys UI, API and Data. 2 design revisions ship nothing." */
export function changesSentence(c: ReleaseChanges): string {
  const deploys = c.surfaces.filter((s) => !s.shipsNothing).map((s) => LANDING_SURFACE_LABELS[s.surface]);
  const design = c.surfaces.find((s) => s.shipsNothing);
  const parts: string[] = [];
  if (c.shipsNothing) parts.push("Ships nothing: every change in it is a design revision.");
  else if (deploys.length > 0) {
    const list = deploys.length === 1 ? deploys[0] : `${deploys.slice(0, -1).join(", ")} and ${deploys.at(-1)}`;
    parts.push(`Deploys ${list}.`);
  } else if (c.surfaces.length === 0 && c.unclassified.length === 0) parts.push("No issue names a change.");
  if (design && !c.shipsNothing) parts.push(`${plural(design.count, "design revision")} ${design.count === 1 ? "ships" : "ship"} nothing.`);
  const n = c.unclassified.length;
  if (n > 0) parts.push(`${plural(n, "issue")} ${n === 1 ? "names" : "name"} nothing structured.`);
  return parts.join(" ");
}

function SurfaceRow({ s, slug }: { s: ReleaseSurfaceChanges; slug?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line-subtle py-2 text-13" data-testid="release-surface" data-surface={s.surface}>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-[72px] flex-none">
          <EnumBadge family="landingSurface" value={s.surface} />
        </span>
        <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12-5" testId="release-surface-toggle">
          {plural(s.count, "artifact")}
        </DisclosureToggle>
        <span className="ml-auto">
          <IssueKeys keys={s.issues} slug={slug} />
        </span>
      </span>
      {open ? (
        <ul className="mt-1.5 grid gap-1 pl-[84px] max-md:pl-0" data-testid="release-artifacts">
          {s.artifacts.map((a) => (
            <li key={`${a.change}:${a.ref}`} className="flex flex-wrap items-center gap-x-2 text-12-5" data-testid="release-artifact">
              <EnumBadge family="artifactChange" value={a.change} />
              <span className="min-w-0 break-all font-mono text-12">{a.ref}</span>
              <span className="ml-auto">
                <IssueKeys keys={a.issues} slug={slug} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Unclassified({ items, slug }: { items: ReleaseChanges["unclassified"]; slug?: string }) {
  return (
    <ul className="border-t border-line-subtle">
      {items.map((u) => (
        <li key={u.key} className="grid gap-0.5 border-b border-line-subtle py-2 text-13" data-testid="release-unclassified">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <IssueKeys keys={[u.key]} slug={slug} />
            <span className="min-w-0 flex-1 text-12-5 text-muted">{u.why}</span>
          </span>
          {u.paths.length > 0 ? (
            <span className="break-all font-mono text-11-5 text-subtle">{u.paths.join(" · ")}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** "What changes": per surface what the release's landings name, risks first, design apart. */
export function WhatChanges({ changes, slug }: { changes: ReleaseChanges; slug?: string }) {
  const deploys = changes.surfaces.filter((s) => !s.shipsNothing);
  const design = changes.surfaces.filter((s) => s.shipsNothing);
  return (
    <section aria-label="What changes" data-testid="release-changes" className="grid gap-4">
      <div>
        <ViewHeading hint="What each issue's landing names, by where it takes effect">What changes</ViewHeading>
        <p className="text-13-5" data-testid="release-changes-sentence">
          {changesSentence(changes)}
        </p>
        {changes.boxRead.length > 0 ? (
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-12-5 text-muted" data-testid="release-box-read">
            <span>Paths read from a box&apos;s checkout, not a merge Forge observed:</span>
            <IssueKeys keys={changes.boxRead} slug={slug} />
          </p>
        ) : null}
      </div>
      {changes.risks.length > 0 ? (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle" aria-label="Risks">
          {changes.risks.map((k) => (
            <li key={`${k.risk}:${k.ref}`} className="flex items-start gap-2 py-2 text-13" data-testid="release-risk" data-risk={k.risk}>
              <span aria-hidden className="mt-[7px] size-1.5 flex-none rounded-full" style={{ background: LEGEND.err.dot }} />
              <span className="min-w-0 flex-1">{k.sentence}</span>
              <IssueKeys keys={k.issues} slug={slug} />
            </li>
          ))}
        </ul>
      ) : null}
      {deploys.length > 0 ? (
        <ul className="border-t border-line-subtle" aria-label="Surfaces it deploys">
          {deploys.map((s) => (
            <SurfaceRow key={s.surface} s={s} slug={slug} />
          ))}
        </ul>
      ) : null}
      {design.length > 0 ? (
        <div data-testid="release-ships-nothing">
          <FieldLabel>Design — ships nothing</FieldLabel>
          <ul className="border-t border-line-subtle">
            {design.map((s) => (
              <SurfaceRow key={s.surface} s={s} slug={slug} />
            ))}
          </ul>
        </div>
      ) : null}
      {changes.unclassified.length > 0 ? (
        <div>
          <FieldLabel>Unclassified — what no surface names</FieldLabel>
          <Unclassified items={changes.unclassified} slug={slug} />
        </div>
      ) : null}
    </section>
  );
}
