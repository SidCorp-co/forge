"use client";

// ISS-465 — scalable conversation history panel.
// Replaces the flat single-line `Menu` switcher in chat-screen.tsx with a
// popover that adds:
//   - client-side search (title)
//   - Today / Yesterday / Previous 7 days / Older grouping (updatedAt)
//   - per-row kebab: Rename (inline) · Archive · Delete (window.confirm)
//   - "Show archived" toggle that refetches with ?archived=true
//
// Rendered as a self-managing popover (own outside-click close, keyboard Esc),
// triggered by an external Button that owns the open state. The panel is
// position-absolute under the trigger; render INSIDE the same relatively-
// positioned wrapper that holds the trigger.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon, IconButton, Input, Toggle } from "@/design";
import { formatRelativeTime } from "@/lib/utils/format";
import { sessionApi } from "../api";
import { useArchiveSession, useDeleteSession, useRenameSession } from "../hooks";
import type { SessionRow } from "@/features/sessions/types";

const AGENT_TYPE = "agent";

type Bucket = { key: "today" | "yesterday" | "week" | "older"; label: string; rows: SessionRow[] };

function bucketFor(iso: string, now: number): Bucket["key"] {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "older";
  const ageMs = now - then;
  const dayMs = 24 * 60 * 60 * 1000;
  // "Today" / "Yesterday" honour the local calendar day so a chat from 11pm
  // last night reads as "Yesterday", not "1d ago today".
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (then >= todayStart.getTime()) return "today";
  if (then >= todayStart.getTime() - dayMs) return "yesterday";
  if (ageMs <= 7 * dayMs) return "week";
  return "older";
}

function groupByRecency(rows: SessionRow[], now = Date.now()): Bucket[] {
  const buckets: Record<Bucket["key"], Bucket> = {
    today: { key: "today", label: "Today", rows: [] },
    yesterday: { key: "yesterday", label: "Yesterday", rows: [] },
    week: { key: "week", label: "Previous 7 days", rows: [] },
    older: { key: "older", label: "Older", rows: [] },
  };
  for (const r of rows) {
    const k = bucketFor(r.updatedAt, now);
    buckets[k].rows.push(r);
  }
  return [buckets.today, buckets.yesterday, buckets.week, buckets.older].filter((b) => b.rows.length > 0);
}

/** Display title for a row — auto-titled (ISS-462) sessions look like the first
 *  user message, untitled rows fall back to a short id. Single source of truth
 *  so rename/preview/header all agree. */
export function conversationTitle(s: Pick<SessionRow, "id" | "title">): string {
  const t = s.title?.trim();
  return t && t.length > 0 ? t : `Chat ${s.id.slice(0, 8)}`;
}

interface ConversationListProps {
  /** Anchor: render inside a relatively-positioned wrapper. */
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** The active conversation list rows (already loaded by the screen). */
  rows: SessionRow[];
  /** id of the currently-resolved conversation, marked with ● in the list. */
  activeId: string | undefined;
  onPick: (s: SessionRow) => void;
  /** Called when the currently-active conversation is archived/deleted, so the
   *  screen can clear its resolved id instead of pointing at a gone row. */
  onActiveRemoved?: () => void;
}

export function ConversationList({
  open,
  onClose,
  projectId,
  rows,
  activeId,
  onPick,
  onActiveRemoved,
}: ConversationListProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const rename = useRenameSession();
  const archive = useArchiveSession();
  const remove = useDeleteSession();

  // Lazy-load the archived set only when the toggle is on; cheap (page 20).
  const archivedQ = useQuery({
    queryKey: ["agent-sessions", "chat", projectId, "archived"],
    queryFn: () => sessionApi.listByType(projectId, AGENT_TYPE, 20, true),
    enabled: !!projectId && showArchived,
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Reset transient panel state when it closes — a stale `renamingId` should
  // not still be editing next time the user opens History.
  useEffect(() => {
    if (!open) {
      setRenamingId(null);
      setRenameDraft("");
      setSearch("");
    }
  }, [open]);

  const sourceRows = showArchived ? archivedQ.data?.items ?? [] : rows;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sourceRows;
    return sourceRows.filter((r) => conversationTitle(r).toLowerCase().includes(q));
  }, [sourceRows, search]);

  const buckets = useMemo(() => groupByRecency(filtered), [filtered]);

  if (!open) return null;

  const beginRename = (s: SessionRow) => {
    setRenamingId(s.id);
    setRenameDraft(conversationTitle(s));
  };

  const commitRename = (s: SessionRow) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    if (!next || next === conversationTitle(s)) return;
    rename.mutate({ id: s.id, title: next });
  };

  const handleArchive = (s: SessionRow) => {
    archive.mutate({ id: s.id, archived: !showArchived, metadata: s.metadata });
    if (s.id === activeId) onActiveRemoved?.();
  };

  const handleDelete = (s: SessionRow) => {
    if (!window.confirm(`Delete "${conversationTitle(s)}"? This can't be undone.`)) return;
    remove.mutate(s.id);
    if (s.id === activeId) onActiveRemoved?.();
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Conversation history"
      className="forge-drop absolute right-0 top-[calc(100%+6px)] z-50 w-[360px] overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
    >
      <div className="border-b border-line p-2">
        <Input
          icon="search"
          placeholder="Search conversations…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="fg-overline">{showArchived ? "Archived" : "Recent"}</span>
          <label className="inline-flex items-center gap-2 text-xs text-muted">
            <span>Show archived</span>
            <Toggle checked={showArchived} onChange={setShowArchived} />
          </label>
        </div>
      </div>

      <div className="max-h-[60dvh] overflow-y-auto p-1.5">
        {showArchived && archivedQ.isLoading && (
          <div className="fg-caption px-3 py-4 text-center text-subtle">Loading archived…</div>
        )}

        {buckets.length === 0 ? (
          <div className="fg-caption px-3 py-6 text-center text-subtle">
            {search.trim() ? "No matches." : showArchived ? "No archived conversations." : "No conversations yet."}
          </div>
        ) : (
          buckets.map((b) => (
            <div key={b.key} className="mb-2 last:mb-0">
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-subtle">
                {b.label}
              </div>
              {b.rows.map((s) => {
                const active = s.id === activeId;
                const editing = renamingId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover ${
                      active ? "bg-hover" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => !editing && onPick(s)}
                      className="min-w-0 flex-1 text-left focus-visible:outline-none"
                    >
                      {editing ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(s)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename(s);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setRenamingId(null);
                              setRenameDraft("");
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full rounded border border-line-strong bg-app px-1.5 py-0.5 text-sm text-fg focus-visible:border-[color:var(--link)] focus-visible:outline-none"
                        />
                      ) : (
                        <div className="truncate text-sm text-fg">
                          {active && <span aria-hidden>● </span>}
                          {conversationTitle(s)}
                        </div>
                      )}
                      <div className="fg-caption mt-0.5 text-subtle">{formatRelativeTime(s.updatedAt)}</div>
                    </button>
                    {!editing && (
                      <RowMenu
                        onRename={() => beginRename(s)}
                        onArchive={() => handleArchive(s)}
                        onDelete={() => handleDelete(s)}
                        archivedView={showArchived}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Per-row kebab: own its open state so closing a row's menu doesn't dismiss
 *  the whole popover. */
function RowMenu({
  onRename,
  onArchive,
  onDelete,
  archivedView,
}: {
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  archivedView: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <IconButton
        icon="more"
        size="sm"
        aria-label="Conversation actions"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      />
      {open && (
        <div
          role="menu"
          className="forge-drop absolute right-0 top-[calc(100%+4px)] z-50 min-w-[160px] overflow-hidden rounded-md border border-line bg-surface p-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuRow icon="settings" label="Rename" onSelect={() => { setOpen(false); onRename(); }} />
          <MenuRow
            icon={archivedView ? "rerun" : "archive"}
            label={archivedView ? "Restore" : "Archive"}
            onSelect={() => { setOpen(false); onArchive(); }}
          />
          <MenuRow icon="trash" label="Delete" danger onSelect={() => { setOpen(false); onDelete(); }} />
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  onSelect,
  danger,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover focus-visible:bg-hover focus-visible:outline-none ${
        danger ? "text-[color:var(--red-600)]" : "text-fg"
      }`}
    >
      <Icon name={icon} size={14} className={danger ? "text-[color:var(--red-500)]" : "text-subtle"} />
      {label}
    </button>
  );
}

/** Inline title editor for the chat-screen header — click the title to edit,
 *  Enter/blur commits, Esc cancels. Reuses useRenameSession so the toast +
 *  invalidation match the list rail. */
export function EditableTitle({
  session,
  className,
}: {
  session: SessionRow;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(conversationTitle(session));
  const rename = useRenameSession();

  useEffect(() => {
    if (!editing) setValue(conversationTitle(session));
  }, [session, editing]);

  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === conversationTitle(session)) return;
    rename.mutate({ id: session.id, title: next });
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setValue(conversationTitle(session));
          }
        }}
        className={`rounded border border-line-strong bg-app px-2 py-1 text-sm text-fg focus-visible:border-[color:var(--link)] focus-visible:outline-none ${
          className ?? ""
        }`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to rename conversation"
      className={`group inline-flex max-w-full items-center gap-1.5 truncate text-left hover:text-accent-text focus-visible:outline-none ${
        className ?? ""
      }`}
    >
      <span className="truncate">{conversationTitle(session)}</span>
    </button>
  );
}
