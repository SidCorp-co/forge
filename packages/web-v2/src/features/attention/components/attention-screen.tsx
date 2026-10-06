"use client";

// Attention / Inbox (ISS-307): a cross-project list of what needs the caller. Each project's
// needs-you rows come from core's one needs-you read model; beside them @-mentions, failed jobs
// (incl. deploy), skill updates, channel gates and offline runners. Live via WS: cross-project
// events only arrive on subscribed rooms, so a `useRoom` fans out per project and the
// `['attention']` invalidations in `lib/ws/event-router.ts` refetch.

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
import { TYPE_LABEL } from "@/features/ecosystem/types";
import { useOrgScopedProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { NeedsYouList } from "@/features/needs-you/components/needs-you-list";
import { useAttention } from "../hooks";
import type { AttentionItem, AttentionKind } from "../types";
import { PageTitle, SectionTitle } from "@/design/primitives/heading";

/** Per-kind presentation. ISS-509: color resolves through the semantic tone
 *  layer (one source of truth) so a `failed` job (failure/red) and an offline
 *  runner (infra/slate) are no longer the same red; color is paired with an icon
 *  + label so status is never conveyed by color alone (a11y: color-not-only). */
const KIND_TONE: Record<AttentionKind, SemanticTone> = {
  mention: "neutral",
  failed_job: "failure",
  runner_offline: "infra",
  channel_gate: "attention",
};

const KIND_META: Record<AttentionKind, { label: string; icon: IconName; fg: string; bg: string }> = {
  mention: { label: "Mention", icon: "mail", ...tone("mention") },
  failed_job: { label: "Failed", icon: "alert", ...tone("failed_job") },
  runner_offline: { label: "Runner offline", icon: "server", ...tone("runner_offline") },
  channel_gate: { label: "Approve gate", icon: "check", ...tone("channel_gate") },
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
      style={{ color: m.fg, background: m.bg, fontSize: "var(--text-11-5)" }}
    >
      <Icon name={m.icon} size={13} style={{ color: m.fg }} />
      {m.label}
    </span>
  );
}

export function AttentionRow({ item, onOpen }: { item: AttentionItem; onOpen: (link: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item.link)}
      className="flex w-full items-center gap-3 px-0.5 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]"
    >
      <KindTag kind={item.kind} />
      {item.kind === "channel_gate" ? (
        item.documentType && <MonoTag hue="flame">{TYPE_LABEL[item.documentType] ?? item.documentType}</MonoTag>
      ) : (
        item.questionId && <MonoTag hue="flame">Decision</MonoTag>
      )}
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
      style={{ fontSize: "var(--text-11)", lineHeight: "16px", color: "var(--fg-muted)", background: "var(--paper-100)" }}
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
  const collapsible = mayCollapse && items.length > COLLAPSE_ABOVE;
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (items.length === 0) return null;
  const expanded = collapsible ? (toggled ?? false) : true;
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle className="fg-label text-fg">
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
      </SectionTitle>
      {expanded && (
        <div className="flex flex-col divide-y divide-line-subtle">
          {items.map((it) => (
            <AttentionRow key={`${it.kind}-${it.link}-${it.questionId ?? ""}-${it.since}`} item={it} onOpen={onOpen} />
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
    mentions: view.mentions.filter(keep),
    failedJobs: view.failedJobs.filter(keep),
    channelGates: view.channelGates.filter(keep),
    offlineRunners: view.offlineRunners.filter(keep),
  };
  const needsYou = view.needsYou.filter((n) => projectSlugs.has(n.projectSlug));
  const needsYouProjects = projects.filter((p) => needsYou.some((n) => n.projectSlug === p.slug));
  const total =
    needsYou.length +
    scoped.mentions.length +
    scoped.failedJobs.length +
    scoped.channelGates.length +
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
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <PageTitle
          hint="Cross-project items waiting on you: every project's needs-you rows, mentions, failures and offline runners."
        >
          Attention
      </PageTitle>

      {total === 0 ? (
        <div className="grid min-h-[40vh] place-items-center">
          <EmptyState title="Inbox zero" message="Nothing needs your attention right now." />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {needsYouProjects.map((p) => (
            <section key={p.id} className="flex flex-col gap-2" aria-label={`Needs you in ${p.name}`}>
              <SectionTitle className="fg-label text-fg">Needs you · {p.name}</SectionTitle>
              <NeedsYouList
                items={needsYou.filter((n) => n.projectSlug === p.slug)}
                slug={p.slug}
                foldKey={`web-v2:attention:${p.slug}`}
                empty="Nothing waits on you here."
              />
            </section>
          ))}
          <Group title="Channel gates" items={scoped.channelGates} onOpen={open} />
          <Group title="Mentions" items={scoped.mentions} onOpen={open} />
          <Group title="Failed jobs" items={scoped.failedJobs} onOpen={open} />
          <Group title="Offline runners" items={scoped.offlineRunners} onOpen={open} />
        </div>
      )}
    </PageContainer>
  );
}
