// ISS-729 — collapsible left history rail for the single-conversation
// Conversations page. Presentational: owns the collapsed/expanded visual +
// keyboard affordances only — selection, collapse and which of the two sets is
// on screen all live in `ConversationsScreen`. Reads conversations rather than
// sessions since ISS-1004 step 5, and offers the archived set since ISS-1040.

import { Button, EmptyState, ErrorState, IconButton, SessionRowSkeleton, Tooltip } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { groupByRecency } from "../grouping";
import type { ListedConversation } from "../hooks";
import { ConversationRow } from "./conversation-row";

// cm:why the placeholder rows are keyed by a fixed list of names rather than by their index, for the
// reason `conversation-list.tsx` gives over the same six: the set never reorders, and an index key
// on a list that never reorders is still a lint the budget counts.
const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6"];

interface ProjectInfo {
  name: string;
  slug: string;
}

// cm:guard the three actions arrive as props rather than being wired here: the dock's list owns the
// same three, and a second copy of a destructive control is a second place for them to disagree
// about what a press means. Each carries the ROW, which the row's own handler does not need and this
// screen does — its list spans projects, so the mutation has to know which room it is about
// (ISS-1028).
interface ConversationSidebarProps {
  rows: ListedConversation[];
  nameById: Map<string, ProjectInfo>;
  now: number;
  activeConversationId?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNew: () => void;
  onOpen: (row: ListedConversation) => void;
  /** Which of the two sets `rows` holds — the live rooms, or the archived ones. */
  showArchived: boolean;
  /** Ask the caller for the other set. */
  onToggleArchived: () => void;
  loading: boolean;
  error: unknown;
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
  loading,
  error,
  onRetry,
  onClose,
  onRename,
  onArchive,
  onDelete,
}: ConversationSidebarProps) {
  return (
    <div
      className={`flex h-full min-h-0 flex-none flex-col border-r border-line bg-surface transition-[width] ${
        collapsed ? "w-[64px]" : "w-[280px]"
      }`}
    >
      <div className={`flex flex-none items-center gap-1.5 border-b border-line p-2 ${collapsed ? "flex-col" : ""}`}>
        {collapsed ? (
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

      {/* cm:guard the toggle is rendered only while the rail is EXPANDED, and not as a third icon on
          the 64px rail: the rail hides the list entirely, so a control there would swap a set nobody
          can see and read as having done nothing until the rail is opened again. */}
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
            <ErrorState title="Couldn't load conversations" message={formatApiError(error)} onRetry={onRetry} />
          )}

          {!loading && error == null && rows.length === 0 && (
            <EmptyState
              title={showArchived ? "Nothing archived" : "No conversations yet"}
              message={
                showArchived
                  ? "Archive a conversation and it waits for you here."
                  : "Start a conversation with the agent on any project — it'll show up here."
              }
              {...(showArchived
                ? {}
                : { action: { label: "New conversation", onClick: onNew } })}
            />
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
                        project={nameById.get(row.projectId)}
                        open={row.id === activeConversationId}
                        onOpen={() => onOpen(row)}
                        {...(onRename ? { onRename: (title) => onRename(title, row) } : {})}
                        {...(onArchive ? { onArchive: (a) => onArchive(a, row) } : {})}
                        {...(onDelete ? { onDelete: () => onDelete(row) } : {})}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
