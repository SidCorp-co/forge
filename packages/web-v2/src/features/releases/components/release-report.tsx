// The body of a release page in the approved report shape (ISS-1001): "What users see" as one table
// of screens, each with its changes in the words of their release notes, and "Needs attention", the
// things the decider must weigh, absent when there are none. The page in the app and a page a share
// link opens both draw it, so the two cannot read differently.

import type { ReleasePage } from "@forge/contracts/release-page";
import { keyedByContent, Property, PropertyList } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { releaseProofOf, unprovenOf } from "../proof";
import { changesByScreen, removedLines, unseenCount } from "../release-report";

const HEAD = "mb-1.5 text-11-5 font-semibold uppercase tracking-wide text-muted";

export function WhatUsersSee({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const screens = changesByScreen(page);
  const unseen = unseenCount(page);
  if (screens.length === 0 && unseen === 0) return null;
  return (
    <section aria-label={t("releases.users.title")} data-testid="page-users" data-tour="rel-users">
      <h2 className={HEAD}>{t("releases.users.title")}</h2>
      <PropertyList testId="page-screens">
        {screens.map((s) => (
          <Property key={s.screen ?? ""} label={s.screen ?? t("releases.users.elsewhere")} testId="page-screen">
            {keyedByContent(s.lines, (l) => l.text).map(({ key, item: l, index }) => (
              <span key={key} className="text-14 max-md:block">
                {index > 0 ? <span className="mr-1.5 text-subtle max-md:hidden">·</span> : null}
                <span className={cn(l.removed ? "font-medium text-danger-11" : "text-fg")} title={l.detail ?? undefined} data-testid="page-screen-change" data-removed={l.removed}>
                  {l.text}
                </span>
              </span>
            ))}
          </Property>
        ))}
        {unseen > 0 ? (
          <Property label={t("releases.users.unseen")} testId="page-unseen">
            <span className="text-14 text-muted">{t("releases.users.unseenCount", { n: unseen })}</span>
          </Property>
        ) : null}
      </PropertyList>
    </section>
  );
}

/**
 * What the decider must weigh, each in one line: that the master records it rather than cutting it,
 * the steps before it goes out, what it removes, what is unproven or failing. A line's `detail` opens
 * on demand, never inline.
 */
export function attentionOf(page: ReleasePage, t: Copy): { key: string; text: string; detail?: string }[] {
  const proof = releaseProofOf(page.header.verified);
  const unproven = unprovenOf(proof);
  const removed = removedLines(page);
  const failing = page.header.shippedFailing?.count ?? 0;
  return [
    // NO_RELEASE_GATE, named: no production is declared, so nothing cuts this release (ISS-1019)
    ...(page.header.recordedNotCut ? [{ key: "recorded", text: t("releases.attention.recorded"), detail: t("releases.attention.recordedDetail") }] : []),
    ...page.actionRequired.map((a, i) => ({ key: `step:${i}`, text: a.sentence })),
    ...(removed.length > 0 ? [{ key: "removed", text: t("releases.attention.removed", { list: removed.join(", ") }) }] : []),
    ...(proof && unproven > 0
      ? [
          {
            key: "unproven",
            text: proof.on
              ? t("releases.attention.unprovenOn", { n: unproven, total: proof.total, env: proof.on })
              : t("releases.attention.unproven", { n: unproven, total: proof.total }),
          },
        ]
      : []),
    ...(failing > 0 ? [{ key: "failing", text: t("releases.attention.failing", { n: failing }) }] : []),
    ...(page.header.approval.state === "unapproved" ? [{ key: "unapproved", text: t("releases.unapproved") }] : []),
  ];
}

export function NeedsAttention({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const items = attentionOf(page, t);
  if (items.length === 0) return null;
  return (
    <section aria-label={t("releases.attention.title")} data-testid="page-attention">
      <h2 className={HEAD}>{t("releases.attention.title")}</h2>
      <ul>
        {items.map((a) => (
          <li key={a.key} className="flex items-baseline gap-2.5 border-t border-line-subtle py-2 text-14 text-fg" data-testid="page-attention-item" data-kind={a.key.split(":")[0]}>
            <i aria-hidden className="inline-block size-2 flex-none rounded-full bg-warn-9" />
            <span title={a.detail}>{a.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReleaseReport({ page }: { page: ReleasePage }) {
  return (
    <div className="grid gap-6" data-testid="release-report">
      <WhatUsersSee page={page} />
      <NeedsAttention page={page} />
    </div>
  );
}
