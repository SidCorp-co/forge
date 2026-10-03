"use client";

import Link from "next/link";
import { EnumBadge, enumLabel, StatusBadge } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { useApiPage, useContract } from "../hooks";
import { readingOf } from "@/lib/api/refusals";
import { ecosystemRoutes } from "../routes";
import type { ApiPage } from "../types";
import { Loading, UnreadNotice } from "./notices";

const contractSlugOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);

function Publishes({ page, slug }: { page: ApiPage; slug: string }) {
  if (!page.declared) return <p className="fg-caption">{slug} has declared no interface, so it publishes no contract.</p>;
  if (page.publishes.length === 0) return <p className="fg-caption">{slug} publishes no contract.</p>;
  return (
    <ul className="space-y-2">
      {page.publishes.map((p) => (
        <li key={p.slug} className="min-w-0 rounded-md border border-line px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={ecosystemRoutes.contract(slug, p.slug)} className="font-mono text-13 font-semibold hover:underline">
              {p.contract}
            </Link>
            <EnumBadge family="interfaceType" value={p.type} />
            <EnumBadge family="lifecycle" value={p.lifecycle} />
          </div>
          <p className="mt-1 break-words text-13-5">{p.title}</p>
          <p className="fg-caption mt-1 break-words">
            {p.versions.length === 0 ? "no version recorded" : `latest ${p.versions[p.versions.length - 1]}`} ·{" "}
            {p.consumers.length === 0
              ? "no consumer"
              : `consumed by ${p.consumers.map((c) => `${c.project?.slug ?? "a project"} (built against ${c.builtAgainst})`).join(", ")}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Consumes({ page, slug }: { page: ApiPage; slug: string }) {
  if (page.consumes.length === 0) return <p className="fg-caption">{slug} consumes no contract.</p>;
  return (
    <ul className="space-y-2">
      {page.consumes.map((c) => (
        <li key={`${c.contract}${c.ecosystem}`} className="min-w-0 rounded-md border border-line px-3 py-2">
          {c.provider ? (
            <Link
              href={ecosystemRoutes.contract(slug, contractSlugOf(c.contract), c.provider.id)}
              className="font-mono text-13 font-semibold hover:underline"
            >
              {c.contract}
            </Link>
          ) : (
            <span className="font-mono text-13 font-semibold">{c.contract}</span>
          )}
          <p className="fg-caption mt-1">built against {c.builtAgainst}</p>
        </li>
      ))}
    </ul>
  );
}

export function ContractsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const reading = readingOf(useApiPage(projectId));
  if (reading.kind === "loading") return <Loading what="this project's contracts" />;
  if (reading.kind === "unread") return <UnreadNotice what="This project's contracts" refusals={reading.refusals} />;
  return (
    <div className="space-y-6">
      <section aria-label="Publishes" className="space-y-2">
        <h2 className="fg-label text-fg">Publishes</h2>
        <Publishes page={reading.value} slug={slug} />
      </section>
      <section aria-label="Consumes" className="space-y-2">
        <h2 className="fg-label text-fg">Consumes</h2>
        <Consumes page={reading.value} slug={slug} />
      </section>
    </div>
  );
}

export function ContractScreen({
  projectId,
  slug,
  contract,
  provider,
}: {
  projectId: string;
  slug: string;
  contract: string;
  provider?: string;
}) {
  const reading = readingOf(useContract(projectId, contract, provider));
  if (reading.kind === "loading") return <Loading what={`contract ${contract}`} />;
  if (reading.kind === "unread") return <UnreadNotice what={`Contract ${contract}`} refusals={reading.refusals} />;
  const { versions, measurements } = reading.value;
  const own = !provider;
  return (
    <div className="space-y-6">
      <p className="fg-caption">
        {own
          ? `${slug}'s own contract.`
          : `Published by ${reading.value.provider?.slug ?? "its provider"}; read as ${slug}, a consumer, so only what the provider published is shown.`}
      </p>
      <section aria-label="Versions" className="space-y-2">
        <h2 className="fg-label text-fg">Versions</h2>
        {versions.length === 0 ? (
          <p className="fg-caption">No version has been recorded.</p>
        ) : (
          <ul className="space-y-2">
            {versions.map((v) => (
              <li key={v.contractVersion} className="min-w-0 rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-13 font-semibold">{v.contractVersion}</span>
                  <StatusBadge family="classification" value={v.diff.classification} />
                  {v.previous ? <span className="fg-caption">after {v.previous}</span> : null}
                  <span className="fg-caption" title={v.observedAt}>
                    observed {formatRelativeTime(v.observedAt)}
                  </span>
                </div>
                {v.diff.changes.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {v.diff.changes.map((c) => (
                      <li key={`${c.element}${c.kind}${c.text}`} className="break-words text-13">
                        <span className="font-mono">{c.element}</span> · {enumLabel("changeKind", c.kind)} ·{" "}
                        <StatusBadge family="changeLevel" value={c.level} /> {c.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Measurements" className="space-y-2">
        <h2 className="fg-label text-fg">Measurements</h2>
        {measurements.length === 0 ? (
          <p className="fg-caption">Nothing has been measured on a deployed branch yet.</p>
        ) : (
          <ul className="space-y-1">
            {measurements.map((m) => (
              <li key={`${m.observedAt}${m.commit ?? ""}`} className="flex min-w-0 flex-wrap items-center gap-2 text-13">
                <StatusBadge family="measurement" value={m.outcome} />
                {m.version ? <span className="font-mono">{m.version}</span> : null}
                <span>{m.environments.join(", ") || "no environment"}</span>
                {own && m.branch ? <span className="fg-caption break-all">{m.branch} @ {m.commit?.slice(0, 8)}</span> : null}
                <span className="fg-caption" title={m.observedAt}>
                  {formatRelativeTime(m.observedAt)}
                </span>
                {own && m.reason ? <span className="w-full break-words fg-caption">{m.reason}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
