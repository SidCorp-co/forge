// A release's lines as mockup MK-13 draws them (ISS-1308): a hero with its name, cover clip and
// counts, its summary opening under the name; What's new as feature rows, each beside the clip or
// shots its judge marked; Fixed as compact rows with thumbnails, a line whose landing touched no
// screen saying so; and, on the developer view, the lines that touched a screen and show nothing,
// counted. No issue key, commit or file name is on the reader's face: a line is its note's words and
// its picture. A line's sentence opens in a card over the page on a click, a tap, Enter or Space, never
// on hover alone and never in place (REQ-43 r3 BC-15), and so does the release's summary from its name:
// the first view holds no paragraph and stays within its word budget (ISS-1368).

import type { ReleasePage } from "@forge/contracts/release-page";
import { releaseVisualCounts } from "@forge/contracts/release-visual";
import { useId, useRef, useState } from "react";
import { Badge, DeviceFrame, Icon, Popover, ToneBadge } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { unseenCount } from "../release-report";
import { LineVisual, VisualThumb, VisualTile } from "./release-visual";

type Change = ReleasePage["improvements"][number];

const HEAD = "mb-2 text-11-5 font-semibold uppercase tracking-wide text-muted";

const hasClip = (c: Change) => [c.visual?.desktop, c.visual?.phone].some((f) => f?.kind === "clip");

/** The line a release opens on: the first with a clip, else the first with any visual. */
export const coverLineOf = (page: Pick<ReleasePage, "improvements" | "fixes">): Change | null => {
  const lines = [...page.improvements, ...page.fixes];
  return lines.find(hasClip) ?? lines.find((c) => c.visual) ?? null;
};

function Count({ n, label, testId }: { n: string | number; label: string; testId: string }) {
  return (
    <div className="grid pr-5" data-testid={testId}>
      <b className="text-20 font-semibold tabular-nums text-fg">{n}</b>
      <span className="text-12 text-muted">{label}</span>
    </div>
  );
}

/**
 * The release's name, its summary on demand over the page, and its counts beside its cover clip: what
 * is new and fixed, and its clips and shots. Its criteria are the page's one proof bar above it
 * (ISS-1001), never said here again.
 */
export function ReleaseHero({ page, authed }: { page: ReleasePage; authed: boolean }) {
  const t = useCopy();
  const cover = coverLineOf(page);
  const media = releaseVisualCounts([...page.improvements, ...page.fixes]);
  if (!page.header.name && !page.header.summary && !cover && page.improvements.length + page.fixes.length === 0) return null;
  return (
    <section className={cn("grid border border-line bg-surface", cover?.visual && "md:grid-cols-2")} data-testid="release-hero">
      <div className="flex min-w-0 flex-col gap-3 p-5">
        {/* a summary runs two or three sentences: it opens from the name, or the version where none is given */}
        {page.header.name || page.header.summary ? (
          <LineWords
            line={page.header.name ?? page.header.version}
            detail={page.header.summary}
            heading="h2"
            title="text-22 font-bold leading-tight text-fg"
            sentence="max-w-prose text-14 text-muted"
            testId="hero-summary"
          />
        ) : null}
        <div className="mt-auto flex flex-wrap border-t border-line-subtle pt-2.5">
          <Count n={page.improvements.length} label={t("releases.hero.new")} testId="hero-new" />
          <Count n={page.fixes.length} label={t("releases.hero.fixed")} testId="hero-fixed" />
          {media.clips + media.shots > 0 ? <Count n={`${media.clips} · ${media.shots}`} label={t("releases.hero.media")} testId="hero-media" /> : null}
        </div>
      </div>
      {cover?.visual ? (
        <div className="min-w-0 bg-sunken" data-testid="hero-cover">
          <VisualTile visual={cover.visual} frame={cover.visual.desktop ? "desktop" : "phone"} authed={authed} label={cover.line} lead={t("releases.hero.watch")} />
        </div>
      ) : null}
    </section>
  );
}

const KIND_TONE = { new: "accent", improved: "cobalt", fixed: "neutral" } as const;

/** How a line's outside call was proven, as its judge said (ISS-1329): a word, the why on hover. */
function ProofTag({ proof }: { proof: Change["proof"] }) {
  const t = useCopy();
  if (!proof) return null;
  return (
    <span data-testid="line-proof" data-proof={proof}>
      <ToneBadge tone={proof === "live" ? "ready" : "you"} label={t(`releases.proof.${proof}`)} title={t(`releases.proof.${proof}Why`)} />
    </span>
  );
}

/**
 * A row's title, and its sentence on demand: the title is a button that opens the sentence whole in a
 * card over the page, anchored to it, and shuts it again, by Escape or a press outside too; the page
 * never moves under the reader. A row with no sentence is its title alone, with nothing to open.
 * `heading`: the title is a heading of the page's outline at that level, as the hero's name and a
 * What's new line's are.
 */
export function LineWords({
  line,
  detail,
  title,
  sentence,
  testId,
  heading,
}: {
  line: string;
  detail: string | null | undefined;
  title: string;
  sentence: string;
  testId: string;
  heading?: "h2" | "h3";
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const Title = heading ?? "span";
  if (!detail) return <Title className={title}>{line}</Title>;
  return (
    <Title className="min-w-0">
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn("inline-flex items-center gap-1 rounded-xs text-left outline-none focus-visible:shadow-focus", title)}
        data-testid={`${testId}-toggle`}
      >
        <Icon name="chevronRight" size={12} className="flex-none text-muted" />
        {line}
      </button>
      <Popover open={open} anchor={anchorRef} onDismiss={() => setOpen(false)} role="dialog" aria-label={line} maxWidth={420} className="px-3.5 py-3">
        <p id={id} className={cn("whitespace-normal font-normal", sentence)} data-testid={`${testId}-detail`}>
          {detail}
        </p>
      </Popover>
    </Title>
  );
}

/** One New or Improved line: its title (its sentence on demand), and the clip or shots its judge marked beside them. */
function NewLine({ c, authed }: { c: Change; authed: boolean }) {
  const t = useCopy();
  return (
    <li className={cn("grid gap-4 border-t border-line-subtle py-4 first:border-t-0", c.visual && "md:grid-cols-2")} data-testid="whats-new-row" data-visual={c.visual ? "shown" : "none"}>
      <div className="grid min-w-0 content-start gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-12 text-muted">
          <Badge tone={KIND_TONE[c.kind]}>{t(`releases.line.${c.kind}`)}</Badge>
          {c.screen ? <span data-testid="whats-new-screen">{c.screen}</span> : null}
          <ProofTag proof={c.proof} />
        </div>
        <LineWords line={c.line} detail={c.detail} heading="h3" title="text-16 font-semibold leading-snug text-fg" sentence="max-w-prose text-14 text-muted" testId="whats-new" />
      </div>
      {c.visual ? <LineVisual visual={c.visual} authed={authed} label={c.line} /> : null}
    </li>
  );
}

export function WhatsNew({ page, authed }: { page: ReleasePage; authed: boolean }) {
  const t = useCopy();
  if (page.improvements.length === 0) return null;
  return (
    <section aria-label={t("releases.whatsNew.title")} data-testid="page-users" data-tour="rel-users">
      <h2 className={HEAD}>{t("releases.whatsNew.title")}</h2>
      <ul data-testid="whats-new">
        {page.improvements.map((c) => (
          <NewLine key={c.issueKey} c={c} authed={authed} />
        ))}
      </ul>
    </section>
  );
}

/** A Fixed line with no visual: a slot saying no screen changed, or an empty one where one did. */
function NoThumb({ ui }: { ui: boolean | null | undefined }) {
  const t = useCopy();
  // a slot with nothing to open is no control: it draws the frame alone
  return (
    <div className="w-18 flex-none" data-testid="fixed-thumb-none" data-ui={String(ui ?? "unknown")}>
      <DeviceFrame kind="thumb">
        <span className="absolute inset-0 flex items-center justify-center text-11 text-muted">{ui === false ? t("releases.line.noUi") : "—"}</span>
      </DeviceFrame>
    </div>
  );
}

export function FixedRows({ page, authed }: { page: ReleasePage; authed: boolean }) {
  const t = useCopy();
  const unseen = unseenCount(page);
  if (page.fixes.length === 0 && unseen === 0) return null;
  return (
    <section aria-label={t("releases.fixed.title")} data-testid="page-fixed">
      {page.fixes.length > 0 ? <h2 className={HEAD}>{t("releases.fixed.title")}</h2> : null}
      <ul>
        {page.fixes.map((c) => (
          <li key={c.issueKey} className="flex items-center gap-3 border-t border-line-subtle py-2 first:border-t-0" data-testid="fixed-row">
            {c.visual ? <VisualThumb visual={c.visual} authed={authed} label={c.line} /> : <NoThumb ui={c.ui} />}
            <div className="grid min-w-0 justify-items-start gap-0.5">
              <LineWords line={c.line} detail={c.detail} title="min-w-0 text-14 font-medium text-fg" sentence="max-w-prose text-13 text-muted" testId="fixed" />
            </div>
            <ProofTag proof={c.proof} />
          </li>
        ))}
      </ul>
      {unseen > 0 ? (
        <p className="mt-2 text-13 text-muted" data-testid="page-unseen">
          {t("releases.users.unseen")} · {t("releases.users.unseenCount", { n: unseen })}
        </p>
      ) : null}
    </section>
  );
}

/** The developer view's lines that touched a screen and show nothing, counted; nothing is refused for them. */
export function VisualsOwed({ page }: { page: ReleasePage }) {
  const t = useCopy();
  const owed = page.visualsOwed;
  if (!owed || owed.count === 0) return null;
  return (
    <section aria-label={t("releases.owed.title")} data-testid="visuals-owed" data-count={owed.count}>
      <h2 className={HEAD}>
        {t("releases.owed.title")} <Badge tone="amber">{owed.count}</Badge>
      </h2>
      <ul>
        {owed.lines.map((l) => (
          <li key={l.issueKey} className="flex items-center gap-3 border-t border-line-subtle py-2 text-14 first:border-t-0" data-testid="visual-owed-row">
            <span className="font-mono text-12 text-muted">{l.issueKey}</span>
            <span className="min-w-0 flex-1 text-fg">{l.line}</span>
            <ToneBadge tone="you" label={t("releases.owed.tag")} title={t("releases.owed.why")} />
          </li>
        ))}
      </ul>
    </section>
  );
}
