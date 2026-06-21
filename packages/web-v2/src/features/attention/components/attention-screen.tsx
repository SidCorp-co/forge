"use client";

// Attention / Inbox (ISS-307) — a cross-project list of items that need the
// caller: issues to review, issues awaiting input (waiting/needs_info/on_hold),
// @-mentions, failed jobs (incl. deploy), and offline runners. Each row links to
// its source. Live via WS: cross-project events only arrive on subscribed rooms,
// so we fan out a `useRoom` per project (the Ops-monitor pattern) — the
// `['attention']` invalidations in `lib/ws/event-router.ts` then refetch.
import { useRouter } from "next/navigation";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  EmptyState,
  ErrorState,
  Icon,
  type IconName,
  MonoTag,
  PageContainer,
  ProjectLoader,
} from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useAttention } from "../hooks";
import type { AttentionItem, AttentionKind } from "../types";

/** Per-kind presentation. ISS-509: color resolves through the semantic tone
 *  layer (one source of truth) so a `failed` job (failure/red) and an offline
 *  runner (infra/slate) are no longer the same red; color is paired with an icon
 *  + label so status is never conveyed by color alone (a11y: color-not-only). */
const KIND_TONE: Record<AttentionKind, SemanticTone> = {
  needs_review: "active",
  awaiting_input: "attention",
  mention: "neutral",
  failed_job: "failure",
  runner_offline: "infra",
};

const KIND_META: Record<AttentionKind, { label: string; icon: IconName; fg: string; bg: string }> = {
  needs_review: { label: "Needs review", icon: "check", ...tone("needs_review") },
  awaiting_input: { label: "Awaiting input", icon: "clock", ...tone("awaiting_input") },
  mention: { label: "Mention", icon: "mail", ...tone("mention") },
  failed_job: { label: "Failed", icon: "alert", ...tone("failed_job") },
  runner_offline: { label: "Runner offline", icon: "server", ...tone("runner_offline") },
};

function tone(kind: AttentionKind): { fg: string; bg: string } {
  const t = TONE_META[KIND_TONE[kind]];
  return { fg: t.fg, bg: t.bg };
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
      <span className="fg-caption hidden flex-none text-subtle sm:inline">{formatRelativeTime(item.since)}</span>
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
  const { view, isLoading, isError, error, refetch } = useAttention();
  // ISS-477 — scope the inbox to the active org's projects. Items carrying a
  // `projectSlug` outside the active org are dropped; items without one (e.g.
  // offline runners) are kept so device-level alerts never silently vanish.
  const { projects, projectSlugs } = useOrgScopedProjects();
  const keep = (it: AttentionItem) => !it.projectSlug || projectSlugs.has(it.projectSlug);
  const scoped = {
    needsReview: view.needsReview.filter(keep),
    awaitingInput: view.awaitingInput.filter(keep),
    mentions: view.mentions.filter(keep),
    failedJobs: view.failedJobs.filter(keep),
    offlineRunners: view.offlineRunners.filter(keep),
  };
  const total =
    scoped.needsReview.length +
    scoped.awaitingInput.length +
    scoped.mentions.length +
    scoped.failedJobs.length +
    scoped.offlineRunners.length;

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
    <PageContainer className="flex min-h-dvh flex-col">
      {/* Active-org live fan-out so attention updates arrive over WS. */}
      {projects.map((p) => (
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
          <Group title="Needs review" items={scoped.needsReview} onOpen={open} />
          <Group title="Awaiting input" items={scoped.awaitingInput} onOpen={open} />
          <Group title="Mentions" items={scoped.mentions} onOpen={open} />
          <Group title="Failed jobs" items={scoped.failedJobs} onOpen={open} />
          <Group title="Offline runners" items={scoped.offlineRunners} onOpen={open} />
        </div>
      )}
    </PageContainer>
  );
}
