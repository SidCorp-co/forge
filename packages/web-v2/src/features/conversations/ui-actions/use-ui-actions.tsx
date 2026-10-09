"use client";

import { highlightTargetOf, type UiSnapshot } from "@forge/contracts/ui-actions";
import { describeListFilter } from "@forge/contracts/ui-list-filters";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/design";
import { useHighlight } from "@/design/hooks/use-highlight";
import { useShownKeys } from "@/design/hooks/use-page-shown";
import { enumLabel, statusReading } from "@/design/vocabulary";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import type { CanonicalBlock } from "@/features/session/types";
import { useLocationSearch } from "@/lib/utils/use-location-search";
import { useAuth } from "@/providers/auth-provider";
import type { ConversationMessage, ConversationProgressEntry } from "../types";
import {
  type UiActionOutcome,
  type UiCallReading,
  applyUiAction,
  hrefWithout,
  pageHighlighter,
  readUiCall,
  routeWord,
  shapesText,
  uiSnapshotOf,
} from "./actions";
import { issueSelectionBridge, useSelectedIssueKeys } from "@/features/chat-dock/selection-bridge";
import { useBoard } from "@/features/board/board-store";

export interface UiCallRecord {
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

// The filter words the assistant is told: the identifiers in English, the reader's words otherwise.
function filterParts(f: NonNullable<UiSnapshot["filter"]>, t: Copy, language: string): string[] {
  const word = (label: string, raw: string) => (language === "en" ? raw : label.toLowerCase());
  return [
    f.createdBy && t("conversations.sees.createdByMe"),
    f.assignee && t("conversations.sees.assignedToMe"),
    f.priority && t("conversations.sees.priority", { value: word(enumLabel("priority", f.priority, language), f.priority) }),
    f.status && t("conversations.sees.status", { value: f.status.map((s) => word(statusReading("issue", s, language).label, s)).join("/") }),
    ...(f.waitingOn ? describeListFilter({ waitingOn: f.waitingOn }) : []),
    f.text && `"${f.text}"`,
  ].filter((p): p is string => Boolean(p));
}

/** The rows the list shows, as the one line says them: the first five and how many more. */
function shownText(keys: readonly string[], t: Copy): string {
  const first = keys.slice(0, 5).join(", ");
  return keys.length > 5 ? t("conversations.sees.more", { keys: first, n: keys.length - 5 }) : first;
}

const highlightWords = (h: NonNullable<UiSnapshot["highlight"]>, t: Copy) =>
  h.target === "step" ? `${t("conversations.ui.step")} ${highlightTargetOf(h)}` : highlightTargetOf(h);

/** The one line under the composer: what page the assistant is looking at, in the reader's words. */
export function seesLabel(s: UiSnapshot, t: Copy, language: string): string {
  const parts: string[] = [s.item ? s.item.key : s.route === "other" ? s.path : routeWord(s.route, t)];
  if (s.filter) parts.push(...filterParts(s.filter, t, language));
  if (s.listFilter) parts.push(...describeListFilter(s.listFilter.filter));
  if (s.selection && s.selection.length > 0) parts.push(t("conversations.sees.selected", { n: s.selection.length }));
  if (s.shown?.length) parts.push(t("conversations.sees.showing", { keys: shownText(s.shown, t) }));
  if (s.highlight) parts.push(t("conversations.sees.highlighting", { what: highlightWords(s.highlight, t) }));
  if (s.board) parts.push(t("conversations.sees.boardOf", { shapes: shapesText(s.board.shapes.length, t) }));
  return parts.join(" · ");
}

/** The hover detail of the composer's "Sees" line: every field the assistant is told, one per line. */
export function seesDetail(s: UiSnapshot, at: { project: string | null; scope: "project" | "ecosystem" }, t: Copy, language: string): string {
  const none = t("conversations.sees.none");
  const lines = [
    t("conversations.sees.title"),
    t("conversations.sees.scope", { scope: t(`conversations.scope.${at.scope}`) }),
    t("conversations.sees.project", { project: at.project ?? none }),
    t("conversations.sees.route", { route: routeWord(s.route, t), path: s.path }),
  ];
  if (s.item) lines.push(t("conversations.sees.item", { key: s.item.key }));
  if (s.filter || s.listFilter) {
    const parts = [...(s.filter ? filterParts(s.filter, t, language) : []), ...(s.listFilter ? describeListFilter(s.listFilter.filter) : [])];
    lines.push(t("conversations.sees.filters", { parts: parts.length ? parts.join(", ") : none }));
  }
  if (s.shown) lines.push(t("conversations.sees.shown", { keys: s.shown.length ? shownText(s.shown, t) : none }));
  if (s.highlight) lines.push(t("conversations.sees.highlight", { what: highlightWords(s.highlight, t) }));
  lines.push(t("conversations.sees.selection", { keys: s.selection?.length ? s.selection.join(", ") : none }));
  if (s.board) lines.push(t("conversations.sees.board", { shapes: shapesText(s.board.shapes.length, t) }));
  return lines.join("\n");
}

/** The page beside the chat as the typed snapshot each message carries, and its one-line reading. */
export function useUiSnapshot(slug: string | undefined) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  const pathname = usePathname() ?? "";
  const search = useLocationSearch();
  const { user } = useAuth();
  const selection = useSelectedIssueKeys();
  const board = useBoard();
  const shown = useShownKeys();
  const highlight = useHighlight(pathname);
  return useMemo(() => {
    const snapshot = uiSnapshotOf({
      pathname,
      search,
      userId: user?.id ?? null,
      selection: selection ? selection.split(",") : [],
      board,
      shown,
      highlight,
    });
    return { snapshot, sees: slug ? seesLabel(snapshot, t, language) : null };
  }, [pathname, search, user?.id, selection, slug, board, shown, highlight, t, language]);
}

/**
 * Applies each ui_* call the assistant makes in this room, once, as it arrives in the live turn, and
 * keeps what each did so its card can undo it. Only the person a turn answers is sent its live tool
 * calls (REQ-32 criterion 6), so a call is applied in their browser alone; a call first read off a
 * settled row — another member's turn, or one from before this page opened — is shown, never applied.
 */
export function useUiActions(args: {
  slug: string;
  ready: boolean;
  messages: readonly ConversationMessage[];
  progress: ConversationProgressEntry | null | undefined;
}) {
  const router = useRouter();
  const t = useCopy();
  const language = useInterfaceLanguage();
  const { user } = useAuth();
  const [records, setRecords] = useState<Record<string, UiCallRecord>>({});
  const history = useRef<Set<string> | null>(null);
  const applied = useRef(new Set<string>());
  const live = useRef(records);
  live.current = records;

  const go = useCallback((href: string) => router.push(href), [router]);
  const env = useMemo(
    () => ({
      t,
      language,
      slug: args.slug,
      userId: user?.id ?? null,
      href: () => `${window.location.pathname}${window.location.search}`,
      go,
      selection: issueSelectionBridge,
      ...pageHighlighter,
    }),
    [args.slug, user?.id, go, t, language],
  );

  useEffect(() => {
    if (!args.ready) return;
    const live = args.progress ? uiCallsOf(args.progress.entry.id ?? "live", args.progress.entry.blocks as CanonicalBlock[]) : [];
    const settled = args.messages.flatMap((m) => uiCallsOf(m.id, m.blocks));
    if (history.current === null) history.current = new Set(live.map((c) => c.callId));
    const seen = history.current;
    const liveIds = new Set(live.map((c) => c.callId));
    const fresh = [...live, ...settled.filter((c) => !liveIds.has(c.callId))].filter(
      (c) => !records[c.callId] && !applied.current.has(c.callId),
    );
    if (fresh.length === 0) return;
    const added: Record<string, UiCallRecord> = {};
    for (const c of fresh) {
      applied.current.add(c.callId);
      if (seen.has(c.callId) || !liveIds.has(c.callId)) {
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

export function UiActionCard({
  record,
  onUndo,
  onClear,
}: {
  record: UiCallRecord;
  onUndo: () => void;
  onClear: (field: string) => void;
}) {
  const t = useCopy();
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
          <span className="font-mono font-semibold">{name}</span> {t("conversations.ui.refused", { message })}
        </p>
      </div>
    );
  }
  const action = reading.kind === "action" ? reading.action : null;
  const summary = outcome?.ok ? outcome.summary : t("conversations.ui.appliedBefore", { name: action?.name ?? "" });
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
            {record.undone ? t("conversations.ui.undone") : t("conversations.ui.undo")}
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
              <button type="button" aria-label={t("conversations.ui.clear", { label: c.label })} onClick={() => onClear(c.field)} className="leading-none">
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
