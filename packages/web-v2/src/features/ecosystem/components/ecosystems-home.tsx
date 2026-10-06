"use client";

import Link from "next/link";
import { Badge, Button, Icon, MonoTag } from "@/design";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { ecosystemApi } from "../api";
import { useChannelWrite, useMyEcosystems } from "../hooks";
import { joinedEcosystems, needsMe } from "../inbox";
import { ecosystemRoutes } from "../routes";
import type { WorkspaceInvitation, WorkspaceRead } from "../types";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";

function Invitation({ inv, read }: { inv: WorkspaceInvitation; read: WorkspaceRead }) {
  const decide = useChannelWrite((verb: "accept" | "decline") => ecosystemApi.decide(inv.membership, verb));
  const eco = read.ecosystems.find((e) => e.id === inv.ecosystem);
  const project = read.projects.find((p) => p.id === inv.project);
  return (
    <li className="grid gap-2 border-b border-line-subtle px-4 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <MonoTag hue="cobalt">{eco?.code ?? "··"}</MonoTag>
        <div className="min-w-0 flex-1 truncate">
          <b>{eco?.name ?? "An ecosystem"}</b> <span className="text-muted">→ {project?.slug ?? "your project"}</span>
        </div>
        <Button size="sm" loading={decide.isPending && decide.variables === "decline"} onClick={() => decide.mutate("decline")}>
          Decline
        </Button>
        <Button size="sm" variant="primary" loading={decide.isPending && decide.variables === "accept"} onClick={() => decide.mutate("accept")}>
          Accept
        </Button>
      </div>
      {decide.isError ? <RefusalNotice refusals={refusalsOf(decide.error)} /> : null}
    </li>
  );
}

function Requests({ read }: { read: WorkspaceRead }) {
  if (read.invitations.length === 0) return null;
  return (
    <section aria-label="Requests to join" className="w-full max-w-[520px] rounded-[10px] border border-line-subtle bg-surface text-left">
      <h2 className="border-b border-line-subtle px-4 py-3 text-14 font-semibold">Requests to join</h2>
      <ul>
        {read.invitations.map((inv) => (
          <Invitation key={inv.membership} inv={inv} read={read} />
        ))}
      </ul>
    </section>
  );
}

const NewButton = () => (
  <Link
    href={ecosystemRoutes.create()}
    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-13 font-semibold text-on-accent"
  >
    <Icon name="plus" size={14} />
    New ecosystem
  </Link>
);

/** `/ecosystems`: the empty state with the requests to join, or the ecosystems the person is in. */
export function EcosystemsHome() {
  const reading = readingOf(useMyEcosystems());
  if (reading.kind === "loading") return <Loading what="your ecosystems" />;
  if (reading.kind === "unread") return <UnreadNotice what="Your ecosystems" refusals={reading.refusals} />;
  const read = reading.value;
  const joined = joinedEcosystems(read);
  if (joined.length === 0) {
    return (
      <div className="grid justify-items-center gap-2.5 px-5 py-[60px] text-center">
        <div className="grid h-[84px] w-[84px] place-items-center rounded-[20px]" style={{ background: "var(--cobalt-50)", color: "var(--cobalt-700)" }}>
          <Icon name="ecosystem" size={40} />
        </div>
        <h1 className="fg-h3">No ecosystem yet</h1>
        <p className="max-w-[44ch] text-muted">Projects from any organization that share contracts and documents.</p>
        <NewButton />
        <div className="mt-2.5 w-full max-w-[520px]">
          <Requests read={read} />
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[22px] font-bold">Ecosystems</h1>
        <span className="ml-auto">
          <NewButton />
        </span>
      </div>
      <ul className="divide-y divide-line-subtle">
        {joined.map((e) => {
          const owed = needsMe(read, e.id);
          return (
            <li key={e.id}>
              <Link href={ecosystemRoutes.ecosystem(e.id)} className="flex items-center gap-3 py-3 hover:bg-hover">
                <MonoTag hue="cobalt">{e.code}</MonoTag>
                <b className="min-w-0 truncate">{e.name}</b>
                {e.steward.name ? <span className="fg-caption truncate">Steward · {e.steward.name}</span> : null}
                {owed > 0 ? (
                  <span className="ml-auto">
                    <Badge tone="accent">{owed}</Badge>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <Requests read={read} />
    </div>
  );
}
