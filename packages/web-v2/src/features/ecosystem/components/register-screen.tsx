"use client";

import Link from "next/link";
import { Badge, NativeSelect, SegmentedControl } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { useOutbox, useProjectEcosystems, useRegister } from "../hooks";
import { readingOf } from "@/lib/api/refusals";
import { ecosystemRoutes, REGISTER_FILTERS, type RegisterFilter } from "../routes";
import type { RegisterRow } from "../types";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";
import { AuthorLine, HoldLine, type Names, useProjectNames } from "./people";

const FILTER_LABEL: Record<RegisterFilter, string> = {
  all: "All",
  awaiting: "Awaiting",
  overdue: "Overdue",
  held: "Held",
  answered: "Answered",
  closed: "Closed",
};

export const TYPE_LABEL: Record<string, string> = {
  "change-notice": "Change notice",
  acknowledgement: "Acknowledgement",
  rfi: "RFI",
  "change-request": "Change request",
  decision: "Decision",
};

/** The register filter a URL names, or the value it named that is not one. */
export function parseFilter(raw: string | null): { filter: RegisterFilter } | { unknown: string } {
  if (raw === null || raw === "") return { filter: "all" };
  return (REGISTER_FILTERS as readonly string[]).includes(raw)
    ? { filter: raw as RegisterFilter }
    : { unknown: raw };
}

export function RegisterRowCard({
  row,
  slug,
  names,
}: {
  row: RegisterRow;
  slug: string;
  names: Names;
}) {
  const owing = row.recipients.filter((r) => r.status === "awaiting" || r.status === "overdue");
  return (
    <li className="min-w-0 rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link href={ecosystemRoutes.document(slug, row.number)} className="font-mono text-13 font-semibold text-fg hover:underline">
          {row.number}
        </Link>
        <Badge>{TYPE_LABEL[row.type] ?? row.type}</Badge>
        {row.overdue ? <Badge tone="red">Overdue</Badge> : null}
        {row.hold?.action === "hold" ? <Badge tone="amber">Held</Badge> : null}
        {row.state !== "published" ? <Badge tone="neutral">{row.state}</Badge> : null}
      </div>
      <p className="mt-1 break-words text-13-5 text-fg">{row.subject}</p>
      <p className="fg-caption mt-1 break-words">
        {names(row.from)} → {row.to.map(names).join(", ")}
        {row.dueBy ? <> · due {row.dueBy}</> : null}
        {row.publishedAt ? <> · published {formatRelativeTime(row.publishedAt)}</> : null}
      </p>
      {owing.length > 0 ? (
        <p className="fg-caption mt-1 break-words">
          Awaiting a reply from {owing.map((r) => `${names(r.project)}${r.status === "overdue" ? " (overdue)" : ""}`).join(", ")}
        </p>
      ) : null}
      {row.hold?.action === "hold" ? (
        <p className="mt-1 text-13" style={{ color: "var(--amberw-600)" }}>
          <HoldLine hold={row.hold} names={names} />
        </p>
      ) : null}
      <p className="fg-caption mt-1">
        <AuthorLine author={row.authoredBy} />
      </p>
    </li>
  );
}

function Drafts({ projectId, slug }: { projectId: string; slug: string }) {
  const reading = readingOf(useOutbox(projectId));
  if (reading.kind === "loading") return <Loading what="your drafts" />;
  if (reading.kind === "unread") return <UnreadNotice what="This project's drafts" refusals={reading.refusals} />;
  const pending = reading.value.documents.filter((d) =>
    ["draft", "submitted", "returned"].includes(d.document.state),
  );
  if (pending.length === 0) return null;
  return (
    <section aria-label="Not yet published" className="space-y-2">
      <h2 className="fg-label text-fg">Not yet published</h2>
      <ul className="space-y-2">
        {pending.map((d) => (
          <li key={d.id} className="min-w-0 rounded-md border border-dashed border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={ecosystemRoutes.document(slug, d.document.number ?? d.id)} className="font-mono text-13 font-semibold hover:underline">
                {d.document.number ?? "draft"}
              </Link>
              <Badge>{TYPE_LABEL[d.document.type] ?? d.document.type}</Badge>
              <Badge tone={d.document.state === "returned" ? "red" : d.document.state === "submitted" ? "amber" : "neutral"}>
                {d.document.state === "submitted" ? "waiting at the approve gate" : d.document.state}
              </Badge>
            </div>
            <p className="mt-1 break-words text-13-5">{d.document.subject}</p>
            {d.document.state === "returned" && d.document.gate?.note ? (
              <p className="fg-caption mt-1 break-words">Returned: “{d.document.gate.note}”</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RegisterScreen({
  projectId,
  slug,
  rawFilter,
  rawEcosystem,
  onFilter,
  onEcosystem,
}: {
  projectId: string;
  slug: string;
  rawFilter: string | null;
  rawEcosystem: string | null;
  onFilter: (f: RegisterFilter) => void;
  onEcosystem: (id: string) => void;
}) {
  const names = useProjectNames(projectId);
  const parsed = parseFilter(rawFilter);
  const filter = "filter" in parsed ? parsed.filter : "all";
  const ecos = readingOf(useProjectEcosystems(projectId));
  const active =
    ecos.kind === "read"
      ? ecos.value.memberships.filter((m) => m.document.state === "active" && m.ecosystem)
      : [];
  const chosen = active.find((m) => m.ecosystem?.id === rawEcosystem) ?? active[0];
  const unknownEcosystem = rawEcosystem !== null && ecos.kind === "read" && !active.some((m) => m.ecosystem?.id === rawEcosystem);
  const registerQ = useRegister(
    "filter" in parsed && !unknownEcosystem ? chosen?.ecosystem?.id : undefined,
    projectId,
    filter,
  );
  const register = readingOf(registerQ);

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl
            options={REGISTER_FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f] }))}
            value={filter}
            onChange={onFilter}
          />
        </div>
        {active.length > 1 ? (
          <NativeSelect
            aria-label="Ecosystem"
            value={chosen?.ecosystem?.id ?? ""}
            onChange={(e) => onEcosystem(e.target.value)}
            options={active.map((m) => ({ value: m.ecosystem?.id ?? "", label: m.ecosystem?.name ?? "" }))}
          />
        ) : null}
      </div>

      {"unknown" in parsed ? (
        <RefusalNotice
          title="Not a register filter"
          refusals={[
            {
              code: "REGISTER_FILTER_UNKNOWN",
              path: "?status",
              detail: `“${parsed.unknown}” is not one of ${REGISTER_FILTERS.join(", ")}; pick one above.`,
            },
          ]}
        />
      ) : null}
      {unknownEcosystem ? (
        <RefusalNotice
          title="Not one of this project's ecosystems"
          refusals={[
            {
              code: "ECOSYSTEM_NOT_MEMBER",
              path: "?ecosystem",
              detail: `${slug} is not an active member of ecosystem ${rawEcosystem}.`,
            },
          ]}
        />
      ) : null}

      {ecos.kind === "loading" ? <Loading what="this project's ecosystems" /> : null}
      {ecos.kind === "unread" ? (
        <UnreadNotice what="This project's ecosystems" refusals={ecos.refusals} />
      ) : null}
      {ecos.kind === "read" && active.length === 0 ? (
        <p className="fg-caption">
          {slug} is an active member of no ecosystem, so it has no channel. A steward invites it, and an admin of {slug} accepts.
        </p>
      ) : null}

      {chosen && "filter" in parsed && !unknownEcosystem ? (
        <section aria-label="Register" className="space-y-2">
          <h2 className="fg-label text-fg">
            {chosen.ecosystem?.name} · channel {chosen.ecosystem?.channel}
          </h2>
          {register.kind === "loading" ? <Loading what="the register" /> : null}
          {register.kind === "unread" ? <UnreadNotice what="The register" refusals={register.refusals} /> : null}
          {register.kind === "read" ? (
            register.value.documents.length === 0 ? (
              <p className="fg-caption">
                No {filter === "all" ? "" : `${FILTER_LABEL[filter].toLowerCase()} `}documents that {slug} sent or received.
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {register.value.documents.map((row) => (
                    <RegisterRowCard key={row.number} row={row} slug={slug} names={names} />
                  ))}
                </ul>
                {register.value.total > register.value.returned ? (
                  <p className="fg-caption">
                    Showing {register.value.returned} of {register.value.total}; narrow the filter to see the rest.
                  </p>
                ) : null}
              </>
            )
          ) : null}
        </section>
      ) : null}

      <Drafts projectId={projectId} slug={slug} />
    </div>
  );
}
