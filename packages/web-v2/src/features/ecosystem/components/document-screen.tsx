"use client";

import Link from "next/link";
import { Badge, enumLabel, StatusBadge, statusReading } from "@/design";
import { AskAboutThis } from "@/features/chat-dock";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatRelativeTime } from "@/lib/utils/format";
import { useDocument, useThread } from "../hooks";
import { readingOf } from "@/lib/api/refusals";
import { ecosystemRoutes } from "../routes";
import { type DocumentEvent, type DocumentView, TYPE_LABEL, type ThreadHold } from "../types";
import { DocumentActions, type Role } from "./document-actions";
import { DocumentBody } from "./document-body";
import { GatePanel } from "./gate-panel";
import { Loading, UnreadNotice } from "./notices";
import { AuthorLine, HoldLine, type Names, PeopleNames, useProjectNames } from "./people";

function EventLine({ e }: { e: DocumentEvent }) {
  const t = useCopy();
  return (
    <li className="min-w-0 break-words text-13">
      <span className="font-semibold">{enumLabel("documentVerb", e.verb)}</span>
      {e.from ? (
        <span className="text-muted">
          {" "}
          {statusReading("document", e.from).label} → {statusReading("document", e.to).label}
        </span>
      ) : (
        <span className="text-muted"> → {statusReading("document", e.to).label}</span>
      )}{" "}
      · <AuthorLine author={e.by as DocumentView["document"]["authoredBy"]} label="" /> ·{" "}
      <span title={e.at}>{formatRelativeTime(e.at)}</span>
      {e.reason ? <span> · “{e.reason}”</span> : null}
      {e.supersededBy ? <span> · {t("ecosystem.doc.replacedBy", { by: e.supersededBy })}</span> : null}
    </li>
  );
}

function Conversation({ projectId, slug, thread, names }: { projectId: string; slug: string; thread: string; names: Names }) {
  const t = useCopy();
  const reading = readingOf(useThread(projectId, thread));
  if (reading.kind === "loading") return <Loading what={t("ecosystem.doc.loadingConversation")} />;
  if (reading.kind === "unread") return <UnreadNotice what={t("ecosystem.doc.conversation", { thread })} refusals={reading.refusals} />;
  const { documents, holds } = reading.value;
  return (
    <section aria-label={t("ecosystem.doc.conversationLabel")} className="space-y-2">
      <h2 className="fg-label text-fg">{t("ecosystem.doc.conversation", { thread })}</h2>
      <ul className="space-y-1">
        {documents.map((d) => (
          <li key={d.id} className="flex min-w-0 flex-wrap items-center gap-2 text-13">
            <Link href={ecosystemRoutes.document(slug, d.document.number ?? d.id)} className="font-mono font-semibold hover:underline">
              {d.document.number ?? t("ecosystem.doc.draft")}
            </Link>
            <Badge>{TYPE_LABEL[d.document.type] ?? d.document.type}</Badge>
            {d.document.state !== "published" ? <StatusBadge family="document" value={d.document.state} /> : null}
            <span className="min-w-0 break-words">{d.document.subject}</span>
          </li>
        ))}
      </ul>
      <h3 className="fg-label text-fg">{t("ecosystem.doc.holds")}</h3>
      {holds.length === 0 ? (
        <p className="fg-caption">{t("ecosystem.doc.noHolds")}</p>
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

function DocumentHeader({ view, slug, docRef, held, names }: { view: DocumentView; slug: string; docRef: string; held: ThreadHold | null; names: Names }) {
  const t = useCopy();
  const d = view.document;
  return (
    <header className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-13 font-semibold">{d.number ?? t("ecosystem.doc.draft")}</span>
        <Badge>{TYPE_LABEL[d.type] ?? d.type}</Badge>
        <StatusBadge family="document" value={d.state} />
        {view.standing?.overdue ? <Badge tone="red">{t("ecosystem.doc.overdue")}</Badge> : null}
        {held ? <Badge tone="amber">{t("ecosystem.pill.held")}</Badge> : null}
        <span className="fg-caption">{view.side === "sender" ? t("ecosystem.doc.sentByYou") : t("ecosystem.doc.sentToYou")}</span>
        <AskAboutThis about={{ kind: "document", ref: d.number ?? docRef }} />
      </div>
      <h2 className="break-words text-16 font-semibold text-fg">{d.subject}</h2>
      <p className="fg-caption break-words">
        {names(d.from)} → {d.to.map(names).join(", ")}
        {d.inReplyTo ? (
          <>
            {" "}· {t("ecosystem.doc.inReplyTo")}{" "}
            <Link href={ecosystemRoutes.document(slug, d.inReplyTo)} className="font-mono hover:underline">
              {d.inReplyTo}
            </Link>
          </>
        ) : null}
        {d.dueBy ? <> · {t("ecosystem.doc.due", { date: d.dueBy })}</> : null}
        {d.publishedAt ? <> · {t("ecosystem.doc.published", { when: formatRelativeTime(d.publishedAt) })}</> : null}
      </p>
      <p className="text-13">
        <AuthorLine author={d.authoredBy} party={d.authoredBy.kind === "agent" ? names(d.from) : undefined} />
      </p>
    </header>
  );
}

function StateNotes({ view, slug, held, names }: { view: DocumentView; slug: string; held: ThreadHold | null; names: Names }) {
  const t = useCopy();
  const d = view.document;
  return (
    <>
      {held ? (
        <div role="status" className="rounded-md border px-3 py-2 text-13" style={{ borderColor: "var(--amber-50)", background: "var(--amberw-50)", color: "var(--amberw-600)" }}>
          {t("ecosystem.doc.held")} <HoldLine hold={held} names={names} />
        </div>
      ) : null}
      {d.state === "withdrawn" ? (
        <p className="text-13" role="status">{t("ecosystem.doc.withdrawn", { reason: d.withdrawnReason ?? "" })}</p>
      ) : null}
      {d.state === "superseded" && d.supersededBy ? (
        <p className="text-13" role="status">
          {t("ecosystem.doc.supersededBy")}{" "}
          <Link href={ecosystemRoutes.document(slug, d.supersededBy)} className="font-mono hover:underline">
            {d.supersededBy}
          </Link>
        </p>
      ) : null}
      {d.state === "returned" && d.gate?.note ? (
        <p className="text-13" role="status">{t("ecosystem.doc.returned", { note: d.gate.note })}</p>
      ) : null}
      {view.standing && view.standing.recipients.length > 0 ? (
        <section aria-label={t("ecosystem.doc.repliesOwed")} className="space-y-1">
          <h2 className="fg-label text-fg">{t("ecosystem.doc.replies")}</h2>
          <ul className="space-y-1">
            {view.standing.recipients.map((r) => (
              <li key={r.project} className="flex flex-wrap items-center gap-2 text-13">
                <span>{names(r.project)}</span>
                <StatusBadge family="replyOwed" value={r.status} />
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
    </>
  );
}

export function DocumentScreen({ projectId, slug, role, docRef }: { projectId: string; slug: string; role: Role; docRef: string }) {
  const t = useCopy();
  const names = useProjectNames(projectId);
  const reading = readingOf(useDocument(projectId, docRef));
  if (reading.kind === "loading") return <Loading what={t("ecosystem.doc.loading", { ref: docRef })} />;
  if (reading.kind === "unread") return <UnreadNotice what={t("ecosystem.doc.unread", { ref: docRef })} refusals={reading.refusals} />;
  const view = reading.value;
  const d = view.document;
  const held = view.hold?.action === "hold" ? view.hold : null;
  return (
    <PeopleNames projectId={projectId}>
      <article className="min-w-0 space-y-4">
        <DocumentHeader view={view} slug={slug} docRef={docRef} held={held} names={names} />
        <StateNotes view={view} slug={slug} held={held} names={names} />

        {view.side === "sender" && d.state === "submitted" ? (
          <GatePanel projectId={projectId} slug={slug} questionId={view.gateQuestionId} />
        ) : null}

        <DocumentActions view={view} projectId={projectId} slug={slug} role={role} />

        <section aria-label={t("ecosystem.doc.content")} className="rounded-md border border-line p-3">
          <DocumentBody body={d.body} />
        </section>

        <section aria-label={t("ecosystem.doc.events")} className="space-y-1">
          <h2 className="fg-label text-fg">{t("ecosystem.doc.events")}</h2>
          <ul className="space-y-1">
            {view.events.map((e) => (
              <EventLine key={`${e.verb}${e.at}`} e={e} />
            ))}
          </ul>
        </section>

        {view.thread ? <Conversation projectId={projectId} slug={slug} thread={view.thread} names={names} /> : null}
      </article>
    </PeopleNames>
  );
}
