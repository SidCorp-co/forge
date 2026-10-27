
// The project home's header (journey walk 2026-10-08): what the project is, its business modules
// (the roots of the module tree, owner ruling 2026-10-04: about ten, code directories only on
// drill-down), the requirements in delivery now and what comes next. One line of description, then a
// row of chips each, a count beside its label; each row says plainly when it has nothing to show.
// The release live and the one being prepared are the Dashboard's figures above it.

import type { RoadmapItem } from "@forge/contracts/project-status";
import { Link } from "@/lib/navigation/router";
import type { ReactNode } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { moduleHref, modulesHref } from "@/lib/routes/modules";
import { requirementHref } from "@/lib/routes/requirements";

/** Business modules a header names before it links to the rest. */
const MODULES_SHOWN = 10;
/** Requirements a row names before it counts the rest. */
const ITEMS_SHOWN = 4;

const CHIP = "inline-flex max-w-64 items-center gap-1.5 rounded-sm border border-line-subtle bg-surface px-2 py-0.5 text-12 text-fg hover:bg-hover";

function Line({ name, label, count, children }: { name: string; label: string; count?: number; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-x-4 py-1.5 max-sm:flex-col max-sm:gap-y-1" data-testid={`orient-${name}`}>
      <dt className="w-24 flex-none text-12 font-semibold text-subtle">
        {label}
        {count ? <span className="ml-1.5 font-mono font-normal tabular-nums text-muted">{count}</span> : null}
      </dt>
      <dd className="m-0 flex min-w-0 flex-1 flex-wrap gap-1.5">{children}</dd>
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <span className="text-12 text-muted">{children}</span>;

function Items({ slug, items }: { slug: string; items: RoadmapItem[] }) {
  const t = useCopy();
  const shown = items.slice(0, ITEMS_SHOWN);
  return (
    <>
      {shown.map((r) => (
        <Link key={r.key} href={requirementHref(slug, r.key)} className={CHIP} title={`${r.key} ${r.title}`} aria-label={`${r.key} ${r.title}`}>
          <span className="flex-none font-mono font-semibold text-link">{r.key}</span>
          <span className="truncate">{r.title}</span>
        </Link>
      ))}
      {items.length > shown.length ? <Quiet>{t("dash.orient.moreModules", { n: items.length - shown.length })}</Quiet> : null}
    </>
  );
}

export interface OrientationProps {
  slug: string;
  description: string | null;
  /** The project's root modules, its business modules; null while they are read. */
  modules: { id: string; name: string; slug: string | null }[] | null;
  now: RoadmapItem[];
  next: RoadmapItem[];
}

export function ProjectOrientation({ slug, description, modules, now, next }: OrientationProps) {
  const t = useCopy();
  const shownModules = (modules ?? []).slice(0, MODULES_SHOWN);
  const moreModules = (modules?.length ?? 0) - shownModules.length;
  return (
    <section aria-label={t("dash.orient.title")} className="grid gap-2" data-testid="project-orientation">
      <p className={`m-0 max-w-3xl truncate text-14 ${description ? "text-fg" : "text-muted"}`} title={description ?? undefined} data-testid="orient-description">
        {description ?? t("dash.orient.noDescription")}
      </p>
      <dl className="m-0">
        <Line name="modules" label={t("dash.orient.modules")} count={modules?.length}>
          {modules === null ? (
            <Quiet>…</Quiet>
          ) : shownModules.length === 0 ? (
            <Quiet>
              {t("dash.orient.noModules")}{" "}
              <Link href={modulesHref(slug)} className="text-link hover:underline">
                {t("dash.orient.setUpModules")}
              </Link>
            </Quiet>
          ) : (
            <>
              {shownModules.map((m) => (
                <Link key={m.id} href={moduleHref(slug, m.slug ?? m.id)} className={CHIP}>
                  {m.name}
                </Link>
              ))}
              {moreModules > 0 ? (
                <Link href={modulesHref(slug)} className="text-12 text-link hover:underline">
                  {t("dash.orient.moreModules", { n: moreModules })}
                </Link>
              ) : null}
            </>
          )}
        </Line>
        <Line name="now" label={t("dash.orient.now")} count={now.length}>
          {now.length === 0 ? <Quiet>{t("dash.orient.nothingNow")}</Quiet> : <Items slug={slug} items={now} />}
        </Line>
        <Line name="next" label={t("dash.orient.next")} count={next.length}>
          {next.length === 0 ? <Quiet>{t("dash.orient.nothingNext")}</Quiet> : <Items slug={slug} items={next} />}
        </Line>
      </dl>
    </section>
  );
}
