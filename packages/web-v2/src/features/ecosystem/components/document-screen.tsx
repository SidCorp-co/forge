"use client";

import Link from "next/link";
import { Badge } from "@/design";
import { AskAboutThis } from "@/features/conversations/components/ask-about-this";
import { formatRelativeTime } from "@/lib/utils/format";
import { useDocument, useThread } from "../hooks";
import { readingOf } from "@/lib/api/refusals";
import { ecosystemRoutes } from "../routes";
import type { DocumentEvent, DocumentView } from "../types";
import { DocumentActions, type Role } from "./document-actions";
import { DocumentBody } from "./document-body";
import { GatePanel } from "./gate-panel";
import { Loading, UnreadNotice } from "./notices";
import { AuthorLine, HoldLine, type Names, useProjectNames } from "./people";
import { TYPE_LABEL } from "./register-screen";

const STATUS_TEXT: Record<string, string> = {
  awaiting: "awaiting a reply",
  answered: "answered",
  overdue: "overdue",
  "not-owed": "owes no reply",
};

function EventLine({ e }: { e: DocumentEvent }) {
  return (
    <li className="min-w-0 break-words text-13">
      <span className="font-semibold">{e.verb}</span>
      {e.from ? (
        <span className="text-muted">
          {" "}
          {e.from} → {e.to}
        </span>
      ) : (
        <span className="text-muted"> → {e.to}</span>
      )}{" "}
      · <AuthorLine author={e.by as DocumentView["document"]["authoredBy"]} label="" /> ·{" "}
      <span title={e.at}>{formatRelativeTime(e.at)}</span>
      {e.reason ? <span> · “{e.reason}”</span> : null}
      {e.supersededBy ? <span> · replaced by {e.supersededBy}</span> : null}
    </li>
  );
}

function Conversation({ projectId, slug, thread, names }: { projectId: string; slug: string; thread: string; names: Names }) {
  const reading = readingOf(useThread(projectId, thread));
  if (reading.kind === "loading") return <Loading what="the conversation" />;
  if (reading.kind === "unread") return <UnreadNotice what={`Conversation ${thread}`} refusals={reading.refusals} />;
  const { documents, holds } = reading.value;
  return (
    <section aria-label="Conversation" className="space-y-2">
      <h2 className="fg-label text-fg">Conversation {thread}</h2>
      <ul className="space-y-1">
        {documents.map((d) => (
          <li key={d.id} className="flex min-w-0 flex-wrap items-center gap-2 text-13">
            <Link href={ecosystemRoutes.document(slug, d.document.number ?? d.id)} className="font-mono font-semibold hover:underline">
              {d.document.number ?? "draft"}
            </Link>
            <Badge>{TYPE_LABEL[d.document.type] ?? d.document.type}</Badge>
            {d.document.state !== "published" ? <Badge tone="neutral">{d.document.state}</Badge> : null}
            <span className="min-w-0 break-words">{d.document.subject}</span>
          </li>
        ))}
      </ul>
      <h3 className="fg-label text-fg">Holds</h3>
      {holds.length === 0 ? (
        <p className="fg-caption">Nobody has held this conversation.</p>
      ) : (
        <ul className="space-y-1">
          {holds.map((h) => (
            <li key={h.id} className="text-13">
              <HoldLine hold={h} names={names} /> · <span title={h.at}>{formatRelativeTime(h.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DocumentScreen({
  projectId,
  slug,
  role,
  docRef,
}: {
  projectId: string;
  slug: string;
  role: Role;
  docRef: string;
}) {
  const names = useProjectNames(projectId);
  const reading = readingOf(useDocument(projectId, docRef));
  if (reading.kind === "loading") return <Loading what={`document ${docRef}`} />;
  if (reading.kind === "unread") return <UnreadNotice what={`Document ${docRef}`} refusals={reading.refusals} />;
  const view = reading.value;
  const d = view.document;
  const held = view.hold?.action === "hold" ? view.hold : null;
  return (
    <article className="min-w-0 space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-13 font-semibold">{d.number ?? "draft"}</span>
          <Badge>{TYPE_LABEL[d.type] ?? d.type}</Badge>
          <Badge tone={d.state === "published" ? "green" : d.state === "returned" ? "red" : "neutral"}>{d.state}</Badge>
          {view.standing?.overdue ? <Badge tone="red">Overdue</Badge> : null}
          {held ? <Badge tone="amber">Held</Badge> : null}
          <span className="fg-caption">{view.side === "sender" ? "you sent this" : "sent to you"}</span>
          <AskAboutThis slug={slug} kind="document" refId={d.number ?? docRef} />
        </div>
        <h2 className="break-words text-16 font-semibold text-fg">{d.subject}</h2>
        <p className="fg-caption break-words">
          {names(d.from)} → {d.to.map(names).join(", ")}
          {d.inReplyTo ? (
            <>
              {" "}· in reply to{" "}
              <Link href={ecosystemRoutes.document(slug, d.inReplyTo)} className="font-mono hover:underline">
                {d.inReplyTo}
              </Link>
            </>
          ) : null}
          {d.dueBy ? <> · due {d.dueBy}</> : null}
          {d.publishedAt ? <> · published {formatRelativeTime(d.publishedAt)}</> : null}
        </p>
        <p className="text-13">
          <AuthorLine author={d.authoredBy} />
        </p>
      </header>

      {held ? (
        <div role="status" className="rounded-md border px-3 py-2 text-13" style={{ borderColor: "var(--amber-50)", background: "var(--amberw-50)", color: "var(--amberw-600)" }}>
          This conversation is held: no agent adds to it until a person releases it. <HoldLine hold={held} names={names} />
        </div>
      ) : null}
      {d.state === "withdrawn" ? (
        <p className="text-13" role="status">Withdrawn: “{d.withdrawnReason}”</p>
      ) : null}
      {d.state === "superseded" && d.supersededBy ? (
        <p className="text-13" role="status">
          Superseded by{" "}
          <Link href={ecosystemRoutes.document(slug, d.supersededBy)} className="font-mono hover:underline">
            {d.supersededBy}
          </Link>
        </p>
      ) : null}
      {d.state === "returned" && d.gate?.note ? (
        <p className="text-13" role="status">Returned at the gate: “{d.gate.note}”</p>
      ) : null}

      {view.standing && view.standing.recipients.length > 0 ? (
        <section aria-label="Replies owed" className="space-y-1">
          <h2 className="fg-label text-fg">Replies</h2>
          <ul className="space-y-1">
            {view.standing.recipients.map((r) => (
              <li key={r.project} className="flex flex-wrap items-center gap-2 text-13">
                <span>{names(r.project)}</span>
                <Badge tone={r.status === "overdue" ? "red" : r.status === "answered" ? "green" : r.status === "awaiting" ? "amber" : "neutral"}>
                  {STATUS_TEXT[r.status] ?? r.status}
                </Badge>
                {r.answeredBy ? (
                  <Link href={ecosystemRoutes.document(slug, r.answeredBy)} className="font-mono hover:underline">
                    {r.answeredBy}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.side === "sender" && d.state === "submitted" ? (
        <GatePanel projectId={projectId} slug={slug} documentId={view.id} />
      ) : null}

      <DocumentActions view={view} projectId={projectId} slug={slug} role={role} />

      <section aria-label="Content" className="rounded-md border border-line p-3">
        <DocumentBody body={d.body} />
      </section>

      <section aria-label="Events" className="space-y-1">
        <h2 className="fg-label text-fg">Events</h2>
        <ul className="space-y-1">
          {view.events.map((e) => (
            <EventLine key={`${e.verb}${e.at}`} e={e} />
          ))}
        </ul>
      </section>

      {view.thread ? <Conversation projectId={projectId} slug={slug} thread={view.thread} names={names} /> : null}
    </article>
  );
}
