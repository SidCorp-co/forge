"use client";

// The Ask agent panel's list of rooms (ISS-1028).
//
// ISS-732 made opening the panel start a NEW chat and said History would stay
// reachable; it stayed reachable on the full-page Conversations screen and
// nowhere in the panel, so closing the panel read as losing the conversation.
// This is the way in that was missing: the same rows the sidebar renders, the
// live set and the archived set behind one toggle, and the three things a person
// does to a room.
//
// It owns the delete confirmation and the archive call. It does NOT own which
// room is open — `ConversationPanel` does, because the chat view needs the same
// answer and a list that held it would be the second copy.

import { useState } from "react";
import { Button, ConfirmDialog, EmptyState, ErrorState, SessionRowSkeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { groupByRecency } from "../grouping";
import {
  type ListedConversation,
  useArchiveConversation,
  useConversations,
  useDeleteConversation,
  useRenameConversation,
} from "../hooks";
import { conversationTitle } from "../types";
import { ConversationRow } from "./conversation-row";

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6"];

export function ConversationList({
  projectId,
  projectName,
  projectSlug,
  activeConversationId,
  onOpen,
  onNew,
  inline = false,
  onGone,
}: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  /** The room the panel currently has open, so its row reads as the open one. */
  activeConversationId?: string | undefined;
  onOpen: (row: ListedConversation) => void;
  onNew: () => void;
  /** Rendered inside the draft's body rather than as the panel's whole view. */
  inline?: boolean;
  onGone: (conversationId: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [confirming, setConfirming] = useState<ListedConversation | null>(null);

  const listQ = useConversations(projectId, showArchived);
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();

  const rows: ListedConversation[] = (listQ.data?.items ?? []).map((row) => ({
    ...row,
    projectId,
  }));
  const project = { name: projectName, slug: projectSlug };

  const doArchive = (row: ListedConversation, archived: boolean) => {
    archive.mutate({ id: row.id, archived }, { onSuccess: () => onGone(row.id) });
  };

  const doDelete = (row: ListedConversation) => {
    setConfirming(null);
    remove.mutate(row.id, { onSuccess: () => onGone(row.id) });
  };

  return (
    <div
      className={inline ? "flex flex-col" : "flex h-full min-h-0 flex-col"}
      data-testid="conversation-list"
    >
      <div
        className={`flex flex-none items-center gap-1.5 p-2 ${inline ? "" : "border-b border-line"}`}
      >
        {inline ? (
          <span className="fg-overline flex-1 px-1 text-subtle">
            {showArchived ? "Archived conversations" : "Your conversations"}
          </span>
        ) : (
          <Button variant="primary" size="sm" icon="plus" className="flex-1" onClick={onNew}>
            New conversation
          </Button>
        )}
        <Button
          variant={showArchived ? "secondary" : "ghost"}
          size="sm"
          icon="archive"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          Archived
        </Button>
      </div>

      <div className={inline ? "p-2" : "min-h-0 flex-1 overflow-y-auto p-2"}>
        {listQ.isLoading && (
          <div className="overflow-hidden rounded-lg border border-line">
            {SKELETON_ROWS.map((k) => (
              <SessionRowSkeleton key={k} />
            ))}
          </div>
        )}

        {!listQ.isLoading && listQ.error != null && (
          <ErrorState
            title="Couldn't load conversations"
            message={formatApiError(listQ.error)}
            onRetry={() => listQ.refetch()}
          />
        )}

        {!listQ.isLoading && listQ.error == null && rows.length === 0 && (
          <EmptyState
            title={showArchived ? "Nothing archived" : "No conversations yet"}
            message={
              showArchived
                ? "Archive a conversation and it waits for you here."
                : "Ask the agent something and it'll show up here."
            }
            {...(showArchived ? {} : { action: { label: "New conversation", onClick: onNew } })}
          />
        )}

        {!listQ.isLoading && listQ.error == null && rows.length > 0 && (
          <div className="space-y-4">
            {groupByRecency(rows).map((bucket) => (
              <div key={bucket.key}>
                <div className="fg-overline px-1 pb-1 text-subtle">{bucket.label}</div>
                <div className="space-y-1">
                  {bucket.rows.map((row) => (
                    <ConversationRow
                      key={row.id}
                      row={row}
                      project={project}
                      open={row.id === activeConversationId}
                      onOpen={() => onOpen(row)}
                      onRename={(title) => rename.mutate({ id: row.id, title })}
                      onArchive={(archived) => doArchive(row, archived)}
                      onDelete={() => setConfirming(row)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title="Delete this conversation?"
        message={
          confirming
            ? `“${conversationTitle(confirming)}” and everything said in it will be gone. Archive it instead to keep it out of the way.`
            : ""
        }
        confirmLabel="Delete"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => confirming && doDelete(confirming)}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
