"use client";

// Attention / Inbox (ISS-307) — a cross-project list of items that need the
// caller: issues to review, issues awaiting input (waiting/needs_info — never
// `on_hold`, a pause nobody must answer, ISS-970), @-mentions, failed jobs
// (incl. deploy), and offline runners. Each row links to its source. Live via
// WS: cross-project events only arrive on subscribed rooms, so we fan out a
// `useRoom` per project (the Ops-monitor pattern) — the `['attention']`
// invalidations in `lib/ws/event-router.ts` then refetch.

import { type ReactNode, useState } from "react";
import { useRouter } from "next/navigation";
import { formatRelativeTime } from "@/lib/utils/format";
import {
  Button,
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
import { stuckClause } from "@forge/contracts/stuck-words";
import { failedJobClause, failedJobWords } from "../failed-job-words";
import { useAttention } from "../hooks";
import type { AttentionBucket, AttentionItem, AttentionKind } from "../types";
import { PageTitle, SectionTitle } from "@/design/primitives/heading";

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
      style={{ color: m.fg, background: m.bg, fontSize: "var(--text-11-5)" }}
    >
      <Icon name={m.icon} size={13} style={{ color: m.fg }} />
      {m.label}
    </span>
  );
}

function AttentionRow({ item, onOpen }: { item: AttentionItem; onOpen: (link: string) => void }) {
  const said = item.kind === "failed_job" ? failedJobWords(item) : item.title;
  const lower = item.failedJob ? failedJobClause(item.failedJob) : item.stuckKind ? stuckClause(item.stuckKind) : null;
  const under = item.issueTitle ? (lower ? `${said.replace(/[.]?$/, ".")} ${lower}` : said) : lower;
  return (
    <button
      type="button"
      onClick={() => onOpen(item.link)}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-1 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px] sm:flex-nowrap"
    >
      <KindTag kind={item.kind} />
      {item.questionId && <MonoTag hue="flame">Decision</MonoTag>}
      {/* At phone width the tags take the row, so the title gets a line of its own and wraps there
          rather than being cut to a word (ISS-1229 r13). */}
      <span className="fg-body-sm order-last min-w-0 basis-full text-fg sm:order-none sm:flex-1 sm:basis-auto sm:truncate">
        {item.issueTitle ?? said}
        {/* A failed job is named by its issue; what failed is read under it, in words (ISS-1229 r14). */}
        {under && <span className="fg-caption block text-subtle sm:truncate">{under}</span>}
      </span>
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

/** The bell and a project's headline count only parks past six hours; this group counts every one. */
export const AWAITING_NOTE =
  "Assigned to you, or filed by you and assigned to nobody, however long each has waited. The bell tells a project's admins of those at Waiting after six hours.";

function Group({
  title,
  items,
  onOpen,
  total,
  note,
  onListAll,
  listing = false,
  collapsible: mayCollapse = false,
}: {
  title: string;
  /** What the group counts, where another surface counts the same things differently. */
  note?: string;
  items: AttentionItem[];
  onOpen: (link: string) => void;
  /** Every item the group holds, listed or not: what its heading says. Defaults to items.length. */
  total?: number;
  /** Lists the group whole where its list is capped; absent once it has been asked for. */
  onListAll?: () => void;
  /** Asked for whole and not yet read. */
  listing?: boolean;
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
      {note && <p className="fg-caption -mt-1 px-0.5 text-muted">{note}</p>}
      {expanded && (
        <div>
          {/* Flush rows divided by hairlines, never boxed: the owner's flat rule (ISS-1229 r13). */}
          <ul className="flex flex-col divide-y divide-line-subtle border-y border-line-subtle">
            {items.map((it, i) => (
              <li key={`${it.kind}-${it.link}-${i}`}>
                <AttentionRow item={it} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {matched > items.length && (
            <p className="fg-caption mt-1.5 flex flex-wrap items-center gap-2 px-0.5 text-muted">
              Showing {items.length} of {matched}, highest priority first.
              {(onListAll || listing) && (
                <Button size="sm" variant="secondary" onClick={onListAll} disabled={listing}>
                  {listing ? `Listing all ${matched}…` : `Show all ${matched}`}
                </Button>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function AttentionScreen() {
  const router = useRouter();
  // A capped group the person asked to see whole is read whole; the others keep their caps.
  const [expand, setExpand] = useState<AttentionBucket[]>([]);
  const { view, read, devicesRead, expanding, error, devicesError, refetch } = useAttention({
    expand,
  });
  const listAll = (bucket: AttentionBucket) =>
    expand.includes(bucket) ? undefined : () => setExpand([...expand, bucket]);
  // ISS-477 scoped the inbox to the active org by dropping other orgs' rows here, after the route's
  // caps; ISS-1229 r13 moved that cut into the route, before them. Offline runners are the box's own.
  const { projects } = useOrgScopedProjects();
  // Every item the page holds, listed or not: what the rail badge says too (ISS-1229 r14).
  const total = view.total + view.offlineRunners.length;

  const open = (link: string) => router.push(link);

  if (read === "failed") {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          message={
            devicesRead === "failed"
              ? `${formatApiError(error)} Offline runners could not be read either: ${formatApiError(devicesError)}.`
              : formatApiError(error)
          }
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  // The inbox is the attention list and the offline runners together: neither is read as empty before it has answered.
  if (read === "pending" || devicesRead === "pending") {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading attention…" />
      </div>
    );
  }

  return (
    <PageContainer className="flex min-h-dvh flex-col">
      {projects.map((p) => (
        <RoomSub key={p.id} room={projectRoom(p.id)} />
      ))}

      <header className="mb-5">
        <PageTitle className="fg-h2">Attention</PageTitle>
        <p className="fg-body-sm mt-1 text-muted">
          Cross-project items waiting on you — reviews, blocked work, mentions, failures, unseen
          drafts, and offline runners.
        </p>
      </header>

      {devicesRead === "failed" && (
        <p role="alert" className="fg-body-sm mb-4 text-muted" data-testid="attention-devices-unread">
          Offline runners could not be read: {formatApiError(devicesError)}.{" "}
          {total === 0
            ? "Nothing else is listed, and that does not say nothing needs you."
            : "The list below may leave some out."}{" "}
          <Button size="sm" variant="secondary" onClick={() => refetch()}>
            Try again
          </Button>
        </p>
      )}

      {total === 0 && devicesRead === "failed" ? null : total === 0 ? (
        <div className="grid min-h-[40vh] place-items-center">
          <EmptyState title="Inbox zero" message="Nothing needs your attention right now." />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Group
            title="Needs review"
            items={view.needsReview}
            total={view.bucketTotals.needsReview}
            onListAll={listAll("needsReview")}
            listing={expanding && expand.includes("needsReview")}
            onOpen={open}
          />
          <Group
            title="Awaiting input"
            note={AWAITING_NOTE}
            items={view.awaitingInput}
            total={view.bucketTotals.awaitingInput}
            onListAll={listAll("awaitingInput")}
            listing={expanding && expand.includes("awaitingInput")}
            onOpen={open}
          />
          <Group
            title="Mentions"
            items={view.mentions}
            total={view.bucketTotals.mentions}
            onListAll={listAll("mentions")}
            listing={expanding && expand.includes("mentions")}
            onOpen={open}
          />
          <Group
            title="Failed jobs"
            items={view.failedJobs}
            total={view.bucketTotals.failedJobs}
            onListAll={listAll("failedJobs")}
            listing={expanding && expand.includes("failedJobs")}
            onOpen={open}
          />
          <Group
            title="Skill updates"
            items={view.pendingSkillUpdates}
            total={view.bucketTotals.pendingSkillUpdates}
            onListAll={listAll("pendingSkillUpdates")}
            listing={expanding && expand.includes("pendingSkillUpdates")}
            onOpen={open}
          />
          <Group
            title="Unseen drafts"
            items={view.unseenDrafts}
            onOpen={open}
            total={view.bucketTotals.unseenDrafts}
            onListAll={listAll("unseenDrafts")}
            listing={expanding && expand.includes("unseenDrafts")}
            collapsible
          />
          <Group title="Offline runners" items={view.offlineRunners} onOpen={open} />
        </div>
      )}
    </PageContainer>
  );
}
