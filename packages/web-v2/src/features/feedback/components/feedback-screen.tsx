"use client";

// The Feedback list (`forge-prototype.html` #/feedback): the grouping in the top header, a search,
// the triage funnel, then the shared GroupedList — the same columns as Requirements and Issues — by
// whose turn it is or by what each item is about. Whose turn comes from core's read model
// (`feedback/read.ts`); the URL carries the view (`?group=…&q=…&peek=FB-n`).

import { FEEDBACK_ATTENTION, FEEDBACK_ATTENTION_LABELS, FEEDBACK_KINDS, FEEDBACK_PHASE_TONES, FEEDBACK_SEVERITIES, FEEDBACK_TARGET_TYPES } from "@forge/contracts/feedback";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  ActorChip,
  Button,
  EmptyState,
  enumLabel,
  ErrorState,
  Field,
  GroupedList,
  Icon,
  Input,
  LEGEND,
  type ListGroup,
  type ListRowView,
  NativeSelect,
  PageTitle,
  ProjectLoader,
  rememberListOrigin,
  StatusBadge,
  statusReading,
  Textarea,
  TopBarActions,
  useGroupFold,
  usePeek,
  usePeekKeys,
  useUrlParams,
  useViewMode,
  ViewModeSwitcher,
  visibleRows,
  WaitingOn,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { formatAge, formatStamp } from "@/lib/utils/format";
import { useCreateFeedback, useFeedbackList } from "../hooks";
import { FEEDBACK_LIST, feedbackHref } from "../routes";
import type { CreateFeedbackRequest, FeedbackKind, FeedbackSeverity, FeedbackSummary, FeedbackTargetType } from "../types";
import { RefusalLine } from "./feedback-actions";
import { FeedbackPeek } from "./feedback-peek";

const FUNNEL = ["new", "triaged", "planned", "resolved", "verified"] as const;

function Funnel({ rows }: { rows: FeedbackSummary[] }) {
  const n = (p: string) => rows.filter((r) => r.phase === p).length;
  const total = Math.max(1, ...FUNNEL.map((p) => n(p)));
  return (
    <div className="grid gap-2 border-b border-line-subtle bg-surface px-5 py-3 max-md:px-3" data-testid="feedback-funnel">
      <p className="text-12 text-muted">
        <span className="font-semibold text-fg">Triage funnel</span> Every item, counted once
      </p>
      <div className="grid grid-cols-5 gap-3">
        {FUNNEL.map((p) => {
          const r = statusReading("feedbackPhase", p);
          return (
            <div key={p} className="grid gap-1">
              <span
                className="h-2 rounded-xs"
                style={{ background: LEGEND[FEEDBACK_PHASE_TONES[p]].dot, opacity: n(p) ? 1 : 0.35, width: `${Math.max(12, (n(p) / total) * 100)}%` }}
              />
              <span className="text-12 text-muted">{r.label}</span>
              <span className="text-13 font-semibold tabular-nums">{n(p)}</span>
            </div>
          );
        })}
      </div>
      <p className="text-12 text-muted">
        Off the funnel: Declined {n("declined")} · Reopened {n("reopened")}
      </p>
    </div>
  );
}

const aboutLine = (r: FeedbackSummary) =>
  r.target.type === "screen" ? `Screen “${r.target.key}”` : `${enumLabel("feedbackTarget", r.target.type)} ${r.target.key}`;

const GROUP_MODES = [
  { value: "attention" as const, label: "Attention", title: "Grouped by whose turn it is" },
  { value: "subject" as const, label: "Subject", title: "Grouped by what each item is about" },
];
type Grouping = (typeof GROUP_MODES)[number]["value"];

function groupsOf(rows: FeedbackSummary[], by: Grouping): ListGroup<FeedbackSummary>[] {
  if (by === "attention") {
    return FEEDBACK_ATTENTION.map((a) => ({ id: a, ...FEEDBACK_ATTENTION_LABELS[a], rows: rows.filter((r) => r.attention === a) }));
  }
  const byTarget = new Map<string, FeedbackSummary[]>();
  for (const r of rows) {
    const id = `${r.target.type}:${r.target.key}`;
    byTarget.set(id, [...(byTarget.get(id) ?? []), r]);
  }
  return [...byTarget.entries()].map(([id, list]) => {
    const you = list.filter((r) => r.attention === "you").length;
    return {
      id: `subject:${id}`,
      label: aboutLine(list[0] as FeedbackSummary),
      tone: you ? ("you" as const) : null,
      summary: you ? [{ label: "Needs you", count: you, tone: "you" as const }] : undefined,
      rows: list,
    };
  });
}

const rowOf =
  (slug: string) =>
  (r: FeedbackSummary): ListRowView => ({
    key: r.key,
    href: feedbackHref(slug, r.key),
    title: r.title,
    facts: [enumLabel("feedbackKind", r.kind), `About ${aboutLine(r)}`, r.reporter.name ?? "Unknown reporter", `Severity ${statusReading("severity", r.severity).label}`],
    state: <StatusBadge family="feedbackPhase" value={r.phase} />,
    waitingOn: <WaitingOn w={r.waiting} />,
    owner: <ActorChip name={r.reporter.name ?? "Unknown reporter"} kind={r.reporter.agency} size={20} />,
    age: { text: formatAge(r.updatedAt), title: `Sent ${formatStamp(r.createdAt)} · last changed ${formatStamp(r.updatedAt)}` },
    dim: r.attention === "done",
  });

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
            options={FEEDBACK_KINDS.filter((k) => k !== "contract_change").map((k) => ({ value: k, label: enumLabel("feedbackKind", k) }))}
          />
        </Field>
        <Field label="Severity">
          <NativeSelect
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FeedbackSeverity)}
            options={FEEDBACK_SEVERITIES.map((v) => ({ value: v, label: statusReading("severity", v).label }))}
          />
        </Field>
        <Field label="About" hint="REQ-3, ISS-12, a release version, a workflow flow, or a screen name">
          <span className="flex gap-2">
            <NativeSelect
              value={targetType}
              onChange={(e) => setTargetType(e.target.value as FeedbackTargetType)}
              options={FEEDBACK_TARGET_TYPES.map((t) => ({ value: t, label: enumLabel("feedbackTarget", t) }))}
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
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [grouping, setGrouping] = useViewMode(GROUP_MODES);
  const text = params.get("q") ?? "";
  const [creating, setCreating] = useState(false);
  const fold = useGroupFold("web-v2:feedback-fold");

  const all = q.data?.feedback ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? all.filter((r) => `${r.key} ${r.title} ${r.reporter.name ?? ""}`.toLowerCase().includes(t)) : all;
  }, [all, text]);
  const groups = useMemo(() => groupsOf(rows, grouping), [rows, grouping]);
  const visible = useMemo(() => visibleRows(groups, fold).map((r) => r.key), [groups, fold]);
  const allKeys = useMemo(() => all.map((r) => r.key), [all]);
  const peek = usePeek(visible, allKeys);
  const row = useMemo(() => rowOf(slug), [slug]);

  const openFull = useCallback(
    (key: string) => {
      rememberListOrigin(FEEDBACK_LIST);
      router.push(feedbackHref(slug, key));
    },
    [router, slug],
  );
  usePeekKeys(peek, openFull);

  const title = (
    <>
      <PageTitle after={<ViewModeSwitcher modes={GROUP_MODES} value={grouping} onChange={setGrouping} placement="header" />}>Feedback</PageTitle>
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
  return (
    <div className="grid min-h-full content-start bg-surface" data-testid="feedback-screen">
      {title}
      {creating ? (
        <CreateForm
          projectId={projectId}
          onDone={(key) => {
            setCreating(false);
            if (key) peek.set(key);
          }}
        />
      ) : null}
      <div className={cn("grid min-h-[60vh] items-start", peek.open && "lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)]")}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
            <ViewModeSwitcher modes={GROUP_MODES} value={grouping} onChange={setGrouping} placement="toolbar" />
            <label className="flex h-[30px] min-w-[150px] max-w-[260px] flex-1 items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 text-12-5 text-subtle max-md:h-10 max-md:max-w-none max-md:basis-full">
              <Icon name="search" size={14} />
              <input
                type="search"
                aria-label="Search feedback"
                placeholder="Search feedback…"
                defaultValue={text}
                onChange={(e) => setParams({ q: e.target.value || null })}
                className="w-full min-w-0 border-0 bg-transparent text-fg outline-none"
              />
            </label>
          </div>
          {all.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState title="No feedback yet" message="Feedback is what a BA, a tester or a user says about a requirement, an issue, a release, a workflow or a screen." />
            </div>
          ) : (
            <>
              <Funnel rows={all} />
              <GroupedList
                ariaLabel="Feedback"
                groups={groups}
                fold={fold}
                row={row}
                selected={peek.open}
                onPeek={(k) => peek.set(k === peek.open ? null : k)}
                empty="Nothing matches this search."
              />
            </>
          )}
        </div>
        {peek.open ? (
          <FeedbackPeek key={peek.open} projectId={projectId} slug={slug} fbKey={peek.open} peek={peek} onOpenFull={() => openFull(peek.open as string)} />
        ) : null}
      </div>
    </div>
  );
}
