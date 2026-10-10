"use client";

// The board's canvas and editor, loaded on first use: Excalidraw is heavy and runs in the browser only.

import dynamic from "next/dynamic";
import { useCopy } from "@/lib/i18n/interface-language";

function OpeningBoard() {
  const t = useCopy();
  return <p className="p-4 text-13 text-muted">{t("common.mockups.openingBoard")}</p>;
}

export const BoardCanvas = dynamic(() => import("./board-canvas"), { ssr: false, loading: () => <OpeningBoard /> });
export const BoardEditor = dynamic(() => import("./board-editor"), { ssr: false, loading: () => <OpeningBoard /> });
