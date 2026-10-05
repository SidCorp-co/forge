"use client";

import { ProjectMark, StatusBadge, Tooltip } from "@/design";
import { readingOf } from "@/lib/api/refusals";
import { formatRelativeTime } from "@/lib/utils/format";
import { type Bus, callSiteAt, type LinkRecord, STATE_MEANING, shortSha, slugsOf, projectMarkProps } from "../bus";
import { useLink } from "../hooks";
import { Caption, Group, Head } from "./bus-detail-kit";
import { Loading, UnreadNotice } from "./notices";

export function LinkDetail({ bus, id }: { bus: Bus; id: string }) {
  const l = bus.links.find((x) => x.id === id);
  const reading = readingOf(useLink(l?.consumer, l?.id));
  if (!l) return <Caption>That link is no longer on this ecosystem&apos;s bus.</Caption>;
  const consumer = slugsOf(bus).get(l.consumer) ?? "a member";
  return (
    <>
      <Head>
        <ProjectMark {...projectMarkProps(consumer)} size={22} />
        <h2 className="text-15 font-semibold">
          {consumer} <span className="text-subtle">→</span> <span className="font-mono">{l.contract.slug}</span>
        </h2>
        <Tooltip label={STATE_MEANING[l.state]}>
          <StatusBadge family="link" value={l.state} />
        </Tooltip>
        <Tooltip label={`Only ${consumer}'s master writes this link · updated ${new Date(l.updatedAt).toLocaleString()}`}>
          <span className="fg-caption">
            {l.module} · on {l.pinnedVersion} · {formatRelativeTime(l.updatedAt)}
          </span>
        </Tooltip>
      </Head>
      {reading.kind === "loading" ? (
        <div className="col-span-full px-4">
          <Loading what="this link's guide" />
        </div>
      ) : null}
      {reading.kind === "unread" ? (
        <div className="col-span-full px-4 pb-3">
          <UnreadNotice what={`${consumer}'s guide for this link`} refusals={reading.refusals} />
        </div>
      ) : null}
      {reading.kind === "read" ? <Guide record={reading.value} /> : null}
    </>
  );
}

function UsesGroup({ d }: { d: LinkRecord["document"] }) {
  return (
    <Group title="Uses">
      {d.fieldsUsed.length === 0 ? (
        <Caption>No field is recorded.</Caption>
      ) : (
        <div className="flex flex-wrap gap-1">
          {d.fieldsUsed.map((f) => (
            <span key={f} className="rounded-pill bg-[var(--bg-sunken)] px-2 font-mono text-11">
              {f}
            </span>
          ))}
        </div>
      )}
      {d.outsideContract.length > 0 ? (
        <>
          <h4 className="pt-2 text-11 font-semibold uppercase tracking-[0.07em]" style={{ color: "var(--amberw-600)" }}>
            Outside the contract
          </h4>
          {d.outsideContract.map((o) => (
            <Tooltip key={o} label="The contract does not publish this, so a provider change here breaks the consumer without notice" multiline>
              <span className="font-mono text-11-5" style={{ color: "var(--amberw-600)" }}>
                {o}
              </span>
            </Tooltip>
          ))}
        </>
      ) : null}
    </Group>
  );
}

function Guide({ record }: { record: LinkRecord }) {
  const d = record.document;
  return (
    <>
      <Group title="Call sites" aside={d.callSites.length || undefined}>
        {d.callSites.length === 0 ? (
          <Caption>No call site is recorded.</Caption>
        ) : (
          d.callSites.map((s) => (
            <div key={`${callSiteAt(s)}:${s.operation}`} className="flex min-w-0 justify-between gap-2 font-mono text-11-5">
              <span className="truncate" style={{ color: "var(--cobalt-700)" }}>
                {callSiteAt(s)}
              </span>
              <span className="truncate">{s.operation}</span>
            </div>
          ))
        )}
      </Group>
      <UsesGroup d={d} />
      <Group title="Notes">
        {d.notes.length === 0 ? (
          <Caption>The guide holds no notes.</Caption>
        ) : (
          d.notes.map((n) => (
            <p key={n} className="break-words text-13">
              {n}
            </p>
          ))
        )}
      </Group>
      <Group title="Written by">
        <Tooltip label={`Run ${d.writtenBy.runId ?? "not recorded"} · session ${d.writtenBy.sessionId ?? "not recorded"} · revision ${record.revision}`} multiline>
          <span className="text-13">
            {d.writtenBy.runId ? "a master run" : "its master"} at <span className="font-mono">{shortSha(d.writtenBy.sha)}</span>
          </span>
        </Tooltip>
        <span className="text-13">
          refreshed at <span className="font-mono">{shortSha(d.refreshedAtSha)}</span>
        </span>
        <Tooltip label="The provider's current version of the contract, as it recorded it">
          <span className="fg-caption">
            pins {d.pinnedVersion}
            {record.currentVersion && record.currentVersion !== d.pinnedVersion ? `, current ${record.currentVersion}` : ""}
          </span>
        </Tooltip>
      </Group>
    </>
  );
}
