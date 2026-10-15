// Each project on the bus, its role in a line, and behind a Technical fold what the ecosystem builder
// read, found and wrote: the steps with their own words, the calls it found, and the modules whose
// links it wrote with each link's guide. None of it is needed to read who uses what.

import { Link } from "@/lib/navigation/router";
import { useEffect, useState } from "react";
import { Badge, Disclosure, enumLabel, ProjectMark, sentenceCase, StatusBadge } from "@/design";
import { readingOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { contractsHref } from "@/lib/routes/contracts";
import {
  type Bus,
  type BusBuilder,
  type BusLink,
  type BusProject,
  callSiteAt,
  type LinkRecord,
  projectMarkProps,
  shortSha,
  type StepStatus,
} from "../bus";
import { useBuilderRun, useLink } from "../hooks";
import { ecosystemRoutes } from "../routes";
import { branchOf, dayOf, technicalAnchor } from "./ecosystem-overview";
import { Loading, UnreadNotice } from "./notices";

type Names = ReadonlyMap<string, string>;

const STEP_TONE: Record<StepStatus, "green" | "red" | "neutral" | "cobalt"> = {
  succeeded: "green",
  failed: "red",
  running: "cobalt",
  skipped: "neutral",
  pending: "neutral",
  superseded: "neutral",
};

/** One line naming what the run read: branch, commit and day, or the storefront. */
function ReadLine({ builder }: { builder: BusBuilder }) {
  const t = useCopy();
  const tr = builder.trigger;
  if (tr.sha === null) return <>{t("ecosystem.projects.readStorefront", { date: dayOf(builder.updatedAt) })}</>;
  const sha = shortSha(tr.sha);
  return (
    <>
      {tr.head
        ? t("ecosystem.projects.readAt", { ref: branchOf(tr.head.ref), sha, date: dayOf(tr.head.readAt) })
        : t("ecosystem.projects.readSha", { sha, date: dayOf(builder.createdAt) })}
    </>
  );
}

function Steps({ builder }: { builder: BusBuilder }) {
  return (
    <ol className="grid gap-2">
      {builder.steps.map((s) => (
        <li key={s.name} className="grid min-w-0 gap-0.5">
          <span className="flex flex-wrap items-center gap-2 text-13">
            <span className="font-mono">{s.name}</span>
            <Badge tone={STEP_TONE[s.status]}>{sentenceCase(s.status)}</Badge>
          </span>
          {s.detail ? <span className="break-words text-12 text-muted">{s.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Findings({ project }: { project: BusProject }) {
  const t = useCopy();
  const reading = readingOf(useBuilderRun(project.id, project.builder?.id));
  const what = t("ecosystem.builder.findingsWhat", { slug: project.slug });
  if (reading.kind === "loading") return <Loading what={what} />;
  if (reading.kind === "unread") return <UnreadNotice what={what} refusals={reading.refusals} />;
  const findings = reading.value.document.findings;
  if (findings.length === 0) return <p className="text-13 text-muted">{t("ecosystem.builder.noCalls")}</p>;
  return (
    <ul className="grid gap-1">
      {findings.map((f) => (
        <li key={`${callSiteAt(f.site)}:${f.site.operation}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-12">
          <StatusBadge family="finding" value={f.classification} />
          <span className="min-w-0 break-all font-mono">{callSiteAt(f.site)}</span>
          <span className="min-w-0 break-all font-mono text-muted">
            {f.classification === "matched" ? f.contract.slug : f.classification === "outside_ecosystem" ? f.host : f.site.operation}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Guide({ record }: { record: LinkRecord }) {
  const t = useCopy();
  const d = record.document;
  return (
    <div className="grid gap-3 text-12">
      <div className="grid gap-1">
        <h5 className="font-semibold text-subtle">{t("ecosystem.link.callSites")}</h5>
        {d.callSites.length === 0 ? <span className="text-muted">{t("ecosystem.link.noCallSites")}</span> : null}
        {d.callSites.map((s) => (
          <span key={`${callSiteAt(s)}:${s.operation}`} className="flex min-w-0 flex-wrap gap-x-3 font-mono">
            <span className="break-all">{callSiteAt(s)}</span>
            <span className="break-all text-muted">{s.operation}</span>
          </span>
        ))}
      </div>
      <div className="grid gap-1">
        <h5 className="font-semibold text-subtle">{t("ecosystem.link.uses")}</h5>
        {d.fieldsUsed.length === 0 ? <span className="text-muted">{t("ecosystem.link.noFields")}</span> : null}
        <span className="flex flex-wrap gap-1">
          {d.fieldsUsed.map((f) => (
            <span key={f} className="rounded-pill bg-sunken px-2 font-mono">
              {f}
            </span>
          ))}
        </span>
      </div>
      {d.outsideContract.length > 0 ? (
        <div className="grid gap-1">
          <h5 className="font-semibold" style={{ color: "var(--status-warn-fg)" }}>
            {t("ecosystem.link.outside", { n: d.outsideContract.length })}
          </h5>
          <span className="text-muted">{t("ecosystem.attention.outsideMeans")}</span>
          {d.outsideContract.map((o) => (
            <span key={o} className="break-all font-mono">
              {o}
            </span>
          ))}
        </div>
      ) : null}
      {d.notes.map((n) => (
        <p key={n} className="break-words">
          {n}
        </p>
      ))}
      <span className="text-muted">
        {d.writtenBy.runId ? t("ecosystem.link.byRun") : t("ecosystem.link.byMaster")} <span className="font-mono">{shortSha(d.writtenBy.sha)}</span> ·{" "}
        {t("ecosystem.link.refreshedAt")} <span className="font-mono">{shortSha(d.refreshedAtSha)}</span>
      </span>
    </div>
  );
}

function LinkGuide({ link }: { link: BusLink }) {
  const t = useCopy();
  const reading = readingOf(useLink(link.consumer, link.id));
  const what = t("ecosystem.link.guideWhat", { consumer: link.module });
  if (reading.kind === "loading") return <Loading what={what} />;
  if (reading.kind === "unread") return <UnreadNotice what={what} refusals={reading.refusals} />;
  return <Guide record={reading.value} />;
}

function Modules({ links }: { links: readonly BusLink[] }) {
  const t = useCopy();
  return (
    <div className="grid">
      {links.map((l) => (
        <Disclosure
          key={l.id}
          title={<span className="font-mono text-13">{l.module}</span>}
          summary={`${l.contract.slug} ${l.pinnedVersion}${l.outsideContract ? ` · ${t("ecosystem.connections.outside", { n: l.outsideContract })}` : ""}`}
        >
          <LinkGuide link={l} />
        </Disclosure>
      ))}
    </div>
  );
}

/** Whether the page's address names this anchor, as a next step's link sets it. */
const linkedTo = (anchor: string) => window.location.hash === `#${anchor}`;

function Technical({ bus, project }: { bus: Bus; project: BusProject }) {
  const t = useCopy();
  const anchor = technicalAnchor(project.slug);
  const [open, setOpen] = useState(() => linkedTo(anchor));
  // a next step on the page links here by its anchor: following it opens the fold and brings it into view
  useEffect(() => {
    const show = () => requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
    if (linkedTo(anchor)) show();
    const follow = () => {
      if (!linkedTo(anchor)) return;
      setOpen(true);
      show();
    };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [anchor]);
  const links = bus.links.filter((l) => l.consumer === project.id);
  const b = project.builder;
  return (
    <div id={anchor} className="scroll-mt-4">
      <Disclosure
        title={t("ecosystem.projects.technical")}
        summary={b ? <ReadLine builder={b} /> : t("ecosystem.builder.noRun")}
        open={open}
        onOpenChange={setOpen}
        testId={`technical-${project.slug}`}
      >
        {b ? (
          <div className="grid gap-4">
            <span className="text-12 text-muted">
              {t("ecosystem.builder.run", { id: b.id })} · {enumLabel("trigger", b.trigger.kind)}
              {b.stepsStale ? t("ecosystem.builder.stale") : ""}
            </span>
            <Steps builder={b} />
            <Disclosure title={t("ecosystem.builder.found")} count={b.findings}>
              <Findings project={project} />
            </Disclosure>
            {links.length > 0 ? (
              <div className="grid gap-1">
                <h4 className="text-13 font-semibold">{t("ecosystem.projects.modules")}</h4>
                <Modules links={links} />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-13 text-muted">{t("ecosystem.builder.noRun")}</p>
        )}
      </Disclosure>
    </div>
  );
}

export function MemberProjects({ bus, mine }: { bus: Bus; mine: Names }) {
  const t = useCopy();
  return (
    <section aria-labelledby="projects" className="grid gap-2" data-testid="projects">
      <h2 id="projects" className="text-14 font-semibold text-fg">
        {t("ecosystem.projects.title")}
      </h2>
      <ul className="grid border-t border-line">
        {bus.projects.map((p) => {
          const publishes = bus.contracts.filter((c) => c.provider === p.id).map((c) => c.slug);
          return (
            <li key={p.id} className="grid gap-1 border-b border-line-subtle pt-2.5">
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <ProjectMark {...projectMarkProps(p.slug)} size={20} />
                <b className="text-14">{p.slug}</b>
                <span className="min-w-0 truncate text-13 text-muted">{p.name}</span>
                {mine.has(p.id) ? (
                  <span className="ml-auto flex gap-3 text-13 font-semibold text-accent-text">
                    <Link href={contractsHref(p.slug)} className="hover:underline">
                      {t("ecosystem.bus.contracts")}
                    </Link>
                    <Link href={ecosystemRoutes.apiPage(p.slug)} className="hover:underline">
                      {t("ecosystem.page.api")}
                    </Link>
                  </span>
                ) : null}
              </span>
              <span className="text-13 text-muted">
                {publishes.length
                  ? t("ecosystem.projects.publishes", { contracts: publishes.join(", ") })
                  : t("ecosystem.projects.publishesNothing")}
              </span>
              <Technical bus={bus} project={p} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
