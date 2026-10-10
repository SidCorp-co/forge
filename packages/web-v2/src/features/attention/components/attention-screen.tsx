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
  Icon,
  type IconName,
  MonoTag,
  PageContainer,
} from "@/design";
import { TONE_META, type SemanticTone } from "@/design/status";
import { TYPE_LABEL } from "@/features/ecosystem";
import { useOrgScopedProjects } from "@/features/projects";
import { QueryBoundary } from "@/lib/api/query-boundary";
import { useCopy } from "@/lib/i18n/interface-language";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { NeedsYouList } from "@/features/needs-you";
import { useAttention } from "../hooks";
import type { AttentionItem, AttentionKind, AttentionView } from "../types";
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
  status_report: "neutral",
};

const KIND_META: Record<AttentionKind, { icon: IconName; fg: string; bg: string }> = {
  mention: { icon: "mail", ...tone("mention") },
  failed_job: { icon: "alert", ...tone("failed_job") },
  runner_offline: { icon: "server", ...tone("runner_offline") },
  channel_gate: { icon: "check", ...tone("channel_gate") },
  status_report: { icon: "mail", ...tone("status_report") },
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
  const t = useCopy();
  const m = KIND_META[kind];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-2 py-0.5 text-12 font-semibold"
      style={{ color: m.fg, background: m.bg }}
    >
      <Icon name={m.icon} size={13} />
      {t(`attention.kind.${kind}`)}
    </span>
  );
}

export function AttentionItemLine({ item, onOpen }: { item: AttentionItem; onOpen: (link: string) => void }) {
  const t = useCopy();
  return (
    <button
      type="button"
      onClick={() => onOpen(item.link)}
      className="flex w-full items-center gap-3 px-0.5 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-focus max-md:min-h-11"
    >
      <KindTag kind={item.kind} />
      {item.kind === "channel_gate" ? (
        item.documentType && <MonoTag hue="flame">{TYPE_LABEL[item.documentType] ?? item.documentType}</MonoTag>
      ) : (
        item.questionId && <MonoTag hue="flame">{t("attention.decision")}</MonoTag>
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
      className="inline-flex min-w-4.5 items-center justify-center rounded-pill bg-neutral-3 px-1.5 text-12 font-semibold text-muted"
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
  const t = useCopy();
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
            className="flex w-full items-center gap-2 rounded-md px-0.5 py-1 text-left focus-visible:outline-none focus-visible:shadow-focus max-md:min-h-11"
          >
            <Icon
              name="chevronRight"
              size={15}
              className={expanded ? "rotate-90 text-subtle transition-transform duration-150" : "text-subtle transition-transform duration-150"}
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
            <AttentionItemLine key={`${it.kind}-${it.link}-${it.questionId ?? ""}-${it.since}`} item={it} onOpen={onOpen} />
          ))}
          {matched > items.length && (
            <p className="fg-caption px-0.5 text-muted">
              {t("attention.shown", { n: items.length, total: matched })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function AttentionScreen() {
  const t = useCopy();
  const q = useAttention();
  return (
    <QueryBoundary query={{ ...q, data: q.view }} loadingLabel={t("attention.loading")} height="60vh" retry="always">
      {(view) => <Inbox view={view} />}
    </QueryBoundary>
  );
}

function Inbox({ view }: { view: AttentionView }) {
  const t = useCopy();
  const router = useRouter();
  // ISS-477 — scope the inbox to the active org's projects. Items carrying a
  // `projectSlug` outside the active org are dropped; items without one (e.g.
  // offline runners) are kept so device-level alerts never silently vanish.
  const { projects, projectSlugs } = useOrgScopedProjects();
  const keep = (it: AttentionItem) => !it.projectSlug || projectSlugs.has(it.projectSlug);
  const scoped = {
    mentions: view.mentions.filter(keep),
    failedJobs: view.failedJobs.filter(keep),
    channelGates: view.channelGates.filter(keep),
    statusReports: view.statusReports.filter(keep),
    offlineRunners: view.offlineRunners.filter(keep),
  };
  const needsYou = view.needsYou.filter((n) => projectSlugs.has(n.projectSlug));
  const needsYouProjects = projects.filter((p) => needsYou.some((n) => n.projectSlug === p.slug));
  const total =
    needsYou.length +
    scoped.mentions.length +
    scoped.failedJobs.length +
    scoped.channelGates.length +
    scoped.statusReports.length +
    scoped.offlineRunners.length;

  return (
    <PageContainer className="flex min-h-dvh flex-col">
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <PageTitle>{t("attention.title")}</PageTitle>

      {total === 0 ? (
        <div className="grid min-h-72 place-items-center">
          <EmptyState message={t("attention.empty")} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {needsYouProjects.map((p) => (
            <section key={p.id} className="flex flex-col gap-2" aria-label={t("attention.needsYou.in", { name: p.name })}>
              <SectionTitle className="fg-label text-fg">{t("attention.needsYou.title", { name: p.name })}</SectionTitle>
              <NeedsYouList
                items={needsYou.filter((n) => n.projectSlug === p.slug)}
                slug={p.slug}
                foldKey={`web-v2:attention:${p.slug}`}
                empty={t("attention.needsYou.empty")}
              />
            </section>
          ))}
          <Group title={t("attention.group.channelGates")} items={scoped.channelGates} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.mentions")} items={scoped.mentions} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.failedJobs")} items={scoped.failedJobs} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.statusReports")} items={scoped.statusReports} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.offlineRunners")} items={scoped.offlineRunners} onOpen={(href) => router.push(href)} />
        </div>
      )}
    </PageContainer>
  );
}
