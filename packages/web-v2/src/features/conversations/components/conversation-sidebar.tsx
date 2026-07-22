// ISS-729 — collapsible left history rail for the redesigned single-chat
// Conversations page (ChatGPT/Claude/Gemini model). Presentational: owns the
// collapsed/expanded visual + keyboard affordances only, selection/collapse
// state lives in `ConversationsScreen`.
import { Button, EmptyState, ErrorState, IconButton, SessionRowSkeleton, Tooltip } from "@/design";
import { groupByRecency } from "@/features/sessions/grouping";
import type { SessionRow } from "@/features/sessions/types";
import { formatApiError } from "@/lib/api/error";
import { ConversationRow } from "./conversation-row";

interface ProjectInfo {
  name: string;
  slug: string;
}

interface ConversationSidebarProps {
  rows: SessionRow[];
  nameById: Map<string, ProjectInfo>;
  now: number;
  activeSessionId?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNew: () => void;
  onOpen: (row: SessionRow) => void;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Set when rendered inside the mobile drawer — swaps the collapse toggle
   *  for a close action (collapsing to an icon rail makes no sense inside a
   *  SlideOver, and the drawer's own Esc/backdrop-click already close it, but
   *  a visible close control is still expected here). */
  onClose?: () => void;
}

export function ConversationSidebar({
  rows,
  nameById,
  now,
  activeSessionId,
  collapsed,
  onToggleCollapse,
  onNew,
  onOpen,
  loading,
  error,
  onRetry,
  onClose,
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

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="overflow-hidden rounded-lg border border-line">
              {Array.from({ length: 6 }).map((_, i) => (
                <SessionRowSkeleton key={i} />
              ))}
            </div>
          )}

          {!loading && error != null && (
            <ErrorState title="Couldn't load conversations" message={formatApiError(error)} onRetry={onRetry} />
          )}

          {!loading && error == null && rows.length === 0 && (
            <EmptyState
              title="No conversations yet"
              message="Start a conversation with the agent on any project — it'll show up here."
              action={{ label: "New conversation", onClick: onNew }}
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
                        now={now}
                        open={row.id === activeSessionId}
                        onOpen={() => onOpen(row)}
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
