// The body of a release page (ISS-1001, drawn to mockup MK-13 since ISS-1308): the hero with its cover
// clip and counts, What's new and Fixed in the words of their release notes, each beside the clip or
// shots its judge marked, and "Needs attention", the things the decider must weigh, absent when there
// are none. The page in the app and a page a share link opens both draw it, so the two cannot read
// differently.

import type { ReleasePage } from "@forge/contracts/release-page";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { releaseProofOf, unprovenOf } from "../proof";
import { removedLines } from "../release-report";
import { FixedRows, LineWords, ReleaseHero, WhatsNew } from "./release-lines";

const HEAD = "mb-1.5 text-11-5 font-semibold uppercase tracking-wide text-muted";

/**
 * What the decider must weigh, each in one line: that the master records it rather than cutting it,
 * the steps before it goes out, what it removes, what is unproven or failing. A line's `detail` opens
 * on demand under it, never inline and never on hover alone.
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
            <div className="grid min-w-0 justify-items-start gap-0.5">
              <LineWords line={a.text} detail={a.detail} title="min-w-0 font-normal text-fg" sentence="max-w-prose text-13 text-muted" testId="page-attention" />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** `authed`: the reader is signed in, so each file is fetched with the session; a share's plays from its ticket. */
export function ReleaseReport({ page, authed = true }: { page: ReleasePage; authed?: boolean }) {
  return (
    <div className="grid gap-6" data-testid="release-report">
      <ReleaseHero page={page} authed={authed} />
      <WhatsNew page={page} authed={authed} />
      <FixedRows page={page} authed={authed} />
      <NeedsAttention page={page} />
    </div>
  );
}
