"use client";

// Activity timeline for the issue detail. Renders the reverse-chron activity
// log: status transitions (from → to), field edits (the paths each write
// moved), dependency edges, label changes, assignment, creation. Comment rows
// show by action only; the Comments tab is the source for those.

import { formatFieldPath, isIssueUpdatedPayload } from "@forge/contracts/field-changes";
import { Badge, EmptyState, EnumBadge, Icon, MonoTag, sentenceCase, StatusBadge, type IconName } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { ActivityItem } from "../types";

interface Node {
  icon: IconName;
  text: React.ReactNode;
}

function describe(item: ActivityItem, t: Copy): Node {
  const p = (item.payload ?? {}) as Record<string, unknown>;
  const from = typeof p.from === "string" ? p.from : undefined;
  const to = typeof p.to === "string" ? p.to : undefined;
  switch (item.action) {
    case "issue.statusChanged":
      return {
        icon: "pipeline",
        text: (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {t("issues.field.status")} {from && <StatusBadge family="issue" value={from} />} <Icon name="arrowRight" size={12} />{" "}
            {to && <StatusBadge family="issue" value={to} />}
          </span>
        ),
      };
    case "issue.created":
      return { icon: "plus", text: t("issues.activity.created") };
    case "issue.updated":
      return { icon: "rename", text: describeUpdate(p, t) };
    case "issue.dependency.added":
      return { icon: "link", text: t("issues.activity.depAdded") };
    case "issue.dependency.removed":
      return { icon: "link", text: t("issues.activity.depRemoved") };
    case "issue.labeled":
      return { icon: "star", text: t("issues.activity.labelAdded") };
    case "issue.unlabeled":
      return { icon: "star", text: t("issues.activity.labelRemoved") };
    case "issue.assigned":
      return { icon: "agent", text: t("issues.activity.assigneeChanged") };
    case "issue.priorityChanged":
      return {
        icon: "alert",
        text: (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {t("issues.field.priority")} {from && <EnumBadge family="priority" value={from} />} <Icon name="arrowRight" size={12} />{" "}
            {to && <EnumBadge family="priority" value={to} />}
          </span>
        ),
      };
    default:
      // An action this build has no line for reads as words, never as its `issue.someAction` key.
      return { icon: "dot", text: sentenceCase(item.action.replace(/^issue\./, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()) };
  }
}

/** Up to this many changed paths are named; the rest are counted. */
const NAMED_PATHS = 3;

// An `issue.updated` row records the paths a write moved (`@forge/contracts` field-changes), so
// the line names those paths rather than repeating the fields' values.
function describeUpdate(payload: Record<string, unknown>, t: Copy): React.ReactNode {
  if (!isIssueUpdatedPayload(payload) || payload.changes.length === 0) return t("issues.activity.updatedNone");
  const paths = payload.changes.map((c) => formatFieldPath(c.path));
  const rest = paths.length - NAMED_PATHS;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {t("issues.activity.updated")}{" "}
      {paths.slice(0, NAMED_PATHS).map((path) => (
        <MonoTag key={path}>{path}</MonoTag>
      ))}
      {rest > 0 && <span>{t("issues.activity.more", { n: rest })}</span>}
    </span>
  );
}

// a move that waived its verdicts writes both its `issue.statusChanged` line and a `record.transition`
// (ISS-96, ISS-166); the feed draws the move once, from the first
const DRAWN_ELSEWHERE = new Set(["record.transition"]);

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const shown = items.filter((item) => !DRAWN_ELSEWHERE.has(item.action));
  const t = useCopy();
  const time = useTimeFormat();
  if (shown.length === 0) {
    return <EmptyState title={t("issues.activity.emptyTitle")} message={t("issues.activity.empty")} mascot={false} />;
  }
  return (
    <ol className="space-y-3">
      {shown.map((item) => {
        const node = describe(item, t);
        // Prefer the server-resolved actor (member email / agent device name)
        // over the bare actorType. Fall back to the raw type for older payloads;
        // never show just "user"/"device" when a name is available (ISS-519).
        const isAgent = item.actor?.isAgent ?? item.actorType === "device";
        const actorLabel = item.actor?.displayName ?? sentenceCase(item.actorType);
        return (
          <li key={item.id} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-pill bg-sunken text-subtle">
              <Icon name={node.icon} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="fg-body-sm text-fg">{node.text}</div>
              <div className="fg-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                <span className="truncate">{actorLabel}</span>
                {isAgent && (
                  <Badge tone="accent">
                    <span className="inline-flex items-center gap-1">
                      <Icon name="agent" size={11} />
                      {t("issues.assignee.agent")}
                    </span>
                  </Badge>
                )}
                <span title={time.dateTime(item.createdAt)}>· {time.relative(item.createdAt)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
