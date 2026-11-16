// The ⌘K palette's search (ISS-1256): the one find door over every record type, the same index and
// ranks agents reach by `forge_find`. Hits come grouped by type, faceted by type, module and status,
// each with its path in the module tree; opening one records the read and walks to its node on the
// map, or to where core says the record is read. A search with no hit is a gap core recorded.

import type { FindFacet, FindHit, FindResult } from "@forge/contracts/find";
import { useState } from "react";
import { PaletteGroup, PaletteItem, showToast, useDebounced } from "@/design";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { useRouter } from "@/lib/navigation/router";
import { cn } from "@/lib/utils/cn";
import { FIND_FACETS, type FindFacetName, type FindFilters, findApi, findStatusLabel, hitHeading, NO_FILTERS, toggleFilter, walkHref } from "../find";
import { useFind } from "../hooks";

const typeLabel = (t: Copy, type: string) => t(`modules.type.${type}` as ProductCopyKey);

function Facets({ result, filters, onToggle }: { result: FindResult; filters: FindFilters; onToggle: (f: FindFacetName, v: string) => void }) {
  const t = useCopy();
  const word = useLabel();
  const label = (f: FindFacetName, x: FindFacet) => (f === "type" ? typeLabel(t, x.value) : f === "status" ? findStatusLabel(word, x.value) : x.label);
  return (
    <div className="sticky top-0 z-10 flex flex-wrap gap-x-4 gap-y-1.5 border-b border-line-subtle bg-surface px-3 py-2 text-12" aria-label={t("modules.find.filters")} data-testid="find-facets">
      {FIND_FACETS.map((f) =>
        result.facets[f].length > 0 ? (
          <span key={f} className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-semibold text-muted">{t(`modules.find.facet.${f}`)}</span>
            {result.facets[f].map((x) => {
              const on = filters[f].includes(x.value);
              return (
                <button
                  key={x.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(f, x.value)}
                  className={cn("rounded-sm px-1.5 py-0.5 text-fg hover:bg-hover", on ? "bg-accent-tint text-accent-text" : "bg-sunken")}
                  data-testid={`find-facet-${f}`}
                >
                  {label(f, x)} <span className="tabular-nums text-muted">{x.count}</span>
                </button>
              );
            })}
          </span>
        ) : null,
      )}
    </div>
  );
}

function HitLine({ hit, t }: { hit: FindHit; t: Copy }) {
  const word = useLabel();
  const where = [hit.path[0], hit.path[1]].join(" › ");
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="min-w-0 flex-1 truncate font-medium max-md:basis-full">{hitHeading(hit)}</span>
      <span className="text-12 text-muted" data-testid="find-hit-path">
        {where}
        {hit.status ? ` · ${findStatusLabel(word, hit.status, hit.type)}` : ""}
      </span>
      {hit.match.alias ? <span className="basis-full text-12 text-subtle">{t("modules.find.alias", { alias: hit.match.alias })}</span> : null}
    </span>
  );
}

export function FindResults({ projectId, slug, query, onClose }: { projectId: string; slug: string; query: string; onClose: () => void }) {
  const t = useCopy();
  const router = useRouter();
  const [filters, setFilters] = useState<FindFilters>(NO_FILTERS);
  const q = useFind(projectId, useDebounced(query, 180), filters);
  const result = q.data;

  const open = (hit: FindHit) => {
    const walk = walkHref(slug, hit);
    const read = findApi.open(hit);
    onClose();
    if (walk) {
      router.push(walk);
      read.catch(() => {});
      return;
    }
    read.then(
      (o) => router.push(o.url),
      () => showToast({ title: t("modules.find.openFailed"), tone: "error" }),
    );
  };

  if (!result) {
    return <p className="px-3 py-3 text-13 text-muted">{q.isError ? t("modules.find.failed") : t("modules.find.searching")}</p>;
  }
  return (
    <div data-testid="find-results" aria-busy={q.isFetching}>
      {result.total > 0 ? <Facets result={result} filters={filters} onToggle={(f, v) => setFilters((cur) => toggleFilter(cur, f, v))} /> : null}
      {result.gap ? (
        <p className="px-3 py-3 text-13 text-muted" data-testid="find-gap">
          {t("modules.find.none")}
        </p>
      ) : null}
      {result.groups.map((g) => (
        <PaletteGroup key={g.type} heading={typeLabel(t, g.type)} testId={`find-group-${g.type}`}>
          {g.hits.map((hit) => (
            <PaletteItem key={hit.id} value={`find:${hit.id}`} query={query} onSelect={() => open(hit)} testId="find-hit">
              <HitLine hit={hit} t={t} />
            </PaletteItem>
          ))}
        </PaletteGroup>
      ))}
      {result.degraded && result.total > 0 ? <p className="px-3 pb-1 text-right text-11 text-subtle">{t("modules.find.keywordOnly")}</p> : null}
    </div>
  );
}
