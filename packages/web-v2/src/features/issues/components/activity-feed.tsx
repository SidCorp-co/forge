"use client";

// Activity timeline for the issue detail. Renders the reverse-chron activity
// log: status transitions (from → to), dependency edges, label changes,
// assignment, creation. Comment lifecycle is NOT in the activity log (the
// Comments tab is the source for that).

import { EmptyState, Icon, MonoTag, type IconName } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import type { ActivityItem } from "../types";

interface Node {
  icon: IconName;
  text: React.ReactNode;
}

function describe(item: ActivityItem): Node {
  const p = (item.payload ?? {}) as Record<string, unknown>;
  const from = typeof p.from === "string" ? p.from : undefined;
  const to = typeof p.to === "string" ? p.to : undefined;
  switch (item.action) {
    case "issue.statusChanged":
      return {
        icon: "pipeline",
        text: (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Status {from && <MonoTag>{from}</MonoTag>} <Icon name="arrowRight" size={12} />{" "}
            {to && <MonoTag hue="cobalt">{to}</MonoTag>}
          </span>
        ),
      };
    case "issue.created":
      return { icon: "plus", text: "Issue created" };
    case "issue.dependency.added":
      return { icon: "link", text: "Dependency added" };
    case "issue.dependency.removed":
      return { icon: "link", text: "Dependency removed" };
    case "issue.labeled":
      return { icon: "star", text: "Label added" };
    case "issue.unlabeled":
      return { icon: "star", text: "Label removed" };
    case "issue.assigned":
      return { icon: "agent", text: "Assignee changed" };
    case "issue.priorityChanged":
      return {
        icon: "alert",
        text: (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Priority {from && <MonoTag>{from}</MonoTag>} <Icon name="arrowRight" size={12} />{" "}
            {to && <MonoTag>{to}</MonoTag>}
          </span>
        ),
      };
    default:
      return { icon: "dot", text: item.action };
  }
}

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return <EmptyState title="No activity yet" message="Status changes and edits will show here." mascot={false} />;
  }
  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const node = describe(item);
        return (
          <li key={item.id} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-pill bg-sunken text-subtle">
              <Icon name={node.icon} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="fg-body-sm text-fg">{node.text}</div>
              <div className="fg-caption mt-0.5">
                {item.actorType} · {formatRelativeTime(item.createdAt)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
