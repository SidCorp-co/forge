"use client";

// Activity timeline for the issue detail: each event, newest first, as a sentence that opens with
// who acted (`activity-sentences.ts`), "You" for the reader, and under it whether an agent acted and when.

import { Badge, EmptyState, Icon } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { useAuth } from "@/providers/auth-provider";
import { activitySentence, type SentencePart } from "../activity-sentences";
import type { ActivityItem } from "../types";

/** The sentence's runs, adjacent words joined into one text so the line reads as one sentence. */
function Sentence({ parts }: { parts: SentencePart[] }) {
  const runs = parts.reduce<SentencePart[]>((acc, part) => {
    const last = acc[acc.length - 1];
    if (typeof part === "string" && typeof last === "string") acc[acc.length - 1] = last + part;
    else acc.push(part);
    return acc;
  }, []);
  return (
    <>
      {runs.map((run, i) =>
        typeof run === "string" ? (
          run
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a sentence's runs never reorder
          <span key={i} className="font-medium">
            {run.strong}
          </span>
        ),
      )}
    </>
  );
}

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const { user } = useAuth();
  if (items.length === 0) {
    return <EmptyState title="No activity yet" message="Status changes and edits will show here." mascot={false} />;
  }
  return (
    <ol className="space-y-3">
      {items.map((item) => {
        const said = activitySentence(item, user?.id);
        const isAgent = item.actor?.isAgent ?? item.actorType === "device";
        return (
          <li key={item.id} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-pill bg-sunken text-subtle">
              <Icon name={said.icon} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="fg-body-sm text-fg">
                <Sentence parts={[`${said.actor} `, ...said.did]} />
              </div>
              <div className="fg-caption mt-0.5 flex flex-wrap items-center gap-1.5">
                {isAgent && (
                  <Badge tone="accent">
                    <span className="inline-flex items-center gap-1">
                      <Icon name="agent" size={11} />
                      Agent
                    </span>
                  </Badge>
                )}
                <span>{formatRelativeTime(item.createdAt)}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
