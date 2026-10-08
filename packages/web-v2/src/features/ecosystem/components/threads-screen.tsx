"use client";

import Link from "next/link";
import { Badge, type BadgeProps, Button, NativeSelect, PageTitle, ProjectMark, SegmentedControl, Tooltip } from "@/design";
import { readingOf, refusalsOf } from "@/lib/api/refusals";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { type Copy, copyLocale } from "@/lib/i18n/product-copy";
import { cn } from "@/lib/utils/cn";
import { ecosystemApi } from "../api";
import { useChannelWrite, useMyEcosystems } from "../hooks";
import { daysUntil, type InboxRow, inboxLabel, inboxTip, inView, replyDraft } from "../inbox";
import { ecosystemRoutes, INBOX_VIEWS, type InboxView } from "../routes";
import { DOCUMENT_TYPES, typeLabel, type WorkspaceDraft, type WorkspaceRead } from "../types";
import { projectMarkProps } from "../bus";
import { ReasonAction } from "./document-actions";
import { InlineGate } from "./gate-panel";
import { Loading, RefusalNotice, UnreadNotice } from "./notices";

export interface ThreadsFilters {
  view: string | null;
  ecosystem: string | null;
  project: string | null;
  type: string | null;
}

const COUNTED: ReadonlySet<InboxView> = new Set(["needs-me", "waiting", "overdue", "held", "working"]);

/** A reply's words by the document type it answers: `ecosystem.<what>.<type>`, else the type-less `…other`. */
const REPLY_TYPES: ReadonlySet<string> = new Set(["change-notice", "rfi", "change-request"]);
const replyWord = (t: Copy, what: "reply" | "send" | "write", type: string) =>
  t(`ecosystem.${what}.${REPLY_TYPES.has(type) ? (type as "rfi") : "other"}`);

type Pill = { text: string; tone: NonNullable<BadgeProps["tone"]>; tip?: string };

function StatusPill({ pill }: { pill: Pill }) {
  const el = <Badge tone={pill.tone}>{pill.text}</Badge>;
  return pill.tip ? <Tooltip label={pill.tip}>{el}</Tooltip> : el;
}

const shortDate = (iso: string, language: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(copyLocale(language), { month: "short", day: "numeric", timeZone: "UTC" });

interface Ctx {
  read: WorkspaceRead;
  mine: ReadonlySet<string>;
  slug: (id: string) => string;
  t: Copy;
  language: string;
}

function pillOf(row: InboxRow, draft: WorkspaceDraft | null, ctx: Ctx): Pill {
  const { t } = ctx;
  const owesMine = row.owner.some((o) => ctx.mine.has(o));
  // a hold's reason is its holder's words, shown as written
  if (row.hold?.action === "hold") return { text: t("ecosystem.pill.held"), tone: "amber", tip: row.hold.reason ?? t("ecosystem.pill.heldTip") };
  if (row.state !== "published") return { text: t(row.state === "withdrawn" ? "ecosystem.pill.withdrawn" : "ecosystem.pill.superseded"), tone: "neutral" };
  if (owesMine && draft?.state === "submitted") return { text: t("ecosystem.pill.needsApproval"), tone: "amber", tip: t("ecosystem.pill.needsApprovalTip") };
  if (row.overdue && row.dueBy) {
    const late = -daysUntil(row.dueBy);
    return { text: late === 1 ? t("ecosystem.pill.overdueOne") : t("ecosystem.pill.overdueMany", { n: late }), tone: "red", tip: t("ecosystem.pill.due", { date: row.dueBy }) };
  }
  if (row.open && owesMine) return row.dueBy ? { text: t("ecosystem.pill.due", { date: shortDate(row.dueBy, ctx.language) }), tone: "cobalt", tip: row.dueBy } : { text: t("ecosystem.pill.owed"), tone: "cobalt" };
  if (row.open) return { text: t("ecosystem.pill.waitingOn", { who: row.owner.map(ctx.slug).join(", ") }), tone: "neutral" };
  if (row.recipients.some((r) => r.status === "answered")) return { text: t("ecosystem.pill.answered"), tone: "green" };
  return { text: t("ecosystem.pill.notice"), tone: "neutral", tip: t("ecosystem.pill.noticeTip") };
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
        label={ctx.t("ecosystem.action.releaseHold")}
        confirmLabel={ctx.t("ecosystem.action.release")}
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
            {ctx.t("ecosystem.action.edit")}
          </Link>
          <SendDraft projectId={owing} draft={draft} label={replyWord(ctx.t, "send", row.type)} />
        </span>
      );
    }
    if (draft?.state === "submitted") return <InlineGate projectId={owing} questionId={draft.gateQuestionId} />;
    return (
      <Link
        href={ecosystemRoutes.compose(slug, { inReplyTo: row.number, ecosystem: row.ecosystem })}
        className="inline-flex items-center rounded-md bg-accent px-2.5 py-0.5 text-12 font-semibold text-on-accent"
      >
        {replyWord(ctx.t, "write", row.type)}
      </Link>
    );
  }
  return row.thread ? (
    <ReasonAction
      label={ctx.t("ecosystem.action.holdThread")}
      confirmLabel={ctx.t("ecosystem.action.hold")}
      reason="required"
      run={(reason) => ecosystemApi.hold(party, row.thread as string, "hold", reason)}
    />
  ) : null;
}

// the line under a row says who is writing the reply only when core holds that reply: an unsent draft from one of the reader's projects; a master's progress beyond it is not served, so no other line is drawn
function MasterLine({ row, draft, ctx }: { row: InboxRow; draft: WorkspaceDraft | null; ctx: Ctx }) {
  if (!draft) return null;
  const { t } = ctx;
  const what = replyWord(t, "reply", row.type);
  const project = ctx.slug(draft.from);
  const drafted = t(draft.authoredBy.kind === "agent" ? "ecosystem.drafted.master" : "ecosystem.drafted.person", { project, what });
  const state = draft.state === "submitted" ? t("ecosystem.drafted.atGate") : draft.state === "returned" ? t("ecosystem.drafted.returned") : "";
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-12 text-muted">
      <ProjectMark {...projectMarkProps(ctx.slug(draft.from))} size={18} />
      {draft.state === "draft" && draft.authoredBy.kind === "agent" ? (
        <i className="forge-pulse inline-block h-[7px] w-[7px] flex-none rounded-full" style={{ background: "var(--green-500)" }} />
      ) : null}
      <span className="truncate">
        {drafted}
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
        <b className="text-12-5">{typeLabel(row.type, ctx.t)}</b>
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
  const t = useCopy();
  return (
    <span className="w-[150px]">
      <NativeSelect
        aria-label={label}
        className="py-1 pl-2.5 text-12 font-semibold"
        value={value}
        onChange={(e) => onChange(e.target.value || null)}
        options={[{ value: "", label: t("ecosystem.threads.filterAll", { label }) }, ...options]}
      />
    </span>
  );
}

function Header({ action }: { action?: React.ReactNode }) {
  const t = useCopy();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <PageTitle className="text-[22px] font-bold">{t("ecosystem.threads.title")}</PageTitle>
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
  const t = useCopy();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <SegmentedControl<InboxView | "">
        value={view ?? ""}
        onChange={(v) => onParam("view", v === "needs-me" ? null : v)}
        options={INBOX_VIEWS.map((v) => ({ value: v, label: inboxLabel(v, t), title: inboxTip(v, t), ...(COUNTED.has(v) ? { count: count(v) } : {}) }))}
      />
      <span className="ml-auto flex flex-wrap gap-2">
        <Select label={t("ecosystem.threads.filter.type")} value={filters.type ?? ""} onChange={(v) => onParam("type", v)} options={DOCUMENT_TYPES.map((d) => ({ value: d, label: typeLabel(d, t) }))} />
        <Select
          label={t("ecosystem.threads.filter.ecosystem")}
          value={filters.ecosystem ?? ""}
          onChange={(v) => onParam("ecosystem", v)}
          options={read.ecosystems.map((e) => ({ value: e.id, label: e.name }))}
        />
        <Select
          label={t("ecosystem.threads.filter.project")}
          value={filters.project ?? ""}
          onChange={(v) => onParam("project", v)}
          options={read.projects.filter((p) => read.mine.includes(p.id)).map((p) => ({ value: p.id, label: p.slug }))}
        />
      </span>
    </div>
  );
}

export function ThreadsScreen({ filters, onParam }: { filters: ThreadsFilters; onParam: (key: keyof ThreadsFilters, value: string | null) => void }) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const reading = readingOf(useMyEcosystems());
  const view: InboxView | null = filters.view === null ? "needs-me" : (INBOX_VIEWS as readonly string[]).includes(filters.view) ? (filters.view as InboxView) : null;
  if (reading.kind === "loading") return <div className="grid gap-4"><Header /><Loading what={t("ecosystem.threads.loading")} /></div>;
  if (reading.kind === "unread") return <div className="grid gap-4"><Header /><UnreadNotice what={t("ecosystem.threads.unread")} refusals={reading.refusals} /></div>;
  const read = reading.value;
  const mine = new Set(read.mine);
  const slugs = new Map(read.projects.map((p) => [p.id, p.slug]));
  const ctx: Ctx = { read, mine, slug: (id) => slugs.get(id) ?? t("ecosystem.threads.unknownProject", { id: id.slice(0, 8) }), t, language };
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
              {t("ecosystem.threads.newDocument")}
            </Link>
          ) : undefined
        }
      />
      <ViewBar view={view} filters={filters} onParam={onParam} read={read} count={count} />
      {view === null ? (
        <RefusalNotice
          title={t("ecosystem.threads.notAView")}
          refusals={[{ code: "INBOX_VIEW_UNKNOWN", path: "?view", detail: t("ecosystem.threads.notAViewDetail", { view: filters.view ?? "", views: INBOX_VIEWS.map((v) => inboxLabel(v, t)).join(", ") }) }]}
        />
      ) : read.ecosystems.length === 0 ? (
        <p className="fg-caption">{t("ecosystem.threads.noEcosystem")}</p>
      ) : rows.length === 0 ? (
        <p className="fg-caption border-t border-line-subtle pt-3">{t("ecosystem.threads.nothingUnder", { view: inboxLabel(view, t) })}</p>
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
