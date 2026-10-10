"use client";

// A kept idea preview drawn as a requirement's picture (REQ-41 BC-16): the page's one rrweb snapshot,
// drawn still by rrweb's own replayer paused on it (a sandboxed frame it makes itself, scripts off),
// the branch it was built on, and "Reopen live", which starts a new idea preview from the stored head.
// Nothing here is a screenshot: the still is the page as the DOM it was.

import type { KeptPreviewContent } from "@forge/contracts/requirement-pictures";
import { useEffect, useRef, useState } from "react";
import { Button, RefusedLine } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useMutation } from "@tanstack/react-query";
import { ideaApi } from "../idea-api";
import { IdeaPreview } from "./idea-preview";

/**
 * Draw `events` (Meta then FullSnapshot) into `root` as one still. rrweb is a heavy bundle, so it is
 * read when a kept picture is first drawn, not with the page.
 */
export async function drawStill(root: HTMLElement, events: KeptPreviewContent["snapshot"]): Promise<() => void> {
  const { Replayer } = await import("rrweb");
  await import("rrweb/dist/style.css");
  root.replaceChildren();
  const replayer = new Replayer(events, { root, mouseTail: false, skipInactive: false, UNSAFE_replayCanvas: false, speed: 1 });
  replayer.pause(0);
  return () => replayer.destroy();
}

export function KeptPreviewPicture({ content, alt, projectId, reqKey, slug, canWrite }: { content: KeptPreviewContent; alt: string; projectId: string; reqKey: string; slug: string; canWrite: boolean }) {
  const t = useCopy();
  const stageRef = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<"drawing" | "drawn" | "failed">("drawing");
  const reopen = useMutation({
    mutationFn: () => ideaApi.open(projectId, { about: reqKey, brief: t("previews.idea.reopen.brief", { alt }), from: content.previewId }),
  });

  useEffect(() => {
    const root = stageRef.current;
    if (!root) return;
    let undo: (() => void) | null = null;
    let gone = false;
    setDrawn("drawing");
    drawStill(root, content.snapshot).then(
      (stop) => {
        if (gone) stop();
        else {
          undo = stop;
          setDrawn("drawn");
        }
      },
      () => !gone && setDrawn("failed"),
    );
    return () => {
      gone = true;
      undo?.();
    };
  }, [content.snapshot]);

  const meta = content.snapshot[0]?.data as { width?: number; height?: number } | undefined;
  return (
    <div className="grid gap-2" data-testid="kept-preview">
      <div
        ref={stageRef}
        aria-hidden
        data-testid="kept-preview-still"
        data-drawn={drawn}
        className="max-h-105 min-h-40 overflow-auto border border-line-subtle bg-surface [&_.replayer-mouse]:hidden"
        style={meta?.width ? { aspectRatio: `${meta.width} / ${Math.min(meta.height ?? meta.width, meta.width)}` } : undefined}
      />
      {drawn === "failed" ? (
        <p role="alert" className="text-13 text-muted">
          {t("previews.idea.kept.stillFailed")}
        </p>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-muted">
        <span>{t("previews.idea.kept.built", { branch: content.branch, files: content.files.length })}</span>
        <span className="font-mono">{content.head.slice(0, 9)}</span>
        {canWrite && !reopen.data ? (
          <Button type="button" size="sm" variant="secondary" loading={reopen.isPending} onClick={() => reopen.mutate()}>
            {t("previews.idea.reopen.button")}
          </Button>
        ) : null}
      </p>
      <RefusedLine label={t("previews.idea.reopen.failed")} error={reopen.error} className="text-13 text-danger-11" />
      {reopen.data ? <IdeaPreview preview={reopen.data} about={reqKey} canWrite={canWrite} slug={slug} /> : null}
    </div>
  );
}
