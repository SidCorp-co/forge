"use client";

import Link from "next/link";
import { useNeedsYou } from "@/features/needs-you/hooks";
import { formatApiError } from "@/lib/api/error";

function Fact({ href, label, value, title }: { href: string; label: string; value: number; title: string }) {
  return (
    <Link
      href={href}
      title={title}
      className="group inline-flex items-baseline gap-2 rounded-sm focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <span className="text-13 text-muted group-hover:text-fg">{label}</span>
      <span className="text-20 font-semibold tabular-nums text-fg">{value}</span>
    </Link>
  );
}

// cm:why one flat row beside today's dashboard (the prototype keeps the layout and adds only this): both
// figures come from the needs-you read the menu counts read, so the row, the menu and the lists agree
export function DeliveryRow({ projectId, slug }: { projectId: string; slug: string }) {
  const q = useNeedsYou(projectId);
  return (
    <section
      aria-label="Delivery"
      data-testid="delivery-row"
      className="flex min-h-11 flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-line-subtle py-3"
    >
      {q.error ? (
        <span className="text-13 text-muted">Delivery counts could not be read: {formatApiError(q.error)}</span>
      ) : q.data ? (
        <>
          <Fact
            href={`/projects/${slug}/requirements?group=status`}
            label="Requirements in delivery"
            value={q.data.requirementsInDelivery}
            title="Requirements whose state is In delivery: agreed, with issues being built"
          />
          <Fact
            href={`/projects/${slug}/feedback`}
            label="Untriaged feedback"
            value={q.data.untriagedFeedback}
            title="Feedback that is new or reopened, waiting for a person to pick a route"
          />
        </>
      ) : (
        <span className="text-13 text-muted">Reading delivery counts…</span>
      )}
    </section>
  );
}
