"use client";

import { Badge } from "@/design";
import { useApiPage } from "../hooks";
import { readingOf } from "@/lib/api/refusals";
import { Loading, UnreadNotice } from "./notices";

export function ApiPageScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const reading = readingOf(useApiPage(projectId));
  if (reading.kind === "loading") return <Loading what={`${slug}'s API page`} />;
  if (reading.kind === "unread") return <UnreadNotice what={`${slug}'s API page`} refusals={reading.refusals} />;
  const page = reading.value;
  const ecoName = new Map(page.ecosystems.map((e) => [e.id, e.name]));
  return (
    <div className="space-y-6">
      <section aria-label="Ecosystems" className="space-y-2">
        <h2 className="fg-label text-fg">Ecosystems</h2>
        {page.ecosystems.length === 0 ? (
          <p className="fg-caption">{slug} is an active member of no ecosystem.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {page.ecosystems.map((e) => (
              <li key={e.id}>
                <Badge>
                  {e.name} · members see {e.visibility}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Publishes" className="space-y-2">
        <h2 className="fg-label text-fg">Publishes</h2>
        {!page.declared ? (
          <p className="fg-caption">{slug} has declared no interface.</p>
        ) : page.publishes.length === 0 ? (
          <p className="fg-caption">{slug} publishes no contract.</p>
        ) : (
          <ul className="space-y-2">
            {page.publishes.map((p) => (
              <li key={p.slug} className="min-w-0 rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-13 font-semibold">{p.contract}</span>
                  <Badge>{p.type}</Badge>
                  <Badge tone={p.lifecycle === "deprecated" ? "amber" : "neutral"}>{p.lifecycle}</Badge>
                  <Badge tone="neutral">artifact: {p.artifact}</Badge>
                </div>
                <p className="mt-1 break-words text-13-5">{p.title}</p>
                {p.summary ? <p className="fg-caption mt-1 break-words">{p.summary}</p> : null}
                <p className="fg-caption mt-1 break-words">
                  in {p.ecosystems.map((e) => ecoName.get(e) ?? e).join(", ")} · versions{" "}
                  {p.versions.length > 0 ? p.versions.join(", ") : "none recorded"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Consumes" className="space-y-2">
        <h2 className="fg-label text-fg">Consumes</h2>
        {page.consumes.length === 0 ? (
          <p className="fg-caption">{slug} consumes no contract.</p>
        ) : (
          <ul className="space-y-1">
            {page.consumes.map((c) => (
              <li key={`${c.contract}${c.ecosystem}`} className="break-words text-13">
                <span className="font-mono">{c.contract}</span> · built against {c.builtAgainst} · in{" "}
                {ecoName.get(c.ecosystem) ?? c.ecosystem}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Commitments" className="space-y-2">
        <h2 className="fg-label text-fg">Commitments</h2>
        {page.commitments?.setBy ? (
          <p className="fg-caption" data-testid="commitments-set-by">
            {page.commitments.setBy.agency === "agent"
              ? `Set by ${slug}'s agent on ${page.commitments.setBy.at.slice(0, 10)}; a project admin can overwrite these windows.`
              : `Set by a person on ${page.commitments.setBy.at.slice(0, 10)}.`}
          </p>
        ) : null}
        {page.commitments ? (
          <dl className="grid grid-cols-1 gap-1 text-13 sm:grid-cols-2">
            <dt className="fg-caption">Versioning</dt>
            <dd>{page.commitments.versioning}</dd>
            <dt className="fg-caption">Deprecation notice</dt>
            <dd>{page.commitments.deprecationNoticeDays} days</dd>
            {Object.entries(page.commitments.responseDays).map(([type, days]) => (
              <div key={type} className="contents">
                <dt className="fg-caption">Answers a {type} within</dt>
                <dd>{days} days</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="fg-caption">{slug} has declared no commitments.</p>
        )}
      </section>

      {page.reader.access === "party" ? (
        <p className="fg-caption">
          You read this as a party, through {page.reader.via.flatMap((v) => v.projects).length} of your projects; what is internal to {slug} is not shown.
        </p>
      ) : null}
    </div>
  );
}
