// ISS-729 — collapsible left history rail for the single-conversation
// Conversations page. Presentational: owns the collapsed/expanded visual +
// keyboard affordances only — selection, collapse and which of the two sets is
// on screen all live in `ConversationsScreen`. Reads conversations rather than
// sessions since ISS-1004 step 5, and offers the archived set since ISS-1040.

import { Button, EmptyState, ErrorState, IconButton, SessionRowSkeleton, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { groupByRecency } from "../grouping";
import type { ListedConversation } from "../hooks";
import { READ_ONLY_LIST_EMPTY } from "../membership";
import { ConversationRow, projectsOfRow } from "./conversation-row";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6"];

/** The room open beside the list, where the list's organization does not hold it: the organizations by name, where known. */
export interface OpenElsewhere {
  roomOrg: string | null;
  listOrg: string | null;
}

/** Why the open room is not in the list: the list holds one organization's rooms (ISS-1229 r49, judge-146). */
export function openElsewhereLine({ roomOrg, listOrg }: OpenElsewhere): string {
  return `The room open beside this list is in ${roomOrg ?? "another organization"}; this list shows the rooms of ${listOrg ?? "this organization"} only.`;
}

interface ProjectInfo {
  name: string;
  slug: string;
}

interface ConversationSidebarProps {
  rows: ListedConversation[];
  nameById: Map<string, ProjectInfo>;
  now: number;
  activeConversationId?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Absent where the reader may start no room: the list offers none (ISS-1229 r35, judge-95). */
  onNew?: (() => void) | undefined;
  onOpen: (row: ListedConversation) => void;
  /** Which of the two sets `rows` holds — the live rooms, or the archived ones. */
  showArchived: boolean;
  /** Ask the caller for the other set. */
  onToggleArchived: () => void;
  loading: boolean;
  error: unknown;
  /** Names the read that failed: the list stands on the projects read as well as its own (ISS-1229 r48). */
  errorTitle: string;
  onRetry: () => void;
  /** Set when rendered inside the mobile drawer — swaps the collapse toggle
   *  for a close action (collapsing to an icon rail makes no sense inside a
   *  SlideOver, and the drawer's own Esc/backdrop-click already close it, but
   *  a visible close control is still expected here). */
  onClose?: () => void;
  /** Commit a new title for a row. Absent = the rows show no rename control. */
  onRename?: (title: string, row: ListedConversation) => void;
  /** File a row away, or bring it back. */
  onArchive?: (archived: boolean, row: ListedConversation) => void;
  /** Ask to delete a row — the caller owns the confirmation. */
  onDelete?: (row: ListedConversation) => void;
  /** Whether the reader may rename, archive or delete this row; absent = every row. */
  mayChange?: (row: ListedConversation) => boolean;
  /** Shown under the rows: the organization's rooms whose projects are gone (ISS-1229 r23). */
  below?: React.ReactNode;
  /** Set only while the open room is another organization's, so the list never says it holds none. */
  openElsewhere?: OpenElsewhere | null;
}

export function ConversationSidebar({
  rows,
  nameById,
  now,
  activeConversationId,
  collapsed,
  onToggleCollapse,
  onNew,
  onOpen,
  showArchived,
  onToggleArchived,
  below,
  loading,
  error,
  errorTitle,
  onRetry,
  onClose,
  onRename,
  onArchive,
  onDelete,
  mayChange = () => true,
  openElsewhere = null,
}: ConversationSidebarProps) {
  const elsewhere = openElsewhere && !showArchived ? openElsewhere : null;
  return (
    <div
      data-testid="conversation-sidebar"
      // In the drawer the list fills it, so a phone shows no blank white beside a 280px column
      // (ISS-1229 r28, judge-80 at 390).
      className={`flex h-full min-h-0 flex-none flex-col border-r border-line bg-surface transition-[width] ${
        onClose ? "w-full" : collapsed ? "w-[64px]" : "w-[280px]"
      }`}
    >
      <div className={`flex flex-none items-center gap-1.5 border-b border-line p-2 ${collapsed ? "flex-col" : ""}`}>
        {!onNew ? (
          <span className="flex-1" />
        ) : collapsed ? (
          <Tooltip label="New conversation">
            <IconButton icon="plus" aria-label="New conversation" variant="secondary" onClick={onNew} />
          </Tooltip>
        ) : (
          <Button variant="primary" size="sm" icon="plus" className="flex-1" onClick={onNew}>
            New conversation
          </Button>
        )}
        {onClose ? (
          <IconButton icon="x" aria-label="Close history" onClick={onClose} />
        ) : (
          <IconButton
            icon={collapsed ? "chevronRight" : "panelLeft"}
            aria-label={collapsed ? "Expand history" : "Collapse history"}
            aria-pressed={collapsed}
            onClick={onToggleCollapse}
          />
        )}
      </div>

      {!collapsed && (
        <div className="flex flex-none items-center gap-1.5 border-b border-line px-2 py-1.5">
          <span className="fg-overline flex-1 px-1 text-subtle">
            {showArchived ? "Archived conversations" : "Your conversations"}
          </span>
          <Button
            variant={showArchived ? "secondary" : "ghost"}
            size="sm"
            icon="archive"
            aria-pressed={showArchived}
            onClick={onToggleArchived}
          >
            Archived
          </Button>
        </div>
      )}

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="overflow-hidden rounded-lg border border-line">
              {SKELETON_ROWS.map((k) => (
                <SessionRowSkeleton key={k} />
              ))}
            </div>
          )}

          {!loading && error != null && (
            <ErrorState title={errorTitle} message={formatApiError(error)} onRetry={onRetry} />
          )}

          {!loading && error == null && rows.length === 0 && (
            <EmptyState
              title={
                showArchived
                  ? "Nothing archived"
                  : elsewhere
                    ? `No conversations in ${elsewhere.listOrg ?? "this organization"}`
                    : "No conversations yet"
              }
              message={
                showArchived
                  ? "Archive a conversation and it waits for you here."
                  : elsewhere
                    ? openElsewhereLine(elsewhere)
                    : onNew
                      ? "Start a conversation with the agent on any project — it'll show up here."
                      : READ_ONLY_LIST_EMPTY
              }
              {...(showArchived || !onNew
                ? {}
                : { action: { label: "New conversation", onClick: onNew, icon: "plus" } })}
            />
          )}

          {!loading && error == null && rows.length > 0 && elsewhere && (
            <p className="fg-caption mb-3 px-1 text-muted" data-testid="open-room-elsewhere">
              {openElsewhereLine(elsewhere)}
            </p>
          )}

          {!loading && error == null && rows.length > 0 && (
            <div className="space-y-4">
              {groupByRecency(rows, now).map((bucket) => (
                <div key={bucket.key}>
                  <div className="fg-overline px-1 pb-1 text-subtle">{bucket.label}</div>
                  <div className="space-y-1">
                    {bucket.rows.map((row) => (
                      <ConversationRow
                        key={row.id}
                        row={row}
                        projects={projectsOfRow(row, (id) => nameById.get(id))}
                        open={row.id === activeConversationId}
                        onOpen={() => onOpen(row)}
                        {...(onRename && mayChange(row) ? { onRename: (title) => onRename(title, row) } : {})}
                        {...(onArchive && mayChange(row) ? { onArchive: (a) => onArchive(a, row) } : {})}
                        {...(onDelete && mayChange(row) ? { onDelete: () => onDelete(row) } : {})}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {below}
        </div>
      )}
    </div>
  );
}
