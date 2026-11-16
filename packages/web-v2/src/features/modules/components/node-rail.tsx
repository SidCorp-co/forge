// The right rail of a module page (ISS-1256): the selected node's other names, its relations by the
// five kinds (belongs to, used in, governs, from, anchored at), each one walking on, and its standing:
// whether it owes a re-check, how often agents read it, who wrote it.

import type { ModuleMapNode, ModuleMapRelationView } from "@forge/contracts/module-map";
import { Fact, FactsGroup, usePaletteSearch } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { moduleHref } from "@/lib/routes/modules";
import { formatStamp } from "@/lib/utils/format";
import { aliasesOf, pathNameOf, pillarOf, relationLinesOf, relationTarget } from "../module-tree";

const LINK = "text-link hover:underline";

function RelationEnd({ rel, slug, here, onSelect }: { rel: ModuleMapRelationView; slug: string; here: ReadonlySet<string>; onSelect: (id: string) => void }) {
  const t = useCopy();
  const search = usePaletteSearch();
  const o = rel.other;
  const code = o.type === "code";
  const text = o.title ?? (code ? o.ref : t("modules.rail.gone"));
  const cls = code ? `font-mono text-12 ${LINK}` : LINK;
  const to = relationTarget(slug, here, rel);
  if (to.kind === "select")
    return (
      <button type="button" className={`${cls} text-left`} onClick={() => onSelect(to.id)} data-testid="rail-relation">
        {text}
      </button>
    );
  if (to.kind === "href")
    return (
      <Link href={to.href} className={cls} data-testid="rail-relation">
        {text}
      </Link>
    );
  if (to.kind === "search" && search)
    return (
      <button type="button" className={`${cls} break-all text-left`} onClick={() => search(to.query)} data-testid="rail-relation">
        {text}
      </button>
    );
  return <span className={code ? "break-all font-mono text-12" : "text-muted"}>{text}</span>;
}

export function NodeRail({
  node,
  slug,
  here,
  names,
  readsDays,
  onSelect,
}: {
  node: ModuleMapNode;
  slug: string;
  /** The nodes this page draws, which a relation selects in place. */
  here: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  readsDays: number;
  onSelect: (id: string) => void;
}) {
  const t = useCopy();
  const aliases = aliasesOf(node);
  const lines = relationLinesOf(node);
  const where = pathNameOf(node.module, names);
  return (
    <div className="grid gap-1" data-testid="node-rail" data-node={`${node.type}:${node.ref}`}>
      <div className="grid gap-1 pb-3">
        <span className="text-11 font-semibold uppercase tracking-wide text-muted">{t(`modules.one.${node.type}` as ProductCopyKey)}</span>
        <h2 className="text-18 font-semibold leading-snug text-fg">{node.title}</h2>
        {node.summary ? <p className="line-clamp-3 text-13 text-muted">{node.summary}</p> : null}
      </div>
      {aliases.length > 0 ? (
        <FactsGroup title={t("modules.rail.aliases")}>
          <span className="flex flex-wrap gap-1.5" data-testid="rail-aliases">
            {aliases.map((a) => (
              <span key={a} className="rounded-sm bg-sunken px-1.5 text-12">
                {a}
              </span>
            ))}
          </span>
        </FactsGroup>
      ) : null}
      <FactsGroup title={t("modules.rail.relations")}>
        <Fact label={t("modules.rail.belongsTo")}>
          <Link href={moduleHref(slug, pillarOf(node.module))} className={LINK}>
            {where || t("modules.rail.gone")}
          </Link>
        </Fact>
        {lines.map((line) => (
          <Fact key={line.label} label={t(`modules.rel.${line.label}`)} testId={`rail-${line.label}`}>
            <span className="grid min-w-0 gap-1">
              {line.relations.map((r) => (
                <RelationEnd key={r.id ?? `${r.other.type}:${r.other.ref}`} rel={r} slug={slug} here={here} onSelect={onSelect} />
              ))}
            </span>
          </Fact>
        ))}
      </FactsGroup>
      <FactsGroup title={t("modules.rail.standing")}>
        <Fact label={t("modules.rail.recheck")} testId="rail-recheck">
          {node.recheck ? (
            <span className="text-warn-11" title={node.recheck.matched.join(", ")}>
              {t("modules.rail.recheckOwed", { when: formatStamp(node.recheck.since) })}
            </span>
          ) : (
            t("modules.rail.current")
          )}
        </Fact>
        <Fact label={t("modules.rail.reads")} testId="rail-reads">
          {node.reads === null ? <span className="text-muted">{t("modules.rail.readsNone")}</span> : <span className="tabular-nums">{t("modules.rail.readsCount", { n: node.reads, days: readsDays })}</span>}
        </Fact>
        {node.writtenBy ? <Fact label={t("modules.rail.writtenBy")}>{t(`modules.agency.${node.writtenBy.agency}`)}</Fact> : null}
        {node.namedBy ? (
          <Fact label={t("modules.rail.namedBy")}>
            <span title={node.namedBy.quote}>{node.namedBy.who}</span>
          </Fact>
        ) : null}
      </FactsGroup>
    </div>
  );
}
