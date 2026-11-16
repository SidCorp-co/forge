// The module map (ISS-1256, mockup MK-11): the Modules screen opens on the pillar, every business
// module's counts per branch with the Unplaced row beneath, and the searches that found nothing; its
// Capabilities view is ISS-1251's capabilities page across every module, the one page there is.
// What fills it is written by agents: core infers nothing and gates nothing.

import { EmptyState, Icon, Kbd, PageTitle, SegmentedControl, useUrlChoice, usePaletteSearch, ViewHeading } from "@/design";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFindGaps, usePillar } from "../hooks";
import { pillarRowsOf } from "../pillar";
import { CapabilitiesBranch } from "./capabilities-branch";
import { PillarTable } from "./pillar-table";

const MAP_VIEWS = ["pillar", "capabilities"] as const;
type MapView = (typeof MAP_VIEWS)[number];

/** The bar's search: the ⌘K palette, the one find door, opened from the map. */
export function MapSearch({ query = "" }: { query?: string }) {
  const t = useCopy();
  const search = usePaletteSearch();
  if (!search) return null;
  return (
    <button
      type="button"
      onClick={() => search(query)}
      className="flex h-8 min-w-0 flex-1 basis-48 items-center gap-2 rounded-md bg-sunken px-2.5 text-13 text-muted hover:bg-hover hover:text-fg md:max-w-sm"
      data-testid="map-search"
    >
      <Icon name="search" size={14} />
      <span className="flex-1 truncate text-left">{t("modules.search")}</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}

/** What was searched and found nothing: a gap the map lacks a name for, each one searched again on a click. */
function Gaps({ projectId }: { projectId: string }) {
  const t = useCopy();
  const search = usePaletteSearch();
  const gaps = useFindGaps(projectId).data?.gaps ?? [];
  if (gaps.length === 0) return null;
  return (
    <section className="px-5 py-4 max-md:px-3" data-testid="find-gaps">
      <ViewHeading>{t("modules.gaps.title")}</ViewHeading>
      <ul className="flex flex-wrap gap-2">
        {gaps.slice(0, 8).map((g) => (
          <li key={g.query}>
            <button type="button" onClick={() => search?.(g.query)} className="rounded-sm bg-sunken px-2 py-0.5 text-13 text-fg hover:bg-hover" data-testid="find-gap-query">
              {g.query} <span className="tabular-nums text-muted">{t("modules.gaps.times", { n: g.searches })}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Pillar({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = usePillar(projectId);
  return (
    <QueryBoundary query={q} loadingLabel={t("modules.loading")} height="50vh" retry="always">
      {(read) =>
        read.modules.length === 0 && read.unplaced.items.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState message={t("modules.empty")} />
          </div>
        ) : (
          <div className="grid content-start">
            <PillarTable rows={pillarRowsOf(slug, read)} />
            <Gaps projectId={projectId} />
          </div>
        )
      }
    </QueryBoundary>
  );
}

export function ModuleMapScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const [view, setView] = useUrlChoice<MapView>("view", MAP_VIEWS, "pillar");
  return (
    <div className="grid min-h-full content-start bg-app" data-testid="module-map">
      {/* the title names the view it shows: the Capabilities view is the capabilities page */}
      <PageTitle>{t(view === "capabilities" ? "modules.view.capabilities" : "modules.title")}</PageTitle>
      <div className="flex flex-wrap items-center gap-3 border-b border-line-subtle bg-surface px-5 py-2.5 max-md:px-3" aria-label={t("modules.views")}>
        <SegmentedControl options={MAP_VIEWS.map((v) => ({ value: v, label: t(`modules.view.${v}`) }))} value={view} onChange={setView} />
        <MapSearch />
      </div>
      {view === "pillar" ? <Pillar projectId={projectId} slug={slug} /> : <CapabilitiesBranch projectId={projectId} />}
    </div>
  );
}
