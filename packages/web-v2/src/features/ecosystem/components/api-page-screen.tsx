"use client";

import { Badge, EnumBadge, enumLabel } from "@/design";
import { useApiPage } from "../hooks";
import { type ApiPage, typeLabel } from "../types";
import { readingOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { Loading, UnreadNotice } from "./notices";

function PublishesSection({ page, ecoName }: { page: ApiPage; ecoName: Map<string, string> }) {
  const t = useCopy();
  return (
    <section aria-label={t("ecosystem.api.publishes")} className="space-y-2">
      <h2 className="fg-label text-fg">{t("ecosystem.api.publishes")}</h2>
      {!page.declared ? (
        <p className="fg-caption">{t("ecosystem.api.noInterface")}</p>
      ) : page.publishes.length === 0 ? (
        <p className="fg-caption">{t("ecosystem.api.publishesNone")}</p>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {page.publishes.map((p) => (
            <li key={p.slug} className="min-w-0 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-13 font-semibold">{p.contract}</span>
                <EnumBadge family="interfaceType" value={p.type} />
                <EnumBadge family="lifecycle" value={p.lifecycle} />
                <EnumBadge family="artifact" value={p.artifact} />
              </div>
              <p className="mt-1 break-words text-13-5">{p.title}</p>
              {p.summary ? <p className="fg-caption mt-1 break-words">{p.summary}</p> : null}
              <p className="fg-caption mt-1 break-words">
                {t("ecosystem.api.inVersions", {
                  ecosystems: p.ecosystems.map((e) => ecoName.get(e) ?? e).join(", "),
                  versions:
                    p.versions.length > 0
                      ? p.versions
                          .map((v) => (v.approval === "approved" ? v.version : `${v.version} (${v.approval})`))
                          .join(", ")
                      : t("ecosystem.api.versionsNone"),
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommitmentsSection({ page, slug }: { page: ApiPage; slug: string }) {
  const t = useCopy();
  return (
    <section aria-label={t("ecosystem.api.commitments")} className="space-y-2">
      <h2 className="fg-label text-fg">{t("ecosystem.api.commitments")}</h2>
      {page.commitments?.setBy ? (
        <p className="fg-caption" data-testid="commitments-set-by">
          {page.commitments.setBy.agency === "agent"
            ? t("ecosystem.api.setByAgent", { slug, date: page.commitments.setBy.at.slice(0, 10) })
            : t("ecosystem.api.setByPerson", { date: page.commitments.setBy.at.slice(0, 10) })}
        </p>
      ) : null}
      {page.commitments ? (
        <dl className="grid grid-cols-1 gap-1 text-13 sm:grid-cols-2">
          <dt className="fg-caption">{t("ecosystem.api.versioning")}</dt>
          <dd>{enumLabel("versioning", page.commitments.versioning)}</dd>
          <dt className="fg-caption">{t("ecosystem.api.deprecationNotice")}</dt>
          <dd>{t("ecosystem.api.days", { n: page.commitments.deprecationNoticeDays })}</dd>
          {Object.entries(page.commitments.responseDays).map(([type, days]) => (
            <div key={type} className="contents">
              <dt className="fg-caption">{t("ecosystem.api.answersWithin", { type: typeLabel(type, t) })}</dt>
              <dd>{t("ecosystem.api.days", { n: days })}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="fg-caption">{t("ecosystem.api.commitmentsNone")}</p>
      )}
    </section>
  );
}

export function ApiPageScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const reading = readingOf(useApiPage(projectId));
  if (reading.kind === "loading") return <Loading what={t("ecosystem.api.what", { slug })} />;
  if (reading.kind === "unread") return <UnreadNotice what={t("ecosystem.api.what", { slug })} refusals={reading.refusals} />;
  const page = reading.value;
  const ecoName = new Map(page.ecosystems.map((e) => [e.id, e.name]));
  return (
    <div className="space-y-6">
      <section aria-label={t("ecosystem.api.ecosystems")} className="space-y-2">
        <h2 className="fg-label text-fg">{t("ecosystem.api.ecosystems")}</h2>
        {page.ecosystems.length === 0 ? (
          <p className="fg-caption">{t("ecosystem.api.ecosystemsNone")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {page.ecosystems.map((e) => (
              <li key={e.id}>
                <Badge>
                  {t("ecosystem.api.membersSee", { name: e.name, visibility: enumLabel("visibility", e.visibility) })}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PublishesSection page={page} ecoName={ecoName} />

      <section aria-label={t("ecosystem.api.consumes")} className="space-y-2">
        <h2 className="fg-label text-fg">{t("ecosystem.api.consumes")}</h2>
        {page.consumes.length === 0 ? (
          <p className="fg-caption">{t("ecosystem.api.consumesNone")}</p>
        ) : (
          <ul className="space-y-1">
            {page.consumes.map((c) => (
              <li key={`${c.contract}${c.ecosystem}`} className="break-words text-13">
                <span className="font-mono">{c.contract}</span>{" "}
                {t("ecosystem.api.builtAgainst", { version: c.builtAgainst, ecosystem: ecoName.get(c.ecosystem) ?? c.ecosystem })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CommitmentsSection page={page} slug={slug} />

      {page.reader.access === "party" ? (
        <p className="fg-caption">
          {t("ecosystem.api.partyView", {
            n: new Set([...page.reader.via, ...page.reader.offered].flatMap((v) => v.projects)).size,
          })}
        </p>
      ) : null}
    </div>
  );
}
