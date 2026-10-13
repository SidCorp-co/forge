// The board's canvas and editor, loaded on first use: Excalidraw is heavy, so it sits in chunks of
// its own that only these two reach.

import { type ComponentProps, Suspense, lazy } from "react";
import { useCopy } from "@/lib/i18n/interface-language";

const Canvas = lazy(() => import("./board-canvas"));
const Editor = lazy(() => import("./board-editor"));

function OpeningBoard() {
  const t = useCopy();
  return <p className="p-4 text-13 text-muted">{t("common.mockups.openingBoard")}</p>;
}

export function BoardCanvas(props: ComponentProps<typeof Canvas>) {
  return (
    <Suspense fallback={<OpeningBoard />}>
      <Canvas {...props} />
    </Suspense>
  );
}

export function BoardEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={<OpeningBoard />}>
      <Editor {...props} />
    </Suspense>
  );
}
