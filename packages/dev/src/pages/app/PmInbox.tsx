import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PageShell } from "@/components/ui/page-shell";
import { markNotificationRead } from "@/lib/api";
import { pmApi } from "@/features/pm/api";
import { usePmEscalations, type PmEscalation } from "@/features/pm/use-pm-escalations";

interface RowState {
  comment: string;
  submittingOption: string | null;
  error: string | null;
}

const EMPTY_ROW_STATE: RowState = { comment: "", submittingOption: null, error: null };

export function PmInbox() {
  const { escalations, isLoading } = usePmEscalations({ onlyUnread: true });

  return (
    <PageShell
      title="PM Inbox"
      subtitle="Open escalations from the PM agent that require your decision."
      maxWidth="max-w-3xl"
      scrollable
    >
      {isLoading && <p className="text-xs text-gray-500">Loading…</p>}
      {!isLoading && escalations.length === 0 && (
        <p className="rounded border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
          No open escalations.
        </p>
      )}
      <div className="space-y-3">
        {escalations.map((e) => (
          <EscalationRow key={e.notificationId} escalation={e} />
        ))}
      </div>
    </PageShell>
  );
}

function EscalationRow({ escalation }: { escalation: PmEscalation }) {
  const [state, setState] = useState<RowState>(EMPTY_ROW_STATE);
  const qc = useQueryClient();
  const respond = useMutation({
    mutationFn: async (input: { optionId: string; comment?: string }) => {
      if (!escalation.projectId) {
        throw new Error("escalation has no projectId");
      }
      await pmApi.respondToEscalation(escalation.projectId, escalation.decisionId, input);
      await markNotificationRead(escalation.notificationId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pm-escalations"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notifications-unread"] });
    },
  });

  function handleRespond(optionId: string) {
    setState((s) => ({ ...s, submittingOption: optionId, error: null }));
    respond.mutate(
      { optionId, ...(state.comment.trim() ? { comment: state.comment.trim() } : {}) },
      {
        onError: (err) => {
          setState((s) => ({
            ...s,
            submittingOption: null,
            error: err instanceof Error ? err.message : "Failed to respond",
          }));
        },
      },
    );
  }

  return (
    <article className="rounded-lg border border-gray-200 bg-white p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-amber-600">
            {escalation.severity}
          </p>
          <h3 className="mt-0.5 text-sm font-semibold text-gray-900">{escalation.title}</h3>
        </div>
        <span className="text-[10px] text-gray-400">
          {new Date(escalation.createdAt).toLocaleString()}
        </span>
      </header>

      <p className="mt-2 text-sm text-gray-700">{escalation.question}</p>

      <textarea
        rows={2}
        placeholder="Optional comment"
        value={state.comment}
        onChange={(e) => setState((s) => ({ ...s, comment: e.target.value }))}
        className="mt-3 w-full rounded border border-gray-200 bg-white px-3 py-2 text-xs text-gray-900"
      />

      {state.error && <p className="mt-2 text-xs text-red-600">{state.error}</p>}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {escalation.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            disabled={state.submittingOption !== null}
            onClick={() => handleRespond(opt.id)}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {state.submittingOption === opt.id ? "Sending…" : opt.label}
          </button>
        ))}
      </div>

      {escalation.expiresAt && (
        <p className="mt-2 text-[10px] text-gray-400">
          Expires {new Date(escalation.expiresAt).toLocaleString()}
        </p>
      )}
    </article>
  );
}
