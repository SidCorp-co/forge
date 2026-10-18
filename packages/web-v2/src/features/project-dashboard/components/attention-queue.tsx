"use client";

// Needs-your-attention list (ISS-379, AC#2). Each row is one item a person acts on, with its age as a
// chip and the action that clears it: failed → Retry job, review → Open diff, holding a
// question → Provide info, parked → Open issue. A failed job's button retries the job (ISS-1229 r16);
// every other action navigates to the existing destination. Flat: rows divided by hairlines, no boxes. Empty is one line, said only where
// nothing is owed beyond it (ISS-1156).
import { SESSION_ICONS } from "@/design/primitives/status-chip";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Icon, MonoTag, type IconName } from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { failedJobClause } from "@/features/attention/failed-job-words";
import { stuckClause, stuckRowWords } from "@forge/contracts/stuck-words";
import { WORK_STATE_LABELS } from "@forge/contracts/work-state";
import {
  type AttentionActionKind,
  type AttentionCut,
  countedStuck,
  type DashboardAttentionItem,
  type StuckIssues,
  stuckLeftOut,
  stuckRowsOf,
} from "../derive";
import type { ProjectShape } from "../shape";
import { AgeChip } from "./age-chip";
import { DashboardSection, EmptyLine, RowList } from "./dashboard-section";

// ISS-509: tone-resolved so only a genuinely failed job is red — a blocked-on-dependency item is calm
// `blocked` ink, NOT alarm-red.
const ACTION_TONE: Record<AttentionActionKind, SemanticTone> = {
  retry: "failure",
  diff: "active",
  input: "attention",
  parked: "blocked",
  session: "attention",
};

const ACTION_META: Record<AttentionActionKind, { tag: string; icon: IconName }> = {
  retry: { tag: "Failed", icon: "alert" },
  diff: { tag: "Review", icon: "check" },
  input: { tag: "Awaiting", icon: "clock" },
  parked: { tag: "Blocked", icon: "clock" },
  session: { tag: "Waiting", icon: SESSION_ICONS.waiting },
};

const TITLE = "Needs your attention";

export type { StuckIssues };

/** The tag a stuck row wears, whether it is listed for its notice alone or as an item its notice tells. */
function StuckTag() {
  return (
    <span
      className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 font-semibold"
      style={{ color: TONE_META.blocked.fg, background: TONE_META.blocked.bg, fontSize: "var(--text-11)" }}
    >
      <Icon name="clock" size={12} style={{ color: TONE_META.blocked.fg }} />
      Stuck
    </span>
  );
}

/** Why an item is listed, then its next reason down: an answer owed, a failed job, a stuck reason (ISS-1229 r15). */
function itemWords(it: DashboardAttentionItem): { stuck: boolean; detail?: string } {
  if (it.stuckKind && !it.owed && it.actionKind !== "retry") {
    return { stuck: true, detail: stuckRowWords(it.stuckKind, it.stuckOwedBy) };
  }
  const under = it.failedJob
    ? failedJobClause(it.failedJob)
    : it.stuckKind
      ? stuckClause(it.stuckKind, it.stuckOwedBy)
      : null;
  if (!under) return { stuck: false, detail: it.detail };
  return { stuck: false, detail: it.detail ? `${it.detail.replace(/[.]?$/, ".")} ${under}` : under };
}

/** A row's title, whole and wrapping, with why it is listed read under it. */
function RowText({ title, detail }: { title: string; detail?: string }) {
  return (
    <span className="fg-body-sm order-3 min-w-0 basis-full break-words text-fg sm:order-none sm:flex-1 sm:basis-40">
      {title}
      {detail && <span className="fg-caption block text-subtle">{detail}</span>}
    </span>
  );
}

export function AttentionQueue({
  items,
  cut,
  refusal = null,
  pending = false,
  onRetry,
  onRetryJob,
  retryingJobId = null,
  shape = "working",
  slug,
  now,
  stuck = { total: 0, refs: [] },
  whole,
}: {
  items: DashboardAttentionItem[];
  /** Every item the section holds, listed or not: what its heading counts. Its rows where unstated. */
  whole?: number;
  /** The issues the headline counts as stuck: listed here too, so the section never says nothing needs you beside them. */
  stuck?: StuckIssues;
  /** How much of what a person has to act on the list leaves out; null where it holds it all. */
  cut: AttentionCut | null;
  /** Said under the list where the response cannot say how much of it is left out. */
  refusal?: string | null;
  /** The attention answer is not in yet: the list says it is reading and neither counts nor says all caught up. */
  pending?: boolean;
  /** Asks for the read again; offered under a refusal where the read failed. */
  onRetry?: () => void;
  /** Retries a failed job, by its id: what a failed row's button does. */
  onRetryJob?: (jobId: string) => void;
  /** The failed job whose retry is on its way, whose button waits for it. */
  retryingJobId?: string | null;
  /**
   * What the page reads as. An empty list says all caught up only under quiet or working: degraded
   * means something this list does not hold is wrong, and unread means a read the list rests on beside
   * its own has not arrived, so the page cannot yet say nothing needs anyone.
   */
  shape?: ProjectShape;
  slug: string;
  now: number;
}) {
  const router = useRouter();

  if (pending) {
    return (
      <DashboardSection title={TITLE}>
        <p role="status" className="fg-body-sm py-2 text-subtle" data-testid="attention-pending">
          Reading what needs you…
        </p>
      </DashboardSection>
    );
  }

  const notes = (
    <>
      {refusal && (
        <p role="alert" className="fg-caption mt-2 text-subtle" data-testid="attention-refusal">
          {refusal}
        </p>
      )}
      {refusal && onRetry && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
      {cut && (
        <p className="fg-caption mt-2 text-subtle">
          Showing {cut.shown} of {cut.whole}.
          {cut.peopleCut && (
            <>
              {" "}
              <Link href={`/projects/${slug}/issues?filter=blocked_on_person`} className="underline">
                Every issue {WORK_STATE_LABELS.blocked_on_person.toLowerCase()} is in Issues
              </Link>
              .
            </>
          )}
        </p>
      )}
    </>
  );

  const stuckRows = stuckRowsOf(items, stuck);
  // Each stuck issue on the page is counted once, listed as an item or as a row of its own (ISS-1229 r15).
  const stuckUnlisted = stuckLeftOut(items, stuck);
  const heading = whole ?? items.length + stuckRows.length;
  const stuckList = (
    <>
      {stuckRows.length > 0 && (
        <p className="fg-caption mt-2 text-subtle">{items.length > 0 ? "Also reported stuck" : "Reported stuck"}</p>
      )}
      {stuckRows.length > 0 && (
        <RowList>
          {stuckRows.map((r) => (
            <li key={`stuck-${r.documentId}`} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2">
              <StuckTag />
              <MonoTag>{r.issueId}</MonoTag>
              <RowText title={r.title} detail={stuckRowWords(r.kind, r.owedBy)} />
              <Button
                size="sm"
                variant="secondary"
                className="order-4 sm:order-none"
                onClick={() => router.push(`/projects/${slug}/issues/${r.documentId}`)}
              >
                Open issue
              </Button>
            </li>
          ))}
        </RowList>
      )}
      {stuckUnlisted > 0 && (
        <p className="fg-caption mt-2 text-subtle">
          {stuckRows.length > 0 || items.some(countedStuck)
            ? `And ${stuckUnlisted} more stuck. `
            : `${stuckUnlisted} stuck. `}
          {/* The list it opens holds exactly the issues the headline counts as stuck (ISS-1229 r14). */}
          <Link href={`/projects/${slug}/issues?stuck=1`} className="underline">
            {stuck.total === 1 ? "It is in Issues" : `All ${stuck.total} stuck issues are in Issues`}
          </Link>
          .
        </p>
      )}
    </>
  );
  const holdsStuck = stuckRows.length > 0 || stuckUnlisted > 0;

  if (items.length === 0 && holdsStuck && !refusal) {
    return (
      <DashboardSection title={TITLE} aside={heading}>
        {stuckList}
        {notes}
      </DashboardSection>
    );
  }

  // Degraded with nothing to list: the headline names the cause, and an empty line under it would
  // say nothing needs you beside a red "Action needed" (ISS-1229 r13).
  if (items.length === 0 && shape === "degraded" && !refusal && !cut) return null;

  if (items.length === 0) {
    return (
      <div>
        {refusal ? (
          <DashboardSection title={TITLE}>{notes}</DashboardSection>
        ) : shape === "unread" && cut ? (
          <DashboardSection title={TITLE}>
            <p className="fg-body-sm py-2 text-subtle">
              Not all of this page is read yet, so this is not an all clear.
            </p>
            {notes}
          </DashboardSection>
        ) : cut ? (
          <DashboardSection title={TITLE}>
            <p className="fg-body-sm py-2 text-subtle">Nothing is listed to act on here.</p>
            {notes}
          </DashboardSection>
        ) : shape === "unread" ? (
          <EmptyLine
            title={TITLE}
            status="Not all of this page is read yet"
            detail="What it names above is missing here too, so this is not an all clear."
          />
        ) : (
          <EmptyLine title={TITLE} status="All caught up" detail="Nothing in this project needs you right now." />
        )}
      </div>
    );
  }

  return (
    <DashboardSection title={TITLE} aside={heading}>
      <RowList>
        {items.map((it) => {
          const m = ACTION_META[it.actionKind];
          const t = TONE_META[ACTION_TONE[it.actionKind]];
          const said = itemWords(it);
          return (
            <li key={it.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2">
              {said.stuck ? (
                <StuckTag />
              ) : (
                <span
                  className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 font-semibold"
                  style={{ color: t.fg, background: t.bg, fontSize: "var(--text-11)" }}
                >
                  <Icon name={m.icon} size={12} style={{ color: t.fg }} />
                  {m.tag}
                </span>
              )}
              {it.issueRef && <MonoTag>{it.issueRef}</MonoTag>}
              {/* Narrow: kind, ref and age share the first line, then the whole title wraps on its own,
                  then the action. Wide: one line, in the order they are read; the title wraps there too. */}
              <RowText title={it.title} detail={said.detail} />
              <span className="ml-auto flex-none sm:ml-0">
                <AgeChip since={it.since} now={now} />
              </span>
              {it.actionKind === "retry" && it.jobId && onRetryJob ? (
                <Button
                  size="sm"
                  variant="secondary"
                  className="order-4 sm:order-none"
                  disabled={retryingJobId === it.jobId}
                  onClick={() => it.jobId && onRetryJob(it.jobId)}
                >
                  {retryingJobId === it.jobId ? "Retrying…" : it.actionLabel}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  className="order-4 sm:order-none"
                  onClick={() => router.push(it.link)}
                >
                  {/* A failed row that cannot retry from here says where it goes instead (ISS-1229 r16). */}
                  {it.actionKind === "retry" ? "Open issue" : it.actionLabel}
                </Button>
              )}
            </li>
          );
        })}
      </RowList>
      {stuckList}
      {notes}
    </DashboardSection>
  );
}
