"use client";

import type { ReleaseChanges, ReleaseSurfaceChanges } from "@forge/contracts/releases";
import Link from "next/link";
import { useState } from "react";
import { EnumBadge, FieldLabel, LEGEND, ViewHeading } from "@/design";
import { useCopy, useInterfaceLanguage, useLabel } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { issueHref } from "@/lib/routes/issues";
import { DisclosureToggle } from "./release-bits";

/** `1 issue` / `2 issues`: the key's `.one` reading for one, its `.many` reading otherwise. */
const plural = (t: Copy, n: number, key: "releases.count.issue" | "releases.count.artifact" | "releases.count.designRevision") =>
  t(`${key}.${n === 1 ? "one" : "many"}` as ProductCopyKey, { n });

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
export function changesSentence(c: ReleaseChanges, t: Copy, label: ReturnType<typeof useLabel>): string {
  const deploys = c.surfaces.filter((s) => !s.shipsNothing).map((s) => label("landingSurface", s.surface));
  const design = c.surfaces.find((s) => s.shipsNothing);
  const parts: string[] = [];
  if (c.shipsNothing) parts.push(t("releases.changes.shipsNothing"));
  else if (deploys.length > 0) {
    const list = deploys.length === 1 ? deploys[0] : t("releases.changes.andList", { list: deploys.slice(0, -1).join(", "), last: deploys.at(-1) ?? "" });
    parts.push(t("releases.changes.deploys", { list: list ?? "" }));
  } else if (c.surfaces.length === 0 && c.unclassified.length === 0) parts.push(t("releases.changes.noneNamed"));
  if (design && !c.shipsNothing) parts.push(t(design.count === 1 ? "releases.changes.designShipsNothing.one" : "releases.changes.designShipsNothing.many", { n: design.count }));
  const n = c.unclassified.length;
  if (n > 0) parts.push(t(n === 1 ? "releases.changes.unstructured.one" : "releases.changes.unstructured.many", { n }));
  return parts.join(" ");
}

function SurfaceRow({ s, slug }: { s: ReleaseSurfaceChanges; slug?: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line-subtle py-2 text-13" data-testid="release-surface" data-surface={s.surface}>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-[72px] flex-none">
          <EnumBadge family="landingSurface" value={s.surface} />
        </span>
        <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12-5" testId="release-surface-toggle">
          {plural(t, s.count, "releases.count.artifact")}
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

/** One line per reason with a count and the issues behind it on a toggle, never a row per issue. */
function Unclassified({ items, slug }: { items: ReleaseChanges["unclassified"]; slug?: string }) {
  const byWhy = new Map<string, ReleaseChanges["unclassified"]>();
  for (const u of items) byWhy.set(u.why, [...(byWhy.get(u.why) ?? []), u]);
  return (
    <ul className="border-t border-line-subtle" data-testid="release-unclassified-list">
      {[...byWhy.entries()].map(([why, group]) => (
        <UnclassifiedReason key={why} why={why} group={group} slug={slug} />
      ))}
    </ul>
  );
}

function UnclassifiedReason({ why, group, slug }: { why: string; group: ReleaseChanges["unclassified"]; slug?: string }) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  return (
    <li className="grid gap-1 border-b border-line-subtle py-2 text-13" data-testid="release-unclassified">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} className="text-12-5" testId="release-unclassified-toggle">
          {plural(t, group.length, "releases.count.issue")}
        </DisclosureToggle>
        <span className="min-w-0 flex-1 text-12-5 text-muted">{why}</span>
      </span>
      {open ? (
        <ul className="grid gap-1 pl-4">
          {group.map((u) => (
            <li key={u.key} className="grid gap-0.5">
              <IssueKeys keys={[u.key]} slug={slug} />
              {u.paths.length > 0 ? <span className="break-all font-mono text-11-5 text-subtle">{u.paths.join(" · ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** "What changes": per surface what the release's landings name, risks first, design apart. */
export function WhatChanges({ changes, slug }: { changes: ReleaseChanges; slug?: string }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const label = useLabel();
  const deploys = changes.surfaces.filter((s) => !s.shipsNothing);
  const design = changes.surfaces.filter((s) => s.shipsNothing);
  return (
    <section aria-label={t("releases.changes.title")} data-testid="release-changes" className="grid gap-4">
      <div>
        <ViewHeading hint={t("releases.changes.hint")}>{t("releases.changes.title")}</ViewHeading>
        <p className="text-13-5" data-testid="release-changes-sentence">
          {changesSentence(changes, t, label)}
        </p>
        {changes.boxRead.length > 0 ? (
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-12-5 text-muted" data-testid="release-box-read">
            <span>{t("releases.changes.boxRead")}</span>
            <IssueKeys keys={changes.boxRead} slug={slug} />
          </p>
        ) : null}
      </div>
      {changes.risks.length > 0 ? (
        <ul className="divide-y divide-line-subtle border-y border-line-subtle" aria-label={t("releases.changes.risks")}>
          {changes.risks.map((k) => (
            <li key={`${k.risk}:${k.ref}`} className="flex items-start gap-2 py-2 text-13" data-testid="release-risk" data-risk={k.risk}>
              <span aria-hidden className="mt-[7px] size-1.5 flex-none rounded-full" style={{ background: LEGEND.err.dot }} />
              <span className="min-w-0 flex-1">{said(k.says.sentence, language)}</span>
              <IssueKeys keys={k.issues} slug={slug} />
            </li>
          ))}
        </ul>
      ) : null}
      {deploys.length > 0 ? (
        <ul className="border-t border-line-subtle" aria-label={t("releases.changes.surfaces")}>
          {deploys.map((s) => (
            <SurfaceRow key={s.surface} s={s} slug={slug} />
          ))}
        </ul>
      ) : null}
      {design.length > 0 ? (
        <div data-testid="release-ships-nothing">
          <FieldLabel>{t("releases.changes.designNothing")}</FieldLabel>
          <ul className="border-t border-line-subtle">
            {design.map((s) => (
              <SurfaceRow key={s.surface} s={s} slug={slug} />
            ))}
          </ul>
        </div>
      ) : null}
      {changes.unclassified.length > 0 ? (
        <div>
          <FieldLabel>{t("releases.changes.unclassifiedHead")}</FieldLabel>
          <Unclassified items={changes.unclassified} slug={slug} />
        </div>
      ) : null}
    </section>
  );
}
