// What a lane's marks say (ISS-979, the owner's mockup v3), all read from core's lane and none inferred
// here: a batch of status moves (its summary on hover; on click, each issue from → to), a release
// (version, time and count on hover; on click, its issues and Open release) and what waits on the
// reader (on hover, how many of what; on click, each item, with Answer first and Open all). A record's
// key is never text: it is a link target and a tooltip (the owner's UI rule).

import type { OrgActivityBatch, OrgActivityLaneRelease, OrgActivityPerson, OrgActivityProject } from "@forge/contracts/org-activity";
import type { ReactNode, RefObject } from "react";
import { Icon, Popover, statusReading } from "@/design";
import { useCopy, useCopyLocale, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { approvalsHref } from "@/lib/routes/approvals";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { cn } from "@/lib/utils/cn";

/** What a lane's mark opens: one popover on the page at a time. */
export type OpenMark =
  | { kind: "batch"; project: OrgActivityProject; batch: OrgActivityBatch }
  | { kind: "release"; project: OrgActivityProject; release: OrgActivityLaneRelease }
  | { kind: "wait"; project: OrgActivityProject; items: OrgActivityPerson[]; since: string; more: number };

export const issuesText = (t: Copy, n: number) => (n === 1 ? t("activity.issues.one") : t("activity.issues.many", { n }));

/** Label-first counts of what a list holds, most first: `2 → Awaiting release`. */
function tally(keys: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function useMarkWords() {
  const t = useCopy();
  const locale = useCopyLocale();
  const language = useInterfaceLanguage();
  const clock = (at: string) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const status = (s: string) => statusReading("issue", s, language).label;
  const kind = (p: OrgActivityPerson) => t(`activity.wait.kind.${p.group}`);
  const moved = (b: OrgActivityBatch) => tally(b.moves.map((m) => status(m.to))).map(([s, n]) => `${n} → ${s}`);
  const kinds = (items: OrgActivityPerson[]) => tally(items.map(kind)).map(([k, n]) => `${n} ${k.toLowerCase()}`);
  return {
    t,
    clock,
    status,
    kind,
    moved,
    kinds,
    batchTip: (b: OrgActivityBatch) => `${issuesText(t, b.moves.length)} · ${moved(b).join(", ")}`,
    releaseTip: (r: OrgActivityLaneRelease) => `${r.version} · ${t(`activity.release.state.${r.state}`).toLowerCase()} ${clock(r.at)} · ${issuesText(t, r.total)}`,
    waitTip: (items: OrgActivityPerson[]) => `${t("activity.wait.count", { n: items.length })} · ${kinds(items).join(", ")}`,
  };
}

/** The decision's answer: the project's Approvals page with it open. */
export const answerHref = (slug: string, p: OrgActivityPerson) => `${approvalsHref(slug)}?peek=${encodeURIComponent(p.decisionId)}`;

function Item({ href, title, tip, after, testId }: { href: string; title: string; tip: string; after?: ReactNode; testId: string }) {
  return (
    <li className="border-t border-line-divider first:border-t-0">
      <Link href={href} title={tip} className="flex items-center gap-2 px-3.5 py-2 text-13 text-fg no-underline hover:bg-hover" data-testid={testId}>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {after ? <span className="flex-none whitespace-nowrap text-11-5 text-muted">{after}</span> : null}
      </Link>
    </li>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5 pb-1">
      {items.map((s) => (
        <span key={s} className="rounded-full bg-sunken px-2 py-0.5 text-12 text-muted">
          {s}
        </span>
      ))}
    </div>
  );
}

function Body({ mark }: { mark: OpenMark }) {
  const w = useMarkWords();
  const { t } = w;
  const slug = mark.project.slug;
  if (mark.kind === "batch") {
    return (
      <>
        <Chips items={w.moved(mark.batch)} />
        <ul className="max-h-72 overflow-auto py-1">
          {mark.batch.moves.map((m) => (
            <Item
              key={m.issueKey}
              href={issueHref(slug, m.issueKey)}
              title={m.title ?? m.issueKey}
              tip={m.issueKey}
              after={`${m.from ? w.status(m.from) : "—"} → ${w.status(m.to)}`}
              testId="mark-pop-item"
            />
          ))}
        </ul>
      </>
    );
  }
  if (mark.kind === "release") {
    const r = mark.release;
    const more = r.total - r.issues.length;
    return (
      <>
        <ul className="max-h-72 overflow-auto py-1">
          {r.issues.map((i) => (
            <Item key={i.key} href={issueHref(slug, i.key)} title={i.title} tip={i.key} testId="mark-pop-item" />
          ))}
          {more > 0 ? <li className="border-t border-line-divider px-3.5 py-2 text-12 text-muted">{t("activity.more", { n: more })}</li> : null}
        </ul>
        <Acts>
          <Act href={releaseHref(slug, r.version)} primary>
            {t("activity.release.open")}
          </Act>
        </Acts>
      </>
    );
  }
  const first = mark.items[0];
  return (
    <>
      <Chips items={w.kinds(mark.items)} />
      <ul className="max-h-72 overflow-auto py-1">
        {mark.items.map((p) => (
          <Item key={p.decisionId} href={answerHref(slug, p)} title={p.title} tip={p.key ? `${p.key} · ${p.title}` : p.title} after={w.kind(p)} testId="mark-pop-item" />
        ))}
        {mark.more > 0 ? <li className="border-t border-line-divider px-3.5 py-2 text-12 text-muted">{t("activity.more", { n: mark.more })}</li> : null}
      </ul>
      <Acts>
        <Act href={approvalsHref(slug)}>{t("activity.wait.openAll")}</Act>
        {first ? (
          <Act href={answerHref(slug, first)} you>
            {t("activity.wait.answerFirst")}
          </Act>
        ) : null}
      </Acts>
    </>
  );
}

function Acts({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 border-t border-line-divider px-3.5 pt-2 pb-3">{children}</div>;
}

function Act({ href, primary = false, you = false, children }: { href: string; primary?: boolean; you?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-md border px-3 py-1 text-12 font-medium no-underline",
        primary ? "border-fg bg-fg text-surface" : you ? "border-warn-9 bg-warn-3 text-warn-11" : "border-line-strong text-fg hover:bg-hover",
      )}
      data-testid="mark-pop-act"
    >
      {children}
    </Link>
  );
}

function headOf(mark: OpenMark, w: ReturnType<typeof useMarkWords>): { title: string; sub: string } {
  const { t } = w;
  const name = mark.project.name;
  if (mark.kind === "batch") {
    return { title: t("activity.batch.moved", { project: name, issues: issuesText(t, mark.batch.moves.length) }), sub: t("activity.batch.around", { time: w.clock(mark.batch.at) }) };
  }
  if (mark.kind === "release") {
    const r = mark.release;
    return { title: `${name} ${r.version}`, sub: `${t(`activity.release.state.${r.state}`)} · ${w.clock(r.at)} · ${issuesText(t, r.total)}` };
  }
  return { title: `${name} · ${t("activity.wait.count", { n: mark.items.length + mark.more })}`, sub: t("activity.wait.since", { time: w.clock(mark.since) }) };
}

/** The open mark's popover, anchored on the mark (or the You count) that opened it; Escape, a click away or × closes it. */
export function MarkPopover({ mark, anchor, onClose }: { mark: OpenMark | null; anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const w = useMarkWords();
  const head = mark ? headOf(mark, w) : null;
  return (
    <Popover open={mark !== null} anchor={anchor} onDismiss={onClose} placement="bottom" gap={10} takesFocus aria-label={head?.title} className="w-96 max-w-full rounded-md" data-testid="mark-pop">
      {mark && head ? (
        <div data-kind={mark.kind}>
          <div className="flex items-start gap-2.5 border-b border-line-divider px-3.5 pt-3 pb-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-14 font-semibold" data-testid="mark-pop-title">
                {head.title}
              </div>
              <div className="mt-0.5 text-12 text-muted">{head.sub}</div>
            </div>
            <button type="button" onClick={onClose} aria-label={w.t("activity.close")} className="rounded-sm p-0.5 text-subtle hover:text-fg">
              <Icon name="x" size={16} />
            </button>
          </div>
          <Body mark={mark} />
        </div>
      ) : null}
    </Popover>
  );
}
