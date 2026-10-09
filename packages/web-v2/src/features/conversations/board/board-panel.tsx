"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Button, IconButton, Input } from "@/design";
import { fileBase64, mockupsApi } from "@/features/mockups/api";
import { formatApiError } from "@/lib/api/error";
import { boardExporter, boardStore, useBoard } from "@/features/board/board-store";
import { useCopy } from "@/lib/i18n/interface-language";
import { productCopy } from "@/lib/i18n/product-copy";
import { describeBoard } from "../ui-actions/actions";

function OpeningBoard() {
  const t = useCopy();
  return <p className="fg-body-sm p-4 text-muted">{t("conversations.board.opening")}</p>;
}

const BoardCanvas = dynamic(() => import("@/features/board/board-canvas"), {
  ssr: false,
  loading: () => <OpeningBoard />,
});

/** The dock's width while a board is open: wide enough to draw in, still inside the dock's own bound. */
export const BOARD_DOCK_WIDTH = 880;

/** A requirement takes no mockup: its picture is each revision's own, drawn on the requirement (REQ-35). */
const REQUIREMENT_KEY = /^REQ-\d+$/;

/** FB-n names a feedback item; any other key, an issue. */
const boardTarget = (ref: string) => (/^FB-\d+$/.test(ref) ? { feedback: ref } : { issue: ref });

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/**
 * The assistant's board inside the chat panel, read-only to the person: the canvas, what it reads as, and Propose — which proposes the
 * board as a wireframe mockup, with its SVG beside it, on the issue or feedback item named (ISS-78). A requirement key is
 * refused here by name: a requirement's picture is drawn on the requirement, never proposed (REQ-35).
 */
export function BoardPanel({ projectId, issueKey }: { projectId: string; issueKey?: string | undefined }) {
  const t = useCopy();
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
      const target = boardTarget(ref);
      const svg = await boardExporter.svg();
      const name = `board-${stamp()}`;
      // stored beside the mockup, so it is the same line whoever proposes it, in whatever language
      const caption = describeBoard(doc, productCopy());
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
      setState({ busy: false, said: t("conversations.board.proposed", { target: made.mockup.target.key, key: made.mockup.key, picture: svg ? t("conversations.board.withPicture") : "" }), error: false });
    } catch (err) {
      setState({ busy: false, said: formatApiError(err), error: true });
    }
  };

  const requirementKey = REQUIREMENT_KEY.test(key.trim());
  const validKey = /^[A-Z][A-Z0-9]*-\d+$/.test(key.trim()) && !requirementKey;
  return (
    <section data-testid="board-panel" className="flex h-full min-h-0 flex-col border-b border-line">
      <header className="flex flex-none flex-wrap items-center gap-2 px-3 py-2">
        <p className="fg-body-sm min-w-0 flex-1 truncate font-semibold text-fg">
          {board.doc ? describeBoard(board.doc, t) : t("conversations.board.title")}
        </p>
        <Input
          aria-label={t("conversations.board.targetLabel")}
          placeholder="ISS-… FB-…"
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
          {state.busy ? t("conversations.board.proposing") : t("conversations.board.proposeOn", { key: validKey ? key.trim() : "…" })}
        </Button>
        <IconButton icon="x" size="sm" aria-label={t("conversations.board.close")} onClick={boardStore.close} />
      </header>
      {requirementKey && (
        <p role="alert" className="fg-caption flex-none px-3 pb-2 text-[color:var(--red-600)]">
          {t("conversations.board.notRequirement", { key: key.trim() })}
        </p>
      )}
      {state.said && !requirementKey && (
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
