"use client";

import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/design";
import type { ProjectListItem } from "@/features/projects/types";
import type { ChatTarget } from "../dock-target";
import { dockSections } from "../grouping";
import {
  type ListedConversation,
  useArchiveConversation,
  useDeleteConversation,
  usePinConversation,
  useRenameConversation,
} from "../hooks";
import { conversationTitle } from "../types";
import { ConversationRow } from "./conversation-row";

/** The listed rooms in their dock sections, with each row's actions and the delete confirmation. */
export function ConversationSections({
  rows,
  projects,
  current,
  pageKey,
  conversationId,
  onSelect,
}: {
  rows: ListedConversation[];
  projects: ProjectListItem[];
  current: ProjectListItem | undefined;
  pageKey: string | null;
  conversationId: string | null;
  onSelect: (target: ChatTarget) => void;
}) {
  const [confirming, setConfirming] = useState<ListedConversation | null>(null);
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();
  const pin = usePinConversation();
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const leave = (id: string) => {
    if (id === conversationId) onSelect(current ? { kind: "draft", projectId: current.id } : { kind: "people" });
  };

  return (
    <>
      {dockSections(rows, {
        projectId: current?.id ?? null,
        pageKey,
        projectName: (id) => byId.get(id)?.name ?? "A project you cannot open",
      }).map((section) => (
        <section key={section.key} aria-label={section.label}>
          <h3 className="bg-sunken px-3 py-1 text-11-5 font-bold text-muted">{section.label}</h3>
          {section.rows.map((row) => (
            <ConversationRow
              key={row.id}
              row={row}
              project={byId.get(row.projectId)}
              open={row.id === conversationId}
              onOpen={() => onSelect({ kind: "room", projectId: row.projectId, conversationId: row.id })}
              onRename={(title) => rename.mutate({ id: row.id, title })}
              onArchive={(a) => archive.mutate({ id: row.id, archived: a }, { onSuccess: () => leave(row.id) })}
              onDelete={() => setConfirming(row)}
              onPin={(pinned) => pin.mutate({ id: row.id, pinned })}
            />
          ))}
        </section>
      ))}
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
        onConfirm={() => {
          if (!confirming) return;
          const id = confirming.id;
          remove.mutate(id, { onSuccess: () => leave(id) });
          setConfirming(null);
        }}
        onClose={() => setConfirming(null)}
      />
    </>
  );
}
