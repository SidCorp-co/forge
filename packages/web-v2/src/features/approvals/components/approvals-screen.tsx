// Approvals, the full Needs you page (REQ-48 BC-11): every decision waiting on the viewer in one
// project, from the one Needs you read the Dashboard, the menu badge and /attention count from, so
// the page's number is theirs. Chips narrow it by topic and to what the agent recommends; a selection
// replaces the chips with a bar that states what approving makes before it acts; a row opens its
// peek, decides in place with ✓ / ✕, and every decision is held five seconds for Undo.

import type { DecisionAnswer, NeedsYouDecision, NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { useMemo, useState } from "react";
import { Checkbox, EmptyState, FilterChip, ListLayout, ListSearch, ListToolbar, PageTitle, usePeek, usePeekKeys, useUrlChoice, useUrlParams } from "@/design";
import { decisionHref, useNeedsYouDecisions } from "@/features/needs-you";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useRouter } from "@/lib/navigation/router";
import { approveOf, CHIPS, declineOf, drawnOrder, groupsOf, narrowed, oldestOf, recommends } from "../derive";
import { approvalsHref } from "../routes";
import { type Decided, useDecide } from "../use-decide";
import { useDecisionKeys } from "../use-decision-keys";
import { DecisionPeek } from "./approval-peek";
import { PendingDecision } from "./approval-row";
import { BulkBar } from "./bulk-bar";
import { DecidedBar } from "./decided-bar";

const decidedOf = (d: NeedsYouDecision, answer: DecisionAnswer, reason: string | null): Decided => ({
  id: d.id,
  key: d.key,
  answer,
  reason,
  how: answer.id === declineOf(d)?.id ? "declined" : "approved",
});

function Sub({ read }: { read: NeedsYouDecisions }) {
  const t = useCopy();
  const time = useTimeFormat();
  const oldest = oldestOf(read.decisions);
  return (
    <span className="text-13 text-muted" data-testid="approvals-count" data-total={read.total}>
      {read.total === 0 ? t("approvals.subNone") : t("approvals.sub", { n: read.total, age: oldest ? time.age(oldest) : "—" })}
    </span>
  );
}

function Chips({ all, chip, onChip, rec, onRec }: { all: readonly NeedsYouDecision[]; chip: (typeof CHIPS)[number]; onChip: (c: (typeof CHIPS)[number]) => void; rec: boolean; onRec: () => void }) {
  const t = useCopy();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="approval-chips">
      {CHIPS.map((c) => (
        <FilterChip key={c} on={chip === c} onToggle={() => onChip(chip === c ? "all" : c)} count={c === "all" ? all.length : all.filter((d) => d.topic === c).length} testId={`approval-chip-${c}`}>
          {t(c === "all" ? "approvals.chip.all" : `approvals.topic.${c}`)}
        </FilterChip>
      ))}
      <span className="w-2" />
      <FilterChip on={rec} onToggle={onRec} count={all.filter(recommends).length} tone="done" testId="approval-chip-recommends">
        {t("approvals.chip.recommends")}
      </FilterChip>
    </div>
  );
}

/** The words a row needs before it is sent: which row, and which of its answers asked for them. */
interface Typing {
  id: string;
  answer: DecisionAnswer;
}

function Decisions({ read, slug }: { read: NeedsYouDecisions; slug: string }) {
  const t = useCopy();
  const router = useRouter();
  const [params, setParams] = useUrlParams();
  const [chip, setChip] = useUrlChoice("topic", CHIPS, "all");
  const rec = params.get("rec") === "1";
  const query = params.get("q") ?? "";
  const decide = useDecide();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [typing, setTyping] = useState<Typing | null>(null);

  const all = useMemo(() => read.decisions.filter((d) => !decide.held.has(d.id)), [read.decisions, decide.held]);
  const rows = drawnOrder(narrowed(all, { chip, recommends: rec, query }));
  const ids = rows.map((d) => d.id);
  const peek = usePeek(ids, all.map((d) => d.id));
  const open = all.find((d) => d.id === peek.open) ?? null;
  const fullOf = (d: NeedsYouDecision) => ({ href: decisionHref(slug, d.opens) ?? approvalsHref(slug), origin: null });
  usePeekKeys(peek, (id) => {
    const d = all.find((x) => x.id === id);
    if (d) router.push(fullOf(d).href);
  });

  const selected = all.filter((d) => picked.has(d.id));
  const select = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Decide one row; an open peek steps on to the row after it, or the one before at the list's end. */
  const press = (d: NeedsYouDecision, answer: DecisionAnswer, reason: string | null) => {
    if (peek.open === d.id) {
      const i = ids.indexOf(d.id);
      peek.set(ids[i + 1] ?? ids[i - 1] ?? null);
    }
    setTyping(null);
    select(d.id, false);
    decide.decide([decidedOf(d, answer, reason)]);
  };
  const askWords = (d: NeedsYouDecision, answer: DecisionAnswer) => {
    peek.set(d.id);
    setTyping({ id: d.id, answer });
  };
  const approveRow = (d: NeedsYouDecision) => {
    const a = approveOf(d);
    if (a) press(d, a, null);
  };
  const declineRow = (d: NeedsYouDecision) => {
    const a = declineOf(d);
    if (a) askWords(d, a);
  };
  useDecisionKeys(peek.open, {
    approve: () => (open ? approveRow(open) : undefined),
    decline: () => (open ? declineRow(open) : undefined),
    select: () => (open ? select(open.id, !picked.has(open.id)) : undefined),
  });

  const bulk = (how: "approve" | "decline", reason: string | null) => {
    const batch = selected.flatMap((d) => {
      const a = how === "approve" ? approveOf(d) : declineOf(d);
      return a ? [decidedOf(d, a, reason)] : [];
    });
    setPicked(new Set());
    if (peek.open && batch.some((b) => b.id === peek.open)) peek.set(null);
    decide.decide(batch);
  };

  const peekPanel = open ? (
    <DecisionPeek
      key={open.id}
      d={open}
      peek={peek}
      full={fullOf(open)}
      noun={t(open.opens ? `approvals.noun.${open.opens.kind}` : "approvals.noun")}
      typing={typing?.id === open.id ? typing.answer : null}
      onType={(a) => setTyping(a ? { id: open.id, answer: a } : null)}
      onPress={(a, words) => (a.needsReason && words === null ? askWords(open, a) : press(open, a, words))}
    />
  ) : undefined;

  return (
    <ListLayout peek={peekPanel} testId="approvals-layout">
      <div className="min-w-0">
        {selected.length > 0 ? (
          <BulkBar selected={selected} onApprove={() => bulk("approve", null)} onDecline={(r) => bulk("decline", r)} onClear={() => setPicked(new Set())} />
        ) : (
          <ListToolbar>
            <Chips all={all} chip={chip} onChip={setChip} rec={rec} onRec={() => setParams({ rec: rec ? null : "1" })} />
            <ListSearch noun={t("approvals.search")} value={query} onChange={(v) => setParams({ q: v || null })} />
          </ListToolbar>
        )}
        {all.length === 0 ? (
          <div className="px-5 py-10">
            <EmptyState message={t("approvals.empty")} />
          </div>
        ) : (
          groupsOf(rows).map((g) => {
            const on = g.rows.filter((d) => picked.has(d.id)).length;
            return (
              <section key={g.topic} aria-label={t(`approvals.topic.${g.topic}`)} data-testid={`approval-group-${g.topic}`}>
                <div className="flex items-center gap-3 border-b border-line-subtle bg-sunken px-4 py-2">
                  <Checkbox
                    checked={on > 0 && on === g.rows.length}
                    indeterminate={on > 0 && on < g.rows.length}
                    onChange={(v) => setPicked((p) => new Set(v ? [...p, ...g.rows.map((d) => d.id)] : [...p].filter((id) => !g.rows.some((d) => d.id === id))))}
                    ariaLabel={t("approvals.selectGroup", { group: t(`approvals.topic.${g.topic}`) })}
                  />
                  <h2 className="shrink-0 whitespace-nowrap text-13 font-semibold text-fg">
                    {t(`approvals.topic.${g.topic}`)} · {g.rows.length}
                  </h2>
                  <span className="min-w-0 truncate text-12 text-muted">{t(`approvals.topic.${g.topic}.desc`)}</span>
                </div>
                <ul>
                  {g.rows.map((d) => (
                    <PendingDecision
                      key={d.id}
                      d={d}
                      open={peek.open === d.id}
                      selected={picked.has(d.id)}
                      onOpen={() => peek.set(peek.open === d.id ? null : d.id)}
                      onSelect={(v) => select(d.id, v)}
                      onApprove={() => approveRow(d)}
                      onDecline={() => declineRow(d)}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
        {all.length > 0 && rows.length === 0 ? <p className="px-5 py-6 text-13 text-muted">{t("approvals.noMatch")}</p> : null}
        <LeftOut read={read} />
      </div>
      <DecidedBar decide={decide} />
    </ListLayout>
  );
}

/** What the read carries beyond these rows: the decisions past its page, and the rows that are not decisions. */
function LeftOut({ read }: { read: NeedsYouDecisions }) {
  const t = useCopy();
  const leftOut = read.notDecisions.map((n) => `${t(`needsYou.decisions.reason.${n.reason}`, { n: n.count })}${n.keys.length ? ` (${n.keys.join(", ")})` : ""}`);
  return (
    <div className="flex flex-col gap-1 px-5 py-4 text-12 text-subtle">
      {read.total > read.decisions.length ? <p data-testid="approvals-more">{t("approvals.more", { shown: read.decisions.length, total: read.total })}</p> : null}
      {leftOut.length > 0 ? <p data-testid="approvals-left-out">{t("needsYou.decisions.leftOut", { list: leftOut.join(", ") })}</p> : null}
    </div>
  );
}

export function ApprovalsScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const q = useNeedsYouDecisions(projectId);
  const title = <PageTitle after={q.data ? <Sub read={q.data} /> : undefined}>{t("approvals.title")}</PageTitle>;
  return (
    <QueryBoundary query={q} loadingLabel={t("approvals.loading")} title={title} height="60vh" retry="always">
      {(read) => (
        <div className="min-h-full min-w-0 bg-app" data-testid="approvals-screen">
          {title}
          <Decisions read={read} slug={slug} />
        </div>
      )}
    </QueryBoundary>
  );
}
