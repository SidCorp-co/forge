"use client";

// Needs-your-attention queue (ISS-379, AC#2) — the dashboard centerpiece. Lists
// the project's actionable items (failed → Approve & retry, review → Open diff,
// awaiting → Provide info, blocked-on-dep → View chain). Each primary action
// NAVIGATES to the existing destination (issue-detail / review / relations) —
// no new mutations, no duplication of ISS-377/366.
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, EmptyState, Icon, type IconName, MonoTag } from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { formatRelativeTime } from "@/features/projects/derive";
import type { AttentionActionKind, DashboardAttentionItem } from "../derive";

// ISS-509: tone-resolved so only a genuinely failed job is red — a
// blocked-on-dependency `chain` item is calm `blocked` ink, NOT alarm-red.
const ACTION_TONE: Record<AttentionActionKind, SemanticTone> = {
  retry: "failure",
  diff: "active",
  input: "attention",
  chain: "blocked",
};

const ACTION_META: Record<AttentionActionKind, { tag: string; icon: IconName; fg: string; bg: string }> = {
  retry: { tag: "Failed", icon: "alert", ...actionTone("retry") },
  diff: { tag: "Review", icon: "check", ...actionTone("diff") },
  input: { tag: "Awaiting", icon: "clock", ...actionTone("input") },
  chain: { tag: "Blocked", icon: "branch", ...actionTone("chain") },
};

function actionTone(kind: AttentionActionKind): { fg: string; bg: string } {
  const t = TONE_META[ACTION_TONE[kind]];
  return { fg: t.fg, bg: t.bg };
}

export function AttentionQueue({ items, now }: { items: DashboardAttentionItem[]; now: number }) {
  const router = useRouter();

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line-subtle px-5 py-3.5">
        <Icon name="inbox" size={16} className="text-subtle" />
        <h3 className="fg-h3">Needs your attention</h3>
        {items.length > 0 && (
          <span
            className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
            style={{ fontSize: 11, lineHeight: "16px", color: "var(--accent-text)", background: "var(--flame-50)" }}
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
                    style={{ color: m.fg, background: m.bg, fontSize: 11 }}
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
      </CardContent>
    </Card>
  );
}
