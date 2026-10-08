"use client";

// The project home's header (journey walk 2026-10-08): what the project is, its business modules
// (the roots of the module tree, owner ruling 2026-10-04: about ten, code directories only on
// drill-down), what is in delivery now, the release live and the one being prepared, and what comes
// next. Flat lines on hairlines, each saying plainly when it has nothing to show.

import type { RoadmapItem } from "@forge/contracts/project-status";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { moduleHref, modulesHref } from "@/lib/routes/modules";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";

/** Business modules a header names before it links to the rest. */
const MODULES_SHOWN = 10;
/** Requirements a line names before it counts the rest. */
const ITEMS_SHOWN = 3;

const LINK = "text-link hover:underline";

export interface OrientationProps {
  slug: string;
  description: string | null;
  /** The project's root modules, its business modules; null while they are read. */
  modules: { id: string; name: string; slug: string | null }[] | null;
  now: RoadmapItem[];
  next: RoadmapItem[];
  live: { version: string; where: string | null } | null;
  draft: { version: string; eta: string | null } | null;
}

function Line({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 border-b border-line-subtle py-2 text-13 max-sm:grid-cols-1" data-testid={`orient-${name}`}>
      <dt className="font-semibold text-subtle">{label}</dt>
      <dd className="m-0 min-w-0 text-fg">{children}</dd>
    </div>
  );
}

function Items({ slug, items }: { slug: string; items: RoadmapItem[] }) {
  const t = useCopy();
  const shown = items.slice(0, ITEMS_SHOWN);
  return (
    <>
      {shown.map((r, i) => (
        <span key={r.key}>
          {i > 0 ? ", " : ""}
          <Link href={requirementHref(slug, r.key)} className={LINK}>{`${r.key} ${r.title}`}</Link>
        </span>
      ))}
      {items.length > shown.length ? <span className="text-muted">{t("dash.orient.more", { n: items.length - shown.length })}</span> : null}
    </>
  );
}

export function ProjectOrientation({ slug, description, modules, now, next, live, draft }: OrientationProps) {
  const t = useCopy();
  const shownModules = (modules ?? []).slice(0, MODULES_SHOWN);
  const moreModules = (modules?.length ?? 0) - shownModules.length;
  return (
    <section aria-label={t("dash.orient.title")} className="grid gap-3" data-testid="project-orientation">
      <p className={`m-0 max-w-[86ch] text-14 leading-relaxed ${description ? "text-fg" : "text-muted"}`} data-testid="orient-description">
        {description ?? t("dash.orient.noDescription")}
      </p>
      <dl className="m-0 border-t border-line-subtle">
        <Line name="modules" label={t("dash.orient.modules")}>
          {modules === null ? (
            <span className="text-muted">…</span>
          ) : shownModules.length === 0 ? (
            <span className="text-muted">
              {t("dash.orient.noModules")}{" "}
              <Link href={modulesHref(slug)} className={LINK}>
                {t("dash.orient.setUpModules")}
              </Link>
            </span>
          ) : (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {shownModules.map((m) => (
                <Link key={m.id} href={moduleHref(slug, m.slug ?? m.id)} className={LINK}>
                  {m.name}
                </Link>
              ))}
              {moreModules > 0 ? (
                <Link href={modulesHref(slug)} className={LINK}>
                  {t("dash.orient.moreModules", { n: moreModules })}
                </Link>
              ) : null}
            </span>
          )}
        </Line>
        <Line name="now" label={t("dash.orient.now")}>
          {now.length === 0 ? (
            <span className="text-muted">{t("dash.orient.nothingNow")}</span>
          ) : (
            <>
              {t("dash.orient.inDelivery", { n: now.length })} <Items slug={slug} items={now} />
            </>
          )}
        </Line>
        <Line name="release" label={t("dash.orient.release")}>
          {!live && !draft ? (
            <span className="text-muted">{t("dash.orient.noRelease")}</span>
          ) : (
            <span className="flex flex-wrap gap-x-3">
              {live ? (
                <Link href={releaseHref(slug, live.version)} className={LINK}>
                  {live.where ? t("dash.orient.liveAt", { version: live.version, where: live.where }) : t("dash.orient.live", { version: live.version })}
                </Link>
              ) : null}
              {draft ? (
                <Link href={releaseHref(slug, draft.version)} className={LINK}>
                  {draft.eta ? t("dash.orient.preparingEta", { version: draft.version, eta: draft.eta }) : t("dash.orient.preparing", { version: draft.version })}
                </Link>
              ) : null}
            </span>
          )}
        </Line>
        <Line name="next" label={t("dash.orient.next")}>
          {next.length === 0 ? <span className="text-muted">{t("dash.orient.nothingNext")}</span> : <Items slug={slug} items={next} />}
        </Line>
      </dl>
    </section>
  );
}
