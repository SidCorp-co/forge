"use client";

import { describeWireframe } from "@forge/contracts/wireframe";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Button, IconButton, Input } from "@/design";
import { issueDetailApi } from "@/features/issues/detail-api";
import { formatApiError } from "@/lib/api/error";
import { boardExporter, boardStore, useBoard } from "./board-store";

const BoardCanvas = dynamic(() => import("./board-canvas"), {
  ssr: false,
  loading: () => <p className="fg-body-sm p-4 text-muted">Opening the board…</p>,
});

/** The dock's width while a board is open: wide enough to draw in, still inside the dock's own bound. */
export const BOARD_DOCK_WIDTH = 880;

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/**
 * The board inside the chat panel: the canvas, what it reads as, and Attach — which stores the board on
 * an issue as `board-<time>.wireframe.json` (the spec a run reads) and its SVG beside it.
 */
export function BoardPanel({ projectId, issueKey }: { projectId: string; issueKey?: string | undefined }) {
  const board = useBoard();
  const [key, setKey] = useState(issueKey ?? "");
  const [state, setState] = useState<{ busy: boolean; said: string | null; error: boolean }>({
    busy: false,
    said: null,
    error: false,
  });

  const attach = async () => {
    const doc = board.doc;
    if (!doc || board.refused) return;
    setState({ busy: true, said: null, error: false });
    try {
      const issue = await issueDetailApi.get(key.trim(), projectId);
      const name = `board-${stamp()}`;
      const json = new File([JSON.stringify(doc, null, 2)], `${name}.wireframe.json`, { type: "application/json" });
      await issueDetailApi.uploadAttachment(issue.id, json);
      const svg = await boardExporter.svg();
      if (svg) await issueDetailApi.uploadAttachment(issue.id, new File([svg], `${name}.svg`, { type: "image/svg+xml" }));
      setState({ busy: false, said: `Attached to ${issue.displayId ?? key} as ${name}.wireframe.json${svg ? " + .svg" : ""}`, error: false });
    } catch (err) {
      setState({ busy: false, said: formatApiError(err), error: true });
    }
  };

  const validKey = /^[A-Z][A-Z0-9]*-\d+$/.test(key.trim());
  return (
    <section data-testid="board-panel" className="flex h-full min-h-0 flex-col border-b border-line">
      <header className="flex flex-none flex-wrap items-center gap-2 px-3 py-2">
        <p className="fg-body-sm min-w-0 flex-1 truncate font-semibold text-fg">
          {board.doc ? describeWireframe(board.doc) : "Board"}
        </p>
        <Input
          aria-label="Issue to attach the board to"
          placeholder="ISS-…"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          className="w-28"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!validKey || state.busy || Boolean(board.refused) || !board.doc}
          onClick={attach}
          title={board.refused ?? undefined}
        >
          {state.busy ? "Attaching…" : `Attach to ${validKey ? key.trim() : "issue"}`}
        </Button>
        <IconButton icon="x" size="sm" aria-label="Close the board" onClick={boardStore.close} />
      </header>
      {board.refused && (
        <p role="alert" data-testid="board-refused" className="fg-caption flex-none px-3 pb-2 text-[color:var(--red-600)]">
          {board.refused}
        </p>
      )}
      {state.said && (
        <p
          role={state.error ? "alert" : "status"}
          className={`fg-caption flex-none px-3 pb-2 ${state.error ? "text-[color:var(--red-600)]" : "text-muted"}`}
        >
          {state.said}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <BoardCanvas />
      </div>
    </section>
  );
}
