"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Input, NativeSelect, PageTitle, Tooltip } from "@/design";
import { currentRoundOf } from "@/features/questions/types";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { cn } from "@/lib/utils/cn";
import { ecosystemApi } from "../api";
import { useAnswerGate, useChannelWrite, useGateQuestion, useMyEcosystems } from "../hooks";
import { daysUntil, INBOX_LABEL, INBOX_TIP, type InboxRow, inView, replyDraft } from "../inbox";
import { ecosystemRoutes, INBOX_VIEWS, type InboxView } from "../routes";
import { DOCUMENT_TYPES, TYPE_LABEL, type WorkspaceDraft, type WorkspaceRead } from "../types";
import { ReasonAction } from "./document-actions";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";

export interface ThreadsFilters {
  view: string | null;
  ecosystem: string | null;
  project: string | null;
  type: string | null;
}

const COUNTED: ReadonlySet<InboxView> = new Set(["needs-me", "waiting", "overdue", "held", "working"]);

const REPLY_NOUN: Record<string, string> = {
  "change-notice": "an acknowledgement",
  rfi: "an answer",
  "change-request": "a decision",
};

const SEND_LABEL: Record<string, string> = {
  "change-notice": "Send acknowledgement",
  rfi: "Send answer",
  "change-request": "Send decision",
};

const WRITE_LABEL: Record<string, string> = {
  "change-notice": "Acknowledge",
  rfi: "Answer",
  "change-request": "Decide",
};

type Pill = { text: string; tone: "bad" | "warn" | "info" | "mut" | "ok"; tip?: string };

const PILL_STYLE: Record<Pill["tone"], { background: string; color: string }> = {
  bad: { background: "var(--red-50)", color: "var(--red-600)" },
  warn: { background: "var(--amberw-50)", color: "var(--amberw-600)" },
  info: { background: "var(--cobalt-50)", color: "var(--cobalt-700)" },
  mut: { background: "var(--bg-sunken)", color: "var(--fg-muted)" },
  ok: { background: "var(--green-50)", color: "var(--green-600)" },
};

function StatusPill({ pill }: { pill: Pill }) {
  const el = (
    <span className="inline-flex whitespace-nowrap rounded-pill px-2 py-px text-11-5 font-semibold" style={PILL_STYLE[pill.tone]}>
      {pill.text}
    </span>
  );
  return pill.tip ? <Tooltip label={pill.tip}>{el}</Tooltip> : el;
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

interface Ctx {
  read: WorkspaceRead;
  mine: ReadonlySet<string>;
  slug: (id: string) => string;
}

function pillOf(row: InboxRow, draft: WorkspaceDraft | null, ctx: Ctx): Pill {
  const owesMine = row.owner.some((o) => ctx.mine.has(o));
  if (row.hold?.action === "hold") return { text: "Held", tone: "warn", tip: row.hold.reason ?? "Held: the masters on this thread stop until it is released" };
  if (row.state !== "published") return { text: row.state === "withdrawn" ? "Withdrawn" : "Superseded", tone: "mut" };
  if (owesMine && draft?.state === "submitted") return { text: "Needs approval", tone: "warn", tip: "The reply waits at your project's approve gate" };
  if (row.overdue && row.dueBy) {
    const late = -daysUntil(row.dueBy);
    return { text: `Overdue · ${late} day${late === 1 ? "" : "s"}`, tone: "bad", tip: `Due ${row.dueBy}` };
  }
  if (row.open && owesMine) return row.dueBy ? { text: `Due ${shortDate(row.dueBy)}`, tone: "info", tip: row.dueBy } : { text: "Owed", tone: "info" };
  if (row.open) return { text: `Waiting on ${row.owner.map(ctx.slug).join(", ")}`, tone: "mut" };
  if (row.recipients.some((r) => r.status === "answered")) return { text: "Answered", tone: "ok" };
  return { text: "Notice", tone: "mut", tip: "Owes no reply" };
}

function InlineGate({ projectId, draftId }: { projectId: string; draftId: string }) {
  const reading = readingOf(useGateQuestion(projectId, draftId));
  const answer = useAnswerGate(projectId);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  if (reading.kind === "loading") return <Loading what="the approve gate" />;
  if (reading.kind === "unread") return <UnreadNotice what="The approve gate" refusals={reading.refusals} />;
  const q = reading.value;
  const round = q ? currentRoundOf(q)?.round : undefined;
  if (!q || round === undefined) return <span className="fg-caption">No open gate question waits on it</span>;
  const option = (id: string) => q.options.find((o) => o.id === id);
  const decide = (optionId: string) =>
    answer.mutate({ questionId: q.id, round, optionId, ...(note.trim() ? { note: note.trim() } : {}) });
  return (
    <span className="grid justify-items-end gap-1.5">
      {returning ? (
        <span className="flex gap-1.5">
          <Input aria-label="Why it goes back" placeholder="Why it goes back" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button size="sm" disabled={!note.trim() || option("return")?.locked} loading={answer.isPending} onClick={() => decide("return")}>
            Return
          </Button>
        </span>
      ) : (
        <span className="flex gap-1.5">
          <Button size="sm" disabled={option("return")?.locked} onClick={() => setReturning(true)}>
            Return…
          </Button>
          <Button size="sm" variant="primary" disabled={option("approve")?.locked} loading={answer.isPending} onClick={() => decide("approve")}>
            Approve
          </Button>
        </span>
      )}
      {answer.isError ? <RefusalNotice title="The gate refused that answer" refusals={refusalsOf(answer.error)} /> : null}
    </span>
  );
}

function SendDraft({ projectId, draft, label }: { projectId: string; draft: WorkspaceDraft; label: string }) {
  const submit = useChannelWrite(() => ecosystemApi.submit(projectId, draft.id));
  return (
    <span className="grid justify-items-end gap-1.5">
      <Button size="sm" variant="primary" loading={submit.isPending} onClick={() => submit.mutate(undefined)}>
        {label}
      </Button>
      {submit.isError ? <RefusalNotice refusals={refusalsOf(submit.error)} /> : null}
    </span>
  );
}

function Actions({ row, draft, ctx }: { row: InboxRow; draft: WorkspaceDraft | null; ctx: Ctx }) {
  const owing = row.owner.find((o) => ctx.mine.has(o));
  const party = owing ?? (ctx.mine.has(row.from) ? row.from : row.to.find((t) => ctx.mine.has(t)));
  if (!party) return null;
  const held = row.hold?.action === "hold";
  if (held && row.thread) {
    return (
      <ReasonAction
        label="Release hold"
        confirmLabel="Release"
        reason="optional"
        run={(reason) => ecosystemApi.hold(party, row.thread as string, "release", reason || undefined)}
      />
    );
  }
  if (row.state !== "published" || !row.open) return null;
  if (owing) {
    const slug = ctx.slug(owing);
    if (draft && (draft.state === "draft" || draft.state === "returned")) {
      return (
        <span className="flex flex-wrap justify-end gap-1.5">
          <Link
            href={ecosystemRoutes.compose(slug, { draft: draft.id })}
            className="inline-flex items-center rounded-md border border-line bg-surface px-2.5 py-0.5 text-12 font-semibold text-fg hover:bg-hover"
          >
            Edit
          </Link>
          <SendDraft projectId={owing} draft={draft} label={SEND_LABEL[row.type] ?? "Send"} />
        </span>
      );
    }
    if (draft?.state === "submitted") return <InlineGate projectId={owing} draftId={draft.id} />;
    return (
      <Link
        href={ecosystemRoutes.compose(slug, { inReplyTo: row.number, ecosystem: row.ecosystem })}
        className="inline-flex items-center rounded-md bg-accent px-2.5 py-0.5 text-12 font-semibold text-on-accent"
      >
        {WRITE_LABEL[row.type] ?? "Reply"}
      </Link>
    );
  }
  return row.thread ? (
    <ReasonAction
      label="Hold thread"
      confirmLabel="Hold"
      reason="required"
      run={(reason) => ecosystemApi.hold(party, row.thread as string, "hold", reason)}
    />
  ) : null;
}

// cm:why the line under a row says who is writing the reply only when core holds that reply: an unsent draft from one of the reader's projects; a master's progress beyond it is not served, so no other line is drawn
function MasterLine({ row, draft, ctx }: { row: InboxRow; draft: WorkspaceDraft | null; ctx: Ctx }) {
  if (!draft) return null;
  const who = draft.authoredBy.kind === "agent" ? `${ctx.slug(draft.from)} master` : `${ctx.slug(draft.from)}`;
  const what = REPLY_NOUN[row.type] ?? "a reply";
  const state = draft.state === "submitted" ? " · at the approve gate" : draft.state === "returned" ? " · returned to the writer" : "";
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-12 text-muted">
      <span
        aria-hidden
        className="grid h-[18px] min-w-[18px] flex-none place-items-center rounded-[5px] px-0.5 text-[8.5px] font-bold"
        style={{ background: "var(--cobalt-50)", color: "var(--cobalt-700)" }}
      >
        {ctx.slug(draft.from).slice(0, 2).toUpperCase()}
      </span>
      {draft.state === "draft" && draft.authoredBy.kind === "agent" ? (
        <i className="forge-pulse inline-block h-[7px] w-[7px] flex-none rounded-full" style={{ background: "var(--green-500)" }} />
      ) : null}
      <span className="truncate">
        {who} drafted {what}
        {state}
      </span>
    </span>
  );
}

function Row({ row, ctx }: { row: InboxRow; ctx: Ctx }) {
  const draft = replyDraft(row, ctx.read.drafts);
  const party = [row.from, ...row.to].find((p) => ctx.mine.has(p));
  return (
    <li
      className={cn(
        "grid grid-cols-1 items-center gap-x-3.5 gap-y-1.5 border-b border-line-subtle py-[11px] last:border-b-0 sm:grid-cols-[110px_minmax(0,1fr)_auto]",
        row.hold?.action === "hold" && "opacity-75",
      )}
    >
      <span className="grid gap-0.5">
        <b className="text-12-5">{TYPE_LABEL[row.type] ?? row.type}</b>
        {party ? (
          <Link href={ecosystemRoutes.document(ctx.slug(party), row.number)} className="font-mono text-11 text-subtle hover:underline">
            {row.number}
          </Link>
        ) : (
          <span className="font-mono text-11 text-subtle">{row.number}</span>
        )}
      </span>
      <span className="grid min-w-0 gap-[3px]">
        <b className="truncate text-13-5 font-semibold">{row.subject}</b>
        <span className="fg-caption truncate">
          {ctx.slug(row.from)} → {row.to.map(ctx.slug).join(", ")}
        </span>
        <MasterLine row={row} draft={draft} ctx={ctx} />
      </span>
      <span className="grid justify-items-start gap-1 sm:justify-items-end">
        <StatusPill pill={pillOf(row, draft, ctx)} />
        <Actions row={row} draft={draft} ctx={ctx} />
      </span>
    </li>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <span className="w-[150px]">
      <NativeSelect
        aria-label={label}
        className="py-1 pl-2.5 text-12 font-semibold"
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        options={[{ value: "", label: `${label}: all` }, ...options]}
      />
    </span>
  );
}

function Header({ action }: { action?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <PageTitle className="text-[22px] font-bold">Threads</PageTitle>
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

function ViewBar({
  view,
  filters,
  onParam,
  read,
  count,
}: {
  view: InboxView | null;
  filters: ThreadsFilters;
  onParam: (key: keyof ThreadsFilters, value: string | null) => void;
  read: WorkspaceRead;
  count: (v: InboxView) => number;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {INBOX_VIEWS.map((v) => (
        <Tooltip key={v} label={INBOX_TIP[v]} multiline>
          <button
            type="button"
            aria-pressed={view === v}
            onClick={() => onParam("view", v === "needs-me" ? null : v)}
            className={cn(
              "rounded-pill border px-[11px] py-[3px] text-12-5 font-semibold",
              view === v ? "border-[var(--fg-default)] bg-[var(--fg-default)] text-[var(--bg-surface)]" : "border-line bg-surface text-muted",
            )}
          >
            {INBOX_LABEL[v]}
            {COUNTED.has(v) ? <span className="ml-[3px] tabular-nums opacity-75">{count(v)}</span> : null}
          </button>
        </Tooltip>
      ))}
      <span className="ml-auto flex flex-wrap gap-2">
        <Select label="Type" value={filters.type ?? ""} onChange={(v) => onParam("type", v)} options={DOCUMENT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        <Select
          label="Ecosystem"
          value={filters.ecosystem ?? ""}
          onChange={(v) => onParam("ecosystem", v)}
          options={read.ecosystems.map((e) => ({ value: e.id, label: e.name }))}
        />
        <Select
          label="Project"
          value={filters.project ?? ""}
          onChange={(v) => onParam("project", v)}
          options={read.projects.filter((p) => read.mine.includes(p.id)).map((p) => ({ value: p.id, label: p.slug }))}
        />
      </span>
    </div>
  );
}

export function ThreadsScreen({ filters, onParam }: { filters: ThreadsFilters; onParam: (key: keyof ThreadsFilters, value: string | null) => void }) {
  const reading = readingOf(useMyEcosystems());
  const view: InboxView | null = filters.view === null ? "needs-me" : (INBOX_VIEWS as readonly string[]).includes(filters.view) ? (filters.view as InboxView) : null;
  if (reading.kind === "loading") return <div className="grid gap-4"><Header /><Loading what="your threads" /></div>;
  if (reading.kind === "unread") return <div className="grid gap-4"><Header /><UnreadNotice what="Your threads" refusals={reading.refusals} /></div>;
  const read = reading.value;
  const mine = new Set(read.mine);
  const slugs = new Map(read.projects.map((p) => [p.id, p.slug]));
  const ctx: Ctx = { read, mine, slug: (id) => slugs.get(id) ?? `project ${id.slice(0, 8)}` };
  const scoped = read.threads.filter(
    (r) =>
      (!filters.ecosystem || r.ecosystem === filters.ecosystem) &&
      (!filters.project || r.from === filters.project || r.to.includes(filters.project)) &&
      (!filters.type || r.type === filters.type),
  );
  const count = (v: InboxView) => scoped.filter((r) => inView(v, r, mine, read.drafts)).length;
  const rows = view ? scoped.filter((r) => inView(view, r, mine, read.drafts)) : [];
  const composer = read.projects.find((p) => p.id === (filters.project ?? read.ecosystems[0]?.members[0]));
  return (
    <div className="grid min-w-0 gap-4">
      <Header
        action={
          composer ? (
            <Link
              href={ecosystemRoutes.compose(composer.slug, { ecosystem: filters.ecosystem ?? undefined })}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-13 font-semibold text-on-accent"
            >
              + New document
            </Link>
          ) : undefined
        }
      />
      <ViewBar view={view} filters={filters} onParam={onParam} read={read} count={count} />
      {view === null ? (
        <RefusalNotice
          title="Not a Threads view"
          refusals={[{ code: "INBOX_VIEW_UNKNOWN", path: "?view", detail: `“${filters.view}” is not one of ${INBOX_VIEWS.join(", ")}; pick one above.` }]}
        />
      ) : read.ecosystems.length === 0 ? (
        <p className="fg-caption">None of your projects is in an ecosystem yet, so there is no thread to read.</p>
      ) : rows.length === 0 ? (
        <p className="fg-caption border-t border-line-subtle pt-3">Nothing under {INBOX_LABEL[view]}.</p>
      ) : (
        <ul className="border-t border-line-subtle">
          {rows.map((r) => (
            <Row key={`${r.ecosystem}:${r.number}`} row={r} ctx={ctx} />
          ))}
        </ul>
      )}
    </div>
  );
}
