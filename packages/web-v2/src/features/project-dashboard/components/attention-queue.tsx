"use client";

// Needs-your-attention queue (ISS-379, AC#2) — the dashboard centerpiece. Lists
// the project's actionable items (failed → Approve & retry, review → Open diff,
// holding a question → Provide info, parked → Open issue). Each primary action
// NAVIGATES to the existing destination (issue-detail / review / relations) —
// no new mutations, no duplication of ISS-377/366.
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  CardTitle,
  EmptyState,
  Icon,
  MonoTag,
  type IconName,
} from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { formatRelativeTime } from "@/features/projects/derive";
import { WORK_STATE_LABELS } from "@forge/contracts/work-state";
import type { AttentionActionKind, AttentionCut, DashboardAttentionItem } from "../derive";

// ISS-509: tone-resolved so only a genuinely failed job is red — a
// blocked-on-dependency `chain` item is calm `blocked` ink, NOT alarm-red.
const ACTION_TONE: Record<AttentionActionKind, SemanticTone> = {
  retry: "failure",
  diff: "active",
  input: "attention",
  parked: "blocked",
};

const ACTION_META: Record<AttentionActionKind, { tag: string; icon: IconName; fg: string; bg: string }> = {
  retry: { tag: "Failed", icon: "alert", ...actionTone("retry") },
  diff: { tag: "Review", icon: "check", ...actionTone("diff") },
  input: { tag: "Awaiting", icon: "clock", ...actionTone("input") },
  parked: { tag: "Blocked", icon: "clock", ...actionTone("parked") },
};

function actionTone(kind: AttentionActionKind): { fg: string; bg: string } {
  const t = TONE_META[ACTION_TONE[kind]];
  return { fg: t.fg, bg: t.bg };
}

export function AttentionQueue({
  items,
  cut,
  slug,
  now,
}: {
  items: DashboardAttentionItem[];
  /** How much of what a person has to act on the list leaves out; null where it holds it all. */
  cut: AttentionCut | null;
  slug: string;
  now: number;
}) {
  const router = useRouter();

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line-subtle px-5 py-3.5">
        <Icon name="inbox" size={16} className="text-subtle" />
        <CardTitle>Needs your attention</CardTitle>
        {items.length > 0 && (
          <span
            className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
            style={{ fontSize: "var(--text-11)", lineHeight: "16px", color: "var(--accent-text)", background: "var(--flame-50)" }}
          >
            {items.length}
          </span>
        )}
      </div>
      <CardContent className="flex-1">
        {items.length === 0 ? (
          <EmptyState title="All caught up" message="Nothing in this project needs you right now." mascot={false} />
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((it) => {
              const m = ACTION_META[it.actionKind];
              return (
                <li
                  key={it.key}
                  className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2"
                >
                  <span
                    className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-pill px-1.5 py-0.5 font-semibold"
                    style={{ color: m.fg, background: m.bg, fontSize: "var(--text-11)" }}
                  >
                    <Icon name={m.icon} size={12} style={{ color: m.fg }} />
                    {m.tag}
                  </span>
                  {it.issueRef && <MonoTag>{it.issueRef}</MonoTag>}
                  <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{it.title}</span>
                  {it.since && (
                    <span className="fg-caption hidden flex-none text-subtle sm:inline">
                      {formatRelativeTime(it.since, now)}
                    </span>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => router.push(it.link)}>
                    {it.actionLabel}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {cut && (
          <p className="fg-caption mt-3 text-subtle">
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
      </CardContent>
    </Card>
  );
}
