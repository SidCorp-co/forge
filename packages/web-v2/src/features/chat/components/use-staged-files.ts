"use client";

import { type ClipboardEvent, useCallback, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { type AttachmentPolicy, type StagingRefusal, stageFiles } from "../attachments";

export interface StagedFile {
  id: string;
  file: File;
}

/**
 * The files staged beside a message. Every route in — the dialog, a drop, a paste, a sketch —
 * lands in `take`, so a file is judged by one policy however it arrived and a refusal names it.
 */
export function useStagedFiles(attachments: AttachmentPolicy | undefined, dropDisabled: boolean) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [refusals, setRefusals] = useState<StagingRefusal[]>([]);
  const nextId = useRef(0);

  const take = useCallback(
    (picked: readonly File[]) => {
      if (!attachments) return;
      const outcome = stageFiles(picked, attachments, files.length);
      setRefusals(outcome.refused);
      if (outcome.accepted.length === 0) return;
      setFiles((prev) => [...prev, ...outcome.accepted.map((file) => ({ id: `file-${nextId.current++}`, file }))]);
    },
    [attachments, files.length],
  );

  const dropzone = useDropzone({
    onDrop: take,
    noClick: true,
    noKeyboard: true,
    multiple: true,
    disabled: !attachments || dropDisabled,
  });

  /** A pasted screenshot: only image blobs are pulled in, and a nameless one is given a name. */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const blobs: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        const ext = item.type.split("/")[1] ?? "png";
        blobs.push(file.name ? file : new File([file], `pasted-${blobs.length + 1}.${ext}`, { type: item.type }));
      }
      if (blobs.length === 0) return;
      e.preventDefault();
      take(blobs);
    },
    [take],
  );

  return {
    files,
    refusals,
    take,
    dropzone,
    onPaste: attachments ? onPaste : undefined,
    remove: (id: string) => {
      setFiles((prev) => prev.filter((f) => f.id !== id));
      setRefusals([]);
    },
    clear: () => {
      setFiles([]);
      setRefusals([]);
    },
  };
}
