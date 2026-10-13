"use client";

// Needs-your-attention list (ISS-379, AC#2). Each row is one item a person acts on, with its age as a
// chip and the action that clears it: failed → Approve & retry, review → Open diff, holding a
// question → Provide info, parked → Open issue. Each action NAVIGATES to the existing destination —
// no new mutations. Flat: rows divided by hairlines, no boxes. Empty is one line, said only where
// nothing is owed beyond it (ISS-1156).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Icon, MonoTag, type IconName } from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { WORK_STATE_LABELS } from "@forge/contracts/work-state";
import type { AttentionActionKind, AttentionCut, DashboardAttentionItem } from "../derive";
import { AgeChip } from "./age-chip";
import { DashboardSection, EmptyLine, RowList } from "./dashboard-section";

// ISS-509: tone-resolved so only a genuinely failed job is red — a blocked-on-dependency item is calm
// `blocked` ink, NOT alarm-red.
const ACTION_TONE: Record<AttentionActionKind, SemanticTone> = {
  retry: "failure",
  diff: "active",
  input: "attention",
  parked: "blocked",
};

const ACTION_META: Record<AttentionActionKind, { tag: string; icon: IconName }> = {
  retry: { tag: "Failed", icon: "alert" },
  diff: { tag: "Review", icon: "check" },
  input: { tag: "Awaiting", icon: "clock" },
  parked: { tag: "Blocked", icon: "clock" },
};

const TITLE = "Needs your attention";

export function AttentionQueue({
  items,
  cut,
  refusal = null,
  pending = false,
  onRetry,
  degraded = false,
  slug,
  now,
}: {
  items: DashboardAttentionItem[];
  /** How much of what a person has to act on the list leaves out; null where it holds it all. */
  cut: AttentionCut | null;
  /** Said under the list where the response cannot say how much of it is left out. */
  refusal?: string | null;
  /** The attention answer is not in yet: the list says it is reading and neither counts nor says all caught up. */
  pending?: boolean;
  /** Asks for the read again; offered under a refusal where the read failed. */
  onRetry?: () => void;
  /** The page is degraded by something this list does not hold, so it cannot say all is caught up. */
  degraded?: boolean;
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
          Showing {cut.shown} of at least {cut.atLeast}.
          {cut.peopleCut && (
            <>
              {" "}
              <Link href={`/projects/${slug}/issues?filter=blocked_on_person`} className="underline">
                Every {WORK_STATE_LABELS.blocked_on_person.toLowerCase()} issue is in Issues
              </Link>
              .
            </>
          )}
        </p>
      )}
    </>
  );

  if (items.length === 0) {
    return (
      <div>
        {cut || refusal ? (
          <DashboardSection title={TITLE}>
            <p className="fg-body-sm py-2 text-subtle">Nothing is listed to act on here.</p>
            {notes}
          </DashboardSection>
        ) : degraded ? (
          <EmptyLine
            title={TITLE}
            status="No item is waiting on you"
            detail="What is wrong is named above, and it is not an item listed here."
          />
        ) : (
          <EmptyLine title={TITLE} status="All caught up" detail="Nothing in this project needs you right now." />
        )}
      </div>
    );
  }

  return (
    <DashboardSection title={TITLE} aside={items.length}>
      <RowList>
        {items.map((it) => {
          const m = ACTION_META[it.actionKind];
          const t = TONE_META[ACTION_TONE[it.actionKind]];
          return (
            <li key={it.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2">
              <span
                className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 font-semibold"
                style={{ color: t.fg, background: t.bg, fontSize: "var(--text-11)" }}
              >
                <Icon name={m.icon} size={12} style={{ color: t.fg }} />
                {m.tag}
              </span>
              {it.issueRef && <MonoTag>{it.issueRef}</MonoTag>}
              {/* Narrow: kind, ref and age share the first line whatever the title's length, then the title
                  takes its own, then the action. Wide: one line, in the order they are read. */}
              <span className="fg-body-sm order-3 min-w-0 basis-full truncate text-fg sm:order-none sm:flex-1 sm:basis-40">
                {it.title}
              </span>
              <span className="ml-auto flex-none sm:ml-0">
                <AgeChip since={it.since} basis={it.sinceBasis} now={now} />
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="order-4 sm:order-none"
                onClick={() => router.push(it.link)}
              >
                {it.actionLabel}
              </Button>
            </li>
          );
        })}
      </RowList>
      {notes}
    </DashboardSection>
  );
}
