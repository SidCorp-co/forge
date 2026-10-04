"use client";

import { describeWireframe } from "@forge/contracts/wireframe";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Button, IconButton, Input } from "@/design";
import { fileBase64, mockupsApi } from "@/features/mockups/api";
import { requirementsApi } from "@/features/requirements/api";
import { formatApiError } from "@/lib/api/error";
import { boardExporter, boardStore, useBoard } from "./board-store";

const BoardCanvas = dynamic(() => import("./board-canvas"), {
  ssr: false,
  loading: () => <p className="fg-body-sm p-4 text-muted">Opening the board…</p>,
});

/** The dock's width while a board is open: wide enough to draw in, still inside the dock's own bound. */
export const BOARD_DOCK_WIDTH = 880;

/** REQ-n is proposed against its open revision, else its head; FB-n and an issue key name themselves. */
async function boardTarget(projectId: string, ref: string) {
  if (/^REQ-\d+$/.test(ref)) {
    const d = await requirementsApi.get(projectId, ref);
    const revision = d.revisions.find((r) => r.state === "draft" || r.state === "proposed")?.revision ?? d.currentRevision ?? 1;
    return { requirement: ref, revision };
  }
  return /^FB-\d+$/.test(ref) ? { feedback: ref } : { issue: ref };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/**
 * The assistant's board inside the chat panel, read-only to the person: the canvas, what it reads as, and Propose — which proposes the
 * board as a wireframe mockup, with its SVG beside it, on the issue, requirement or feedback item named (ISS-78).
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
    if (!doc) return;
    setState({ busy: true, said: null, error: false });
    try {
      const ref = key.trim();
      const target = await boardTarget(projectId, ref);
      const svg = await boardExporter.svg();
      const name = `board-${stamp()}`;
      const caption = describeWireframe(doc);
      const made = await mockupsApi.propose(projectId, { target, kind: "wireframe", document: doc, name: `${name}.wireframe.json`, caption });
      if (svg) {
        await mockupsApi.propose(projectId, {
          target,
          kind: "image",
          name: `${name}.svg`,
          mime: "image/svg+xml",
          caption,
          contentBase64: await fileBase64(new Blob([svg], { type: "image/svg+xml" })),
        });
      }
      setState({ busy: false, said: `Proposed on ${made.mockup.target.key} as ${made.mockup.key}${svg ? " with its picture" : ""}; a person accepts it there.`, error: false });
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
          aria-label="Issue, requirement or feedback item to propose the board on"
          placeholder="ISS-… REQ-… FB-…"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          className="w-40"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!validKey || state.busy || !board.doc}
          onClick={attach}
        >
          {state.busy ? "Proposing…" : `Propose on ${validKey ? key.trim() : "…"}`}
        </Button>
        <IconButton icon="x" size="sm" aria-label="Close the board" onClick={boardStore.close} />
      </header>
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
