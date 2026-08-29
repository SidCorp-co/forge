"use client";

// Attention / Inbox (ISS-307) — a cross-project list of items that need the
// caller: issues to review, issues awaiting input (waiting/needs_info/on_hold),
// @-mentions, failed jobs (incl. deploy), and offline runners. Each row links to
// its source. Live via WS: cross-project events only arrive on subscribed rooms,
// so we fan out a `useRoom` per project (the Ops-monitor pattern) — the
// `['attention']` invalidations in `lib/ws/event-router.ts` then refetch.
import { type ReactNode, useState } from "react";
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
  pending_skill_update: "attention",
  unseen_draft: "attention",
  runner_offline: "infra",
};

const KIND_META: Record<AttentionKind, { label: string; icon: IconName; fg: string; bg: string }> = {
  needs_review: { label: "Needs review", icon: "check", ...tone("needs_review") },
  awaiting_input: { label: "Awaiting input", icon: "clock", ...tone("awaiting_input") },
  mention: { label: "Mention", icon: "mail", ...tone("mention") },
  failed_job: { label: "Failed", icon: "alert", ...tone("failed_job") },
  pending_skill_update: { label: "Skill update", icon: "clock", ...tone("pending_skill_update") },
  unseen_draft: { label: "Unseen draft", icon: "inbox", ...tone("unseen_draft") },
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

function CountBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
      style={{ fontSize: 11, lineHeight: "16px", color: "var(--fg-muted)", background: "var(--paper-100)" }}
    >
      {children}
    </span>
  );
}

/** Above this many rows a group that OPTED IN starts collapsed — a long backlog
 *  must be countable without pushing every other bucket off the screen. */
const COLLAPSE_ABOVE = 5;

function Group({
  title,
  items,
  onOpen,
  total,
  collapsible: mayCollapse = false,
}: {
  title: string;
  items: AttentionItem[];
  onOpen: (link: string) => void;
  /** Unclipped match count when the API capped `items`. Defaults to items.length. */
  total?: number;
  collapsible?: boolean;
}) {
  const matched = total ?? items.length;
  // cm:why collapsing is opt-in per bucket, never derived from length alone: the buckets core caps at 5 could not trip it, but skill updates (cap 20) and offline runners (client-derived, unbounded) could — and an operator with 6 dead runners would open this screen to an infra alert collapsed to nothing by default.
  const collapsible = mayCollapse && items.length > COLLAPSE_ABOVE;
  // cm:guard `toggled` only ever applies WHILE the group is collapsible, and it starts null so the default follows the CURRENT length. Both halves are load-bearing: seed it from the first render and a group that grows past the threshold stays expanded, and let a stale `false` outlive `collapsible` and a group that shrinks back under it renders its header over zero rows with no button left to reopen them.
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (items.length === 0) return null;
  const expanded = collapsible ? (toggled ?? false) : true;
  // cm:why the h2 wraps the button rather than sitting inside it: a heading nested in a button is not announced as a heading, so collapsible groups would silently drop out of screen-reader heading navigation while the non-collapsible ones stayed in it.
  return (
    <section className="flex flex-col gap-2">
      <h2 className="fg-label text-fg">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setToggled(!expanded)}
            className="flex w-full items-center gap-2 rounded-md px-0.5 py-1 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]"
          >
            <Icon
              name="chevronRight"
              size={15}
              className="text-subtle transition-transform duration-[150ms]"
              style={{ transform: expanded ? "rotate(90deg)" : "none" }}
            />
            {title}
            <CountBadge>{matched}</CountBadge>
          </button>
        ) : (
          <span className="flex items-center gap-2 px-0.5">
            {title}
            <CountBadge>{matched}</CountBadge>
          </span>
        )}
      </h2>
      {expanded && (
        <div className="flex flex-col gap-1.5">
          {items.map((it, i) => (
            <AttentionRow key={`${it.kind}-${it.link}-${i}`} item={it} onOpen={onOpen} />
          ))}
          {matched > items.length && (
            <p className="fg-caption px-0.5 text-muted">
              Showing {items.length} of {matched}, highest priority first.
            </p>
          )}
        </div>
      )}
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
    pendingSkillUpdates: view.pendingSkillUpdates.filter(keep),
    unseenDrafts: view.unseenDrafts.filter(keep),
    offlineRunners: view.offlineRunners.filter(keep),
  };
  // cm:why the org filter can drop rows core counted, so the unclipped total is scaled down to what survived it rather than shown raw — a "20 of 22" over 3 visible rows reads as a bug, and re-deriving it from the list alone would hide a real backlog instead.
  const unseenDraftsTotal =
    scoped.unseenDrafts.length === view.unseenDrafts.length
      ? view.unseenDraftsTotal
      : scoped.unseenDrafts.length;
  const total =
    scoped.needsReview.length +
    scoped.awaitingInput.length +
    scoped.mentions.length +
    scoped.failedJobs.length +
    scoped.pendingSkillUpdates.length +
    scoped.unseenDrafts.length +
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
          Cross-project items waiting on you — reviews, blocked work, mentions, failures, unseen
          drafts, and offline runners.
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
          <Group title="Skill updates" items={scoped.pendingSkillUpdates} onOpen={open} />
          <Group
            title="Unseen drafts"
            items={scoped.unseenDrafts}
            onOpen={open}
            total={unseenDraftsTotal}
            collapsible
          />
          <Group title="Offline runners" items={scoped.offlineRunners} onOpen={open} />
        </div>
      )}
    </PageContainer>
  );
}
