"use client";

import { FEEDBACK_KINDS, FEEDBACK_SEVERITIES, FEEDBACK_TARGET_TYPES } from "@forge/contracts/feedback";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  NativeSelect,
  PageTitle,
  ProjectLoader,
  SegmentedControl,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TopBarActions,
  TR,
  Textarea,
} from "@/design";
import { TONE_META } from "@/design/status";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatRelativeTime } from "@/lib/utils/format";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { useCreateFeedback, useFeedbackList } from "../hooks";
import { feedbackHref } from "../routes";
import type {
  CreateFeedbackRequest,
  FeedbackAttention,
  FeedbackGrouping,
  FeedbackKind,
  FeedbackListResponse,
  FeedbackSeverity,
  FeedbackSummary,
  FeedbackTargetType,
} from "../types";
import { KindBadge, PhaseBadge, SeverityBadge, sentence } from "./badges";
import { RefusalLine } from "./feedback-actions";
import { FeedbackDetailView } from "./feedback-detail";

const GROUPS: { id: FeedbackAttention; label: string; note: string; tone: string }[] = [
  { id: "you", label: "Needs you", note: "Triage it, or confirm the fix you reported", tone: TONE_META.attention.fg },
  { id: "moving", label: "Moving", note: "An issue, revision or requirement carries it", tone: TONE_META.active.fg },
  { id: "others", label: "Someone else’s turn", note: "The reporter confirms the fix", tone: "var(--fg-muted)" },
  { id: "done", label: "Done", note: "Verified or declined", tone: "var(--fg-muted)" },
];

const FUNNEL = [
  ["new", TONE_META.attention.dot],
  ["triaged", TONE_META.attention.dot],
  ["planned", TONE_META.active.dot],
  ["resolved", "var(--paper-300)"],
  ["verified", TONE_META.blocked.dot],
] as const;

/** The table's `.fg-*` type rules are unlayered and beat Tailwind utilities, so the two
 *  cells that differ from them say so inline: an accent key, and a sentence-case group line. */
const KEY_CELL = { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)" } as const;
const GROUP_CELL = { fontFamily: "var(--font-sans)", textTransform: "none", letterSpacing: "normal", color: "var(--fg-default)" } as const;

function Funnel({ rows }: { rows: FeedbackSummary[] }) {
  const n = (p: string) => rows.filter((r) => r.phase === p).length;
  const total = Math.max(1, ...FUNNEL.map(([p]) => n(p)));
  return (
    <div className="grid gap-2 bg-surface px-4 py-3 sm:px-7" data-testid="feedback-funnel">
      <p className="text-12 text-muted">
        <span className="font-semibold text-fg">Triage funnel</span> Every item, counted once
      </p>
      <div className="grid grid-cols-5 gap-3">
        {FUNNEL.map(([p, colour]) => (
          <div key={p} className="grid gap-1">
            <span className="h-2 rounded-xs" style={{ background: colour, opacity: n(p) ? 1 : 0.35, width: `${Math.max(12, (n(p) / total) * 100)}%` }} />
            <span className="text-12 text-muted">{sentence(p)}</span>
            <span className="text-13 font-semibold tabular-nums">{n(p)}</span>
          </div>
        ))}
      </div>
      <p className="text-12 text-muted">
        Off the funnel: Declined {n("declined")} · Reopened {n("reopened")}
      </p>
    </div>
  );
}

function aboutLine(r: FeedbackSummary) {
  const t = r.target;
  return t.type === "screen" ? `Screen “${t.key}”` : `${sentence(t.type)} ${t.key}`;
}

function Row({ r, selected, onOpen }: { r: FeedbackSummary; selected: boolean; onOpen: () => void }) {
  return (
    <TR
      className={cn("cursor-pointer", selected && "bg-active hover:bg-active")}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      aria-selected={selected}
      data-testid="feedback-row"
      data-key={r.key}
    >
      <TD className="whitespace-nowrap" style={KEY_CELL}>
        {r.key}
      </TD>
      <TD className="min-w-0">
        <span className="grid gap-1">
          <span className="truncate font-medium" style={{ color: "var(--fg-default)" }}>
            {r.title}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-12 text-muted">
            <span className="sm:hidden">
              <PhaseBadge phase={r.phase} />
            </span>
            <KindBadge kind={r.kind} />
            <span className="truncate">About {aboutLine(r)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{r.reporter.name ?? "Unknown reporter"}</span>
          </span>
        </span>
      </TD>
      <TD className="hidden sm:table-cell">
        <PhaseBadge phase={r.phase} />
      </TD>
      <TD className="text-13">
        <span className={r.attention === "you" ? "font-semibold" : undefined} style={r.attention === "you" ? { color: TONE_META.attention.fg } : undefined}>
          {r.attention === "you" ? "You · " : ""}
        </span>
        <span className="text-muted">{r.waitingOn}</span>
      </TD>
      <TD className="hidden md:table-cell">
        <SeverityBadge severity={r.severity} />
      </TD>
      <TD className="hidden whitespace-nowrap text-right text-12 text-muted md:table-cell" title={new Date(r.createdAt).toLocaleString()}>
        {formatRelativeTime(r.createdAt)}
      </TD>
    </TR>
  );
}

interface Group {
  id: string;
  label: string;
  note?: string;
  tone: string;
  rows: FeedbackSummary[];
}

function groupsOf(data: FeedbackListResponse, by: FeedbackGrouping, q: string): Group[] {
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? data.feedback.filter((r) => `${r.key} ${r.title} ${r.reporter.name ?? ""}`.toLowerCase().includes(needle))
    : data.feedback;
  if (by === "attention") {
    return GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.attention === g.id) }));
  }
  const order: string[] = [];
  const byTarget = new Map<string, FeedbackSummary[]>();
  for (const r of rows) {
    const id = `${r.target.type}:${r.target.key}`;
    if (!byTarget.has(id)) {
      byTarget.set(id, []);
      order.push(id);
    }
    byTarget.get(id)?.push(r);
  }
  return order.map((id) => {
    const list = byTarget.get(id) ?? [];
    const you = list.filter((r) => r.attention === "you").length;
    return {
      id,
      label: list[0] ? aboutLine(list[0]) : id,
      ...(you ? { note: `Needs you ${you}` } : {}),
      tone: you ? TONE_META.attention.fg : "var(--fg)",
      rows: list,
    };
  });
}

function CreateForm({ projectId, onDone }: { projectId: string; onDone: (key: string) => void }) {
  const create = useCreateFeedback(projectId);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [severity, setSeverity] = useState<FeedbackSeverity>("medium");
  const [targetType, setTargetType] = useState<FeedbackTargetType>("requirement");
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <form
      className="grid max-w-2xl gap-3 bg-surface px-4 py-4 sm:px-7"
      data-testid="feedback-create"
      onSubmit={(e) => {
        e.preventDefault();
        const request: CreateFeedbackRequest = {
          kind,
          severity,
          title: title.trim(),
          ...(body.trim() ? { body } : {}),
          [targetType]: target.trim(),
        };
        create.mutate(request, { onSuccess: (r) => onDone(r.feedback.key) });
      }}
    >
      <Field label="Title" required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[10rem_10rem_minmax(0,1fr)]">
        <Field label="Kind">
          <NativeSelect
            value={kind}
            onChange={(e) => setKind(e.target.value as FeedbackKind)}
            options={FEEDBACK_KINDS.filter((k) => k !== "contract_change").map((k) => ({ value: k, label: sentence(k) }))}
          />
        </Field>
        <Field label="Severity">
          <NativeSelect
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FeedbackSeverity)}
            options={FEEDBACK_SEVERITIES.map((v) => ({ value: v, label: sentence(v) }))}
          />
        </Field>
        <Field label="About" hint="REQ-3, ISS-12, a release version, a workflow flow, or a screen name">
          <span className="flex gap-2">
            <NativeSelect
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as FeedbackTargetType)}
              options={FEEDBACK_TARGET_TYPES.map((t) => ({ value: t, label: sentence(t) }))}
            />
            <Input value={target} onChange={(e) => setTarget(e.target.value)} />
          </span>
        </Field>
      </div>
      <Field label="What happened" hint="On a sensitive project personal data is scrubbed when it is saved">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      </Field>
      <RefusalLine error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={create.isPending} disabled={!title.trim() || !target.trim()}>
          Send feedback
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone("")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function FeedbackScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useFeedbackList(projectId);
  const [peek, setPeek] = useQueryParam("peek");
  const [groupParam, setGroupParam] = useQueryParam("group");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openDone, setOpenDone] = useState(false);
  const grouping: FeedbackGrouping = groupParam === "subject" ? "subject" : "attention";
  const groups = useMemo(() => (q.data ? groupsOf(q.data, grouping, search) : []), [q.data, grouping, search]);

  const title = (
    <>
      <PageTitle>Feedback</PageTitle>
      <TopBarActions>
        <Button type="button" variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
          Feedback
        </Button>
      </TopBarActions>
    </>
  );
  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ProjectLoader label="loading feedback…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {title}
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  const rows = q.data.feedback;
  const open = peek && rows.some((r) => r.key === peek) ? peek : null;
  return (
    <div className="grid content-start" data-testid="feedback-screen">
      {title}
      {creating ? (
        <CreateForm
          projectId={projectId}
          onDone={(key) => {
            setCreating(false);
            if (key) setPeek(key);
          }}
        />
      ) : null}
      <div className={cn("grid min-h-[60vh]", open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]")}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 bg-surface px-4 py-3 sm:px-7">
            <span className="text-12 text-muted">Group</span>
            <SegmentedControl<FeedbackGrouping>
              options={[
                { value: "attention", label: "Attention" },
                { value: "subject", label: "Subject" },
              ]}
              value={grouping}
              onChange={(v) => setGroupParam(v === "attention" ? null : v)}
            />
            <div className="w-full max-w-xs">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search feedback…" aria-label="Search feedback" />
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-10 sm:px-7">
              <EmptyState title="No feedback yet" message="Feedback is what a BA, a tester or a user says about a requirement, an issue, a release, a workflow or a screen." />
            </div>
          ) : (
            <>
              <Funnel rows={rows} />
              <Table flush aria-label="Feedback">
                <THead className="bg-sunken">
                  <tr>
                    <TH className="w-20">Key</TH>
                    <TH>Title</TH>
                    <TH className="hidden w-28 sm:table-cell">State</TH>
                    <TH>Waiting on</TH>
                    <TH className="hidden w-24 md:table-cell">Severity</TH>
                    <TH className="hidden w-16 text-right md:table-cell">Age</TH>
                  </tr>
                </THead>
                <TBody>
                  {groups.map((g) => {
                    const collapsed = g.id === "done" && !openDone;
                    return (
                      <Fragment key={g.id}>
                        <TR className="bg-sunken hover:bg-sunken" data-testid="feedback-group">
                          <TH scope="colgroup" colSpan={6} className="text-left" style={GROUP_CELL}>
                            <button
                              type="button"
                              className="flex items-baseline gap-2"
                              onClick={() => g.id === "done" && setOpenDone((v) => !v)}
                              aria-expanded={!collapsed}
                            >
                              <span className="text-13 font-semibold" style={{ color: g.tone }}>
                                {g.label}
                              </span>
                              <span className="text-12 font-semibold tabular-nums">{g.rows.length}</span>
                              {g.note ? <span className="text-12 font-normal text-muted">{g.note}</span> : null}
                            </button>
                          </TH>
                        </TR>
                        {collapsed
                          ? null
                          : g.rows.map((r) => (
                              <Row key={r.id} r={r} selected={r.key === open} onOpen={() => setPeek(r.key === open ? null : r.key)} />
                            ))}
                      </Fragment>
                    );
                  })}
                </TBody>
              </Table>
            </>
          )}
        </div>
        {open ? (
          <aside
            className="fixed inset-0 z-30 overflow-y-auto bg-surface px-5 py-5 lg:static lg:inset-auto lg:z-auto lg:border-l lg:border-line"
            aria-label={`${open} summary`}
            data-testid="feedback-peek"
          >
            <FeedbackDetailView
              key={open}
              projectId={projectId}
              slug={slug}
              fbKey={open}
              full={false}
              head={
                <>
                  <Link href={feedbackHref(slug, open)} className="text-12 font-semibold text-accent hover:underline">
                    Open full page
                  </Link>
                  <IconButton icon="x" size="sm" aria-label="Close" onClick={() => setPeek(null)} />
                </>
              }
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
