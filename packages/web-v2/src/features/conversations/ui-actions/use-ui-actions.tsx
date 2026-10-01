"use client";

import { describeUiSnapshot } from "@forge/contracts/ui-actions";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/design";
import type { CanonicalBlock } from "@/features/session/types";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useAuth } from "@/providers/auth-provider";
import type { ConversationMessage, ConversationProgressEntry } from "../types";
import {
  type UiActionOutcome,
  type UiCallReading,
  applyUiAction,
  hrefWithout,
  readUiCall,
  uiSnapshotOf,
} from "./actions";
import { issueSelectionBridge, useSelectedIssueKeys } from "./selection-bridge";

interface UiCallRecord {
  callId: string;
  entryId: string;
  reading: UiCallReading;
  /** Absent for a call from before this page opened, which is shown and never re-applied. */
  outcome?: UiActionOutcome;
  undone?: boolean;
  cleared?: string[];
}

function uiCallsOf(entryId: string, blocks: readonly CanonicalBlock[] | null | undefined) {
  const out: { callId: string; entryId: string; reading: UiCallReading }[] = [];
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || !b.toolCall) continue;
    const reading = readUiCall(b.toolCall);
    if (reading) out.push({ callId: b.toolCall.id, entryId, reading });
  }
  return out;
}

/** The page beside the chat as the typed snapshot each message carries, and its one-line reading. */
export function useUiSnapshot(slug: string | undefined) {
  const pathname = usePathname() ?? "";
  const search = useLocationSearch();
  const { user } = useAuth();
  const selection = useSelectedIssueKeys();
  return useMemo(() => {
    const snapshot = uiSnapshotOf({
      pathname,
      search,
      userId: user?.id ?? null,
      selection: selection ? selection.split(",") : [],
    });
    return { snapshot, sees: slug ? describeUiSnapshot(snapshot) : null };
  }, [pathname, search, user?.id, selection, slug]);
}

/**
 * Applies each ui_* call the assistant makes in this room, once, as it arrives — from the live turn or
 * the settled row, whichever lands first — and keeps what each did so its card can undo it.
 */
export function useUiActions(args: {
  slug: string;
  ready: boolean;
  messages: readonly ConversationMessage[];
  progress: ConversationProgressEntry | null | undefined;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [records, setRecords] = useState<Record<string, UiCallRecord>>({});
  const history = useRef<Set<string> | null>(null);
  const applied = useRef(new Set<string>());
  const live = useRef(records);
  live.current = records;

  const go = useCallback((href: string) => router.push(href), [router]);
  const env = useMemo(
    () => ({
      slug: args.slug,
      userId: user?.id ?? null,
      href: () => `${window.location.pathname}${window.location.search}`,
      go,
      selection: issueSelectionBridge,
    }),
    [args.slug, user?.id, go],
  );

  useEffect(() => {
    if (!args.ready) return;
    const calls = [
      ...args.messages.flatMap((m) => uiCallsOf(m.id, m.blocks)),
      ...(args.progress ? uiCallsOf(args.progress.entry.id ?? "live", args.progress.entry.blocks as CanonicalBlock[]) : []),
    ];
    if (history.current === null) history.current = new Set(calls.map((c) => c.callId));
    const seen = history.current;
    const fresh = calls.filter((c) => !records[c.callId] && !applied.current.has(c.callId));
    if (fresh.length === 0) return;
    const added: Record<string, UiCallRecord> = {};
    for (const c of fresh) {
      applied.current.add(c.callId);
      if (seen.has(c.callId)) {
        added[c.callId] = c;
        continue;
      }
      const outcome: UiActionOutcome =
        c.reading.kind === "action"
          ? applyUiAction(c.reading.action, env)
          : { ok: false, code: c.reading.code, message: c.reading.message };
      added[c.callId] = { ...c, outcome };
    }
    setRecords((prev) => ({ ...prev, ...added }));
  }, [args.ready, args.messages, args.progress, records, env]);

  const undo = useCallback((callId: string) => {
    const r = live.current[callId];
    if (!r?.outcome?.ok || r.undone) return;
    r.outcome.undo();
    setRecords((prev) => ({ ...prev, [callId]: { ...r, undone: true } }));
  }, []);

  const clearChip = useCallback(
    (callId: string, field: string) => {
      go(hrefWithout(env.href(), field as Parameters<typeof hrefWithout>[1]));
      setRecords((prev) => {
        const r = prev[callId];
        return r ? { ...prev, [callId]: { ...r, cleared: [...(r.cleared ?? []), field] } } : prev;
      });
    },
    [go, env],
  );

  const cardsFor = useCallback(
    (entryId: string) => {
      const mine = Object.values(records).filter((r) => r.entryId === entryId);
      if (mine.length === 0) return null;
      return (
        <div className="mt-2 flex flex-col gap-2">
          {mine.map((r) => (
            <UiActionCard key={r.callId} record={r} onUndo={() => undo(r.callId)} onClear={(f) => clearChip(r.callId, f)} />
          ))}
        </div>
      );
    },
    [records, undo, clearChip],
  );

  return { cardsFor };
}

function UiActionCard({
  record,
  onUndo,
  onClear,
}: {
  record: UiCallRecord;
  onUndo: () => void;
  onClear: (field: string) => void;
}) {
  const { reading, outcome } = record;
  const refused = reading.kind === "refused" || (outcome && !outcome.ok);
  if (refused) {
    const message = outcome && !outcome.ok ? outcome.message : reading.kind === "refused" ? reading.message : "";
    const name = reading.kind === "refused" ? reading.name : reading.action.name;
    return (
      <div
        role="alert"
        data-testid="ui-action-refused"
        className="flex items-start gap-2 rounded-md border px-3 py-2"
        style={{ borderColor: "var(--red-500)", background: "var(--red-50)" }}
      >
        <Icon name="alert" size={14} className="mt-0.5 flex-none text-[color:var(--red-600)]" />
        <p className="fg-body-sm text-fg">
          <span className="font-mono font-semibold">{name}</span> refused — {message}
        </p>
      </div>
    );
  }
  const action = reading.kind === "action" ? reading.action : null;
  const summary = outcome?.ok ? outcome.summary : `${action?.name ?? ""} (applied before this page opened)`;
  const chips = outcome?.ok ? outcome.chips.filter((c) => !record.cleared?.includes(c.field)) : [];
  return (
    <div data-testid="ui-action-card" className="rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name="link" size={13} className="flex-none text-muted" />
        <p className="fg-body-sm min-w-0 flex-1 text-fg">{summary}</p>
        {outcome?.ok && (
          <button
            type="button"
            disabled={record.undone}
            onClick={onUndo}
            className="fg-caption rounded-sm px-1.5 py-0.5 font-semibold text-link hover:underline disabled:text-subtle disabled:no-underline"
          >
            {record.undone ? "Undone" : "Undo"}
          </button>
        )}
      </div>
      {chips.length > 0 && !record.undone && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span
              key={c.field}
              data-testid="ui-filter-chip"
              className="inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-12-5 font-semibold"
              style={{ borderColor: "var(--orange-500, #f97316)", color: "var(--orange-700, #c2410c)", background: "var(--orange-50, #fff7ed)" }}
            >
              {c.label}
              <button type="button" aria-label={`Clear ${c.label}`} onClick={() => onClear(c.field)} className="leading-none">
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
