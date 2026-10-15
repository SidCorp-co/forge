import { Link } from "@/lib/navigation/router";
import type { ReactNode } from "react";
import { Badge, StatusBadge, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { contractHref } from "@/lib/routes/contracts";
import { type Bus, type BusProject, shortSha } from "../bus";
import type { Attention, Connection } from "../connections";

type Names = ReadonlyMap<string, string>;

/** The anchor of a project's Technical fold, which a next step opens and scrolls to. */
export const technicalAnchor = (slug: string) => `technical-${slug}`;

export const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

export const dayOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Why a declared use has no link, in the builder's own terms: what it last read, or that nothing has read it. */
export function unfoundReason(consumer: BusProject | undefined, slug: string, t: Copy): string {
  const b = consumer?.builder;
  if (!b) return t("ecosystem.attention.unread", { consumer: slug });
  if (b.steps.some((s) => s.status === "running" || s.status === "pending")) return t("ecosystem.attention.reading");
  if (b.trigger.sha === null) return t("ecosystem.attention.readStorefront", { date: dayOf(b.updatedAt) });
  const head = b.trigger.head;
  const sha = shortSha(b.trigger.sha);
  return head
    ? t("ecosystem.attention.readAt", { ref: branchOf(head.ref), sha, date: dayOf(head.readAt) })
    : t("ecosystem.attention.readSha", { sha, date: dayOf(b.createdAt) });
}

/** The contract's versions page, through a project of the reader's that provides or uses it; none, when neither is the reader's. */
function versionsHref(c: Connection, mine: Names, names: Names): string | null {
  const provider = names.get(c.contract.provider);
  const reader = mine.get(c.contract.provider) ?? mine.get(c.consumer);
  return provider && reader ? contractHref(reader, `${provider}/${c.contract.slug}`) : null;
}

function NextStep({ href, children }: { href: string; children: ReactNode }) {
  const className = "shrink-0 text-13 font-semibold text-accent-text hover:underline";
  return href.startsWith("#") ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

interface Said {
  what: string;
  why: string | null;
  action: { href: string; label: string };
}

function said(a: Attention, bus: Bus, mine: Names, t: Copy): Said {
  const names = new Map(bus.projects.map((p) => [p.id, p.slug]));
  const slug = (id: string) => names.get(id) ?? t("ecosystem.overview.aMember");
  if (a.kind === "builderFailed") {
    return {
      what: t("ecosystem.attention.builderFailed", { project: a.project.slug, step: a.step }),
      why: null,
      action: { href: `#${technicalAnchor(a.project.slug)}`, label: t("ecosystem.attention.seeStep") },
    };
  }
  const c = a.connection;
  const vars = { consumer: slug(c.consumer), provider: slug(c.contract.provider), contract: c.contract.slug };
  const technical = { href: `#${technicalAnchor(vars.consumer)}` };
  const versions = versionsHref(c, mine, names);
  const toVersions = {
    href: versions ?? technical.href,
    label: versions ? t("ecosystem.attention.openVersions", { contract: c.contract.slug }) : t("ecosystem.attention.seeCalls"),
  };
  switch (a.kind) {
    case "breaking":
      return { what: t("ecosystem.attention.breaking", vars), why: null, action: toVersions };
    case "breaks":
      return { what: t("ecosystem.attention.breaks", { ...vars, version: c.latest ?? "" }), why: null, action: toVersions };
    case "behind":
      return {
        what: t("ecosystem.attention.behind", { ...vars, uses: c.uses.join(", "), latest: c.latest ?? "" }),
        why: null,
        action: toVersions,
      };
    case "unfound":
      return {
        what: t("ecosystem.attention.unfound", { ...vars, version: c.declared?.builtAgainst ?? "" }),
        why: unfoundReason(
          bus.projects.find((p) => p.id === c.consumer),
          vars.consumer,
          t,
        ),
        action: { ...technical, label: t("ecosystem.attention.seeRead") },
      };
    case "outside":
      return {
        what: t("ecosystem.attention.outside", { ...vars, n: c.outsideContract }),
        why: t("ecosystem.attention.outsideMeans"),
        action: { ...technical, label: t("ecosystem.attention.seeCalls") },
      };
  }
}

/** First on the page when anything is behind, breaking, unfound or outside its contract; one line when nothing is. */
export function NeedsAttention({ bus, attention, mine }: { bus: Bus; attention: readonly Attention[]; mine: Names }) {
  const t = useCopy();
  return (
    <section aria-labelledby="needs-attention" className="grid gap-2" data-testid="needs-attention">
      <h2 id="needs-attention" className="text-14 font-semibold text-fg">
        {t("ecosystem.attention.title")}
      </h2>
      {attention.length === 0 ? (
        <p className="text-13 text-muted">{t("ecosystem.attention.none")}</p>
      ) : (
        <ul className="grid border-t border-line">
          {attention.map((a) => {
            const s = said(a, bus, mine, t);
            return (
              <li key={a.key} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 border-b border-line-subtle py-2.5">
                <span className="grid min-w-0 flex-1 basis-80 gap-0.5">
                  <span className="text-13 text-fg">{s.what}</span>
                  {s.why ? <span className="text-12 text-muted">{s.why}</span> : null}
                </span>
                <NextStep href={s.action.href}>{s.action.label}</NextStep>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Uses({ c }: { c: Connection }) {
  const t = useCopy();
  if (c.state === "unfound") return <>{t("ecosystem.connections.declared", { version: c.declared?.builtAgainst ?? "" })}</>;
  const versions = c.uses.join(", ");
  return (
    <>
      {c.modules.length === 1
        ? t("ecosystem.connections.modulesOne", { versions })
        : t("ecosystem.connections.modulesMany", { versions, n: c.modules.length })}
    </>
  );
}

function Latest({ c }: { c: Connection }) {
  const t = useCopy();
  return (
    <span className="grid">
      <span className="font-mono">{c.latest ?? t("ecosystem.connections.noVersion")}</span>
      {c.impact === "breaks" ? <span className="text-12 text-danger">{t("ecosystem.connections.breaksIt")}</span> : null}
      {c.impact === "unchecked" && c.state !== "unfound" ? (
        <span className="text-12 text-muted">{t("ecosystem.connections.unchecked")}</span>
      ) : null}
    </span>
  );
}

function State({ c }: { c: Connection }) {
  const t = useCopy();
  return (
    <span className="grid justify-items-start gap-1">
      {c.state === "unfound" ? (
        <Badge tone="neutral">{t("ecosystem.connections.unfound")}</Badge>
      ) : (
        <StatusBadge family="link" value={c.state} />
      )}
      {c.outsideContract > 0 ? (
        <span className="grid text-12">
          <span className="font-medium" style={{ color: "var(--status-warn-fg)" }}>
            {t("ecosystem.connections.outside", { n: c.outsideContract })}
          </span>
          <span className="text-muted">{t("ecosystem.attention.outsideMeans")}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Every connection, one consumer project and one contract a row, however many of its modules call it. */
export function ConnectionsTable({ bus, connections }: { bus: Bus; connections: readonly Connection[] }) {
  const t = useCopy();
  const names = new Map(bus.projects.map((p) => [p.id, p.slug]));
  const slug = (id: string) => names.get(id) ?? t("ecosystem.overview.aMember");
  return (
    <section aria-labelledby="connections" className="grid gap-2" data-testid="connections">
      <h2 id="connections" className="text-14 font-semibold text-fg">
        {t("ecosystem.connections.title")}
      </h2>
      {connections.length === 0 ? (
        <p className="text-13 text-muted">{t("ecosystem.connections.none")}</p>
      ) : (
        <>
          <div className="hidden sm:block">
            <Table aria-label={t("ecosystem.connections.title")}>
              <THead>
                <TR>
                  <TH>{t("ecosystem.connections.consumer")}</TH>
                  <TH>{t("ecosystem.connections.contract")}</TH>
                  <TH>{t("ecosystem.connections.provider")}</TH>
                  <TH>{t("ecosystem.connections.uses")}</TH>
                  <TH>{t("ecosystem.connections.latest")}</TH>
                  <TH>{t("ecosystem.connections.state")}</TH>
                </TR>
              </THead>
              <TBody>
                {connections.map((c) => (
                  <TR key={c.key} data-testid="connection-row">
                    <TD className="font-semibold">{slug(c.consumer)}</TD>
                    <TD className="font-mono">{c.contract.slug}</TD>
                    <TD>{slug(c.contract.provider)}</TD>
                    <TD>
                      <Uses c={c} />
                    </TD>
                    <TD>
                      <Latest c={c} />
                    </TD>
                    <TD>
                      <State c={c} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          <ul className="grid border-t border-line sm:hidden">
            {connections.map((c) => (
              <li key={c.key} className="grid gap-1.5 border-b border-line-subtle py-2.5 text-13" data-testid="connection-item">
                <span className="min-w-0 break-words">
                  <b>{slug(c.consumer)}</b> <span className="text-subtle">→</span> {slug(c.contract.provider)}{" "}
                  <span className="font-mono">{c.contract.slug}</span>
                </span>
                <span className="flex flex-wrap gap-x-4 gap-y-1 text-12 text-muted">
                  <span>
                    {t("ecosystem.connections.uses")} <Uses c={c} />
                  </span>
                  <span className="inline-flex gap-1">
                    {t("ecosystem.connections.latest")} <Latest c={c} />
                  </span>
                </span>
                <State c={c} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
