"use client";

// Attention / Inbox (ISS-307) — a cross-project list of items that need the
// caller: issues to review, issues awaiting input (waiting/needs_info/on_hold),
// @-mentions, failed jobs (incl. deploy), and offline runners. Each row links to
// its source. Live via WS: cross-project events only arrive on subscribed rooms,
// so we fan out a `useRoom` per project (the Ops-monitor pattern) — the
// `['attention']` invalidations in `lib/ws/event-router.ts` then refetch.
import { useRouter } from "next/navigation";
import {
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  MonoTag,
  ProjectLoader,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useAttention } from "../hooks";
import type { AttentionItem, AttentionKind } from "../types";

/** Per-kind presentation. Color is paired with an icon + label so status is
 *  never conveyed by color alone (a11y: color-not-only). */
const KIND_META: Record<AttentionKind, { label: string; icon: IconName; fg: string; bg: string }> = {
  needs_review: { label: "Needs review", icon: "check", fg: "var(--cobalt-700)", bg: "var(--cobalt-50)" },
  awaiting_input: { label: "Awaiting input", icon: "clock", fg: "var(--amberw-600)", bg: "var(--amberw-50)" },
  mention: { label: "Mention", icon: "mail", fg: "var(--cobalt-700)", bg: "var(--cobalt-50)" },
  failed_job: { label: "Failed", icon: "alert", fg: "var(--red-600)", bg: "var(--red-50)" },
  runner_offline: { label: "Runner offline", icon: "server", fg: "var(--red-600)", bg: "var(--red-50)" },
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Subscribes to one WS room for its lifetime (renders nothing) — lets us fan
 *  out subscriptions over the project list without breaking rules-of-hooks. */
function RoomSub({ room }: { room: string }) {
  useRoom(room);
  return null;
}

function KindTag({ kind }: { kind: AttentionKind }) {
  const m = KIND_META[kind];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 font-semibold"
      style={{ color: m.fg, background: m.bg, fontSize: 11.5 }}
    >
      <Icon name={m.icon} size={13} style={{ color: m.fg }} />
      {m.label}
    </span>
  );
}

function AttentionRow({ item, onOpen }: { item: AttentionItem; onOpen: (link: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item.link)}
      className="flex w-full items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]"
    >
      <KindTag kind={item.kind} />
      <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{item.title}</span>
      {item.issueRef && <MonoTag>{item.issueRef}</MonoTag>}
      {item.projectName && (
        <span className="fg-caption hidden truncate text-muted sm:inline">{item.projectName}</span>
      )}
      <span className="fg-caption hidden flex-none text-subtle sm:inline">{relativeTime(item.since)}</span>
      <Icon name="chevronRight" size={15} className="flex-none text-subtle" />
    </button>
  );
}

function Group({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: AttentionItem[];
  onOpen: (link: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <h2 className="fg-label text-fg">{title}</h2>
        <span
          className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
          style={{ fontSize: 11, lineHeight: "16px", color: "var(--fg-muted)", background: "var(--paper-100)" }}
        >
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((it, i) => (
          <AttentionRow key={`${it.kind}-${it.link}-${i}`} item={it} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function AttentionScreen() {
  const router = useRouter();
  const { view, total, isLoading, isError, error, refetch } = useAttention();
  const { data: projects } = useProjects();

  const open = (link: string) => router.push(link);

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading attention…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-4 py-6 sm:px-6">
      {/* Cross-project live fan-out so attention updates arrive over WS. */}
      {(projects ?? []).map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <header className="mb-5">
        <h1 className="fg-h2">Attention</h1>
        <p className="fg-body-sm mt-1 text-muted">
          Cross-project items waiting on you — reviews, blocked work, mentions, failures, and offline
          runners.
        </p>
      </header>

      {total === 0 ? (
        <div className="grid min-h-[40vh] place-items-center">
          <EmptyState title="Inbox zero" message="Nothing needs your attention right now." />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Group title="Needs review" items={view.needsReview} onOpen={open} />
          <Group title="Awaiting input" items={view.awaitingInput} onOpen={open} />
          <Group title="Mentions" items={view.mentions} onOpen={open} />
          <Group title="Failed jobs" items={view.failedJobs} onOpen={open} />
          <Group title="Offline runners" items={view.offlineRunners} onOpen={open} />
        </div>
      )}
    </div>
  );
}
