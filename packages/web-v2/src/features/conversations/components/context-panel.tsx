"use client";

import Link from "next/link";
import { ErrorState, Icon, MonoTag, Spinner } from "@/design";
import { useAuth } from "@/providers/auth-provider";
import { formatApiError } from "@/lib/api/error";
import { type RoomContext, type RoomToolCall, RAN_AS_LINE, ranAsOf, roomContext } from "../context";
import { useRoomToolCalls } from "../hooks";

function Section({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="fg-overline text-subtle">{title}</h3>
      {empty ? <p className="fg-caption text-muted">None in this chat yet.</p> : children}
    </section>
  );
}

function CallRow({ call, me }: { call: RoomToolCall; me: string | null }) {
  const ran = ranAsOf(call, me);
  return (
    <li className="rounded-md border border-line bg-surface px-2.5 py-2" data-testid="context-call">
      <div className="flex items-center gap-1.5">
        <span className="fg-body-sm min-w-0 flex-1 truncate font-mono text-fg">{call.name}</span>
        {call.isError && (
          <span className="fg-caption font-semibold text-[color:var(--red-600)]">
            refused{call.refusalCode ? ` (${call.refusalCode})` : ""}
          </span>
        )}
      </div>
      <p className="fg-caption mt-0.5 text-muted" data-ran-as={ran}>
        {RAN_AS_LINE[ran]}
      </p>
      {call.resultPreview && (
        <p className="fg-caption mt-1 line-clamp-3 whitespace-pre-wrap break-words text-subtle">
          {call.resultPreview}
        </p>
      )}
    </li>
  );
}

export function ContextBody({ context, me, slug }: { context: RoomContext; me: string | null; slug: string }) {
  const documents = context.channel.filter((t) => t.kind === "document");
  const holds = context.channel.filter((t) => t.kind === "hold");
  const touchRow = (t: RoomContext["channel"][number]) => (
    <li key={t.key} className="fg-body-sm flex items-center gap-1.5">
      <Icon name={t.kind === "hold" ? "pause" : "mail"} size={13} className="flex-none text-subtle" />
      <span className="min-w-0 flex-1 truncate">
        {t.action} · <span className="font-mono">{t.subject}</span>
      </span>
      {t.refused && (
        <span className="fg-caption text-[color:var(--red-600)]">refused{t.refusalCode ? ` (${t.refusalCode})` : ""}</span>
      )}
    </li>
  );
  return (
    <div className="flex flex-col gap-5">
      <Section title="Sources" empty={context.sources.length === 0}>
        <ul className="flex flex-wrap gap-1.5">
          {context.sources.map((s) => (
            <li key={s.name}>
              <MonoTag hue="neutral">
                {s.name}
                {s.count > 1 ? ` ×${s.count}` : ""}
              </MonoTag>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Tool calls" empty={context.calls.length === 0}>
        <ul className="flex flex-col gap-1.5">
          {context.calls.map((c) => (
            <CallRow key={c.key} call={c} me={me} />
          ))}
        </ul>
      </Section>
      <Section title="Channel documents" empty={documents.length === 0}>
        <ul className="flex flex-col gap-1">{documents.map(touchRow)}</ul>
      </Section>
      <Section title="Holds" empty={holds.length === 0}>
        <ul className="flex flex-col gap-1">{holds.map(touchRow)}</ul>
      </Section>
      <Section title="Linked issues" empty={context.issues.length === 0}>
        <ul className="flex flex-wrap gap-1.5">
          {context.issues.map((ref) => (
            <li key={ref}>
              <Link href={`/projects/${slug}/issues/${ref}`} className="fg-body-sm font-mono text-link hover:underline">
                {ref}
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function ContextPanel({
  conversationId,
  said,
  slug,
}: {
  conversationId: string | null;
  said: number;
  slug: string;
}) {
  const { user } = useAuth();
  const q = useRoomToolCalls(conversationId ?? undefined, said);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="context-panel">
      <header className="flex-none border-b border-line px-4 py-3">
        <h2 className="fg-h3">Context</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!conversationId ? (
          <p className="fg-body-sm text-muted">What this chat reads and writes shows here once it starts.</p>
        ) : q.isError ? (
          <ErrorState
            title="The context could not be read"
            message={formatApiError(q.error)}
            onRetry={() => q.refetch()}
          />
        ) : !q.data ? (
          <p role="status" className="fg-body-sm text-muted">
            <Spinner size={14} /> Reading what this chat used…
          </p>
        ) : (
          <ContextBody context={roomContext(q.data.calls)} me={user?.id ?? null} slug={slug} />
        )}
      </div>
    </div>
  );
}
