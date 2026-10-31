
// Attention / Inbox (ISS-307): a cross-project list of what needs the caller. Each project's
// needs-you rows come from core's one needs-you read model; beside them @-mentions, failed jobs
// (incl. deploy), skill updates, channel gates and offline runners. Live via WS: cross-project
// events only arrive on subscribed rooms, so a `useRoom` fans out per project and the
// `['attention']` invalidations in `lib/ws/event-router.ts` refetch.

import { type ReactNode, useState } from "react";
import { useRouter } from "@/lib/navigation/router";
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
import { DecisionList } from "@/features/needs-you";
import { approvalsHref } from "@/lib/routes/approvals";
import { NEEDS_YOU_PERSON_CAP } from "@forge/contracts/steward";
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

function AttentionItemLine({ item, onOpen }: { item: AttentionItem; onOpen: (link: string) => void }) {
  const t = useCopy();
  const title = item.kind === "runner_offline" ? t("attention.runnerOffline", { name: item.deviceName ?? item.title }) : item.title;
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
      <span className="fg-body-sm min-w-0 flex-1 truncate text-fg">{title}</span>
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
  count,
  collapsible: mayCollapse = false,
}: {
  title: string;
  items: AttentionItem[];
  onOpen: (link: string) => void;
  /** The bucket's row count, as core's attention read model serves it. */
  count: number;
  collapsible?: boolean;
}) {
  const t = useCopy();
  const matched = count;
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
  // Core scopes the view to the active org (ISS-477), counts it and sums its total (REQ-12 BC-19).
  const { projects } = useOrgScopedProjects();

  return (
    <PageContainer className="flex min-h-dvh flex-col">
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <PageTitle>{t("attention.title")}</PageTitle>

      {view.total === 0 ? (
        <div className="grid min-h-72 place-items-center">
          <EmptyState message={t("attention.empty")} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {view.needsYou.map((part) => (
            <section key={part.projectSlug} className="flex flex-col gap-2" aria-label={t("attention.needsYou.in", { name: part.projectName })} data-testid="attention-needs-you" data-total={part.total}>
              <SectionTitle className="fg-label text-fg">{t("attention.needsYou.title", { name: part.projectName })}</SectionTitle>
              <DecisionList read={{ decisions: part.decisions, total: part.total, notDecisions: [] }} slug={part.projectSlug} cap={NEEDS_YOU_PERSON_CAP} moreHref={approvalsHref(part.projectSlug)} />
            </section>
          ))}
          <Group title={t("attention.group.channelGates")} items={view.channelGates} count={view.counts.channelGates} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.mentions")} items={view.mentions} count={view.counts.mentions} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.failedJobs")} items={view.failedJobs} count={view.counts.failedJobs} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.statusReports")} items={view.statusReports} count={view.counts.statusReports} onOpen={(href) => router.push(href)} />
          <Group title={t("attention.group.offlineRunners")} items={view.offlineRunners} count={view.counts.offlineRunners} onOpen={(href) => router.push(href)} />
        </div>
      )}
    </PageContainer>
  );
}
