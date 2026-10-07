"use client";

// Files staged on a comment or a new issue before they are sent: picked, dropped or pasted,
// checked against the attachment allow-list (size/mime/count caps) so the server never rejects
// what was accepted here.

import { Banner, Icon, IconButton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";

const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;
const DOC_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/html",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const VIDEO_MIMES = ["video/mp4", "video/webm", "video/quicktime"];
const DOC_EXTS = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.html,.txt,.md,.csv,.docx,.xls,.xlsx,.log,.sql";
const VIDEO_EXTS = ".mp4,.webm,.mov";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A staged file's list key: two staged files may share a name, so the File itself is the identity.
const fileKeys = new WeakMap<File, number>();
let nextFileKey = 0;
const keyOf = (file: File): number => {
  if (!fileKeys.has(file)) fileKeys.set(file, ++nextFileKey);
  return fileKeys.get(file) as number;
};

function nameKey(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\\/]+/g, "_")
    .replace(/[\p{C}\p{Z}]/gu, "_")
    .replace(/[^\p{L}\p{M}\p{N}._-]/gu, "_");
}

function uniqueStagedName(name: string, used: Set<string>): string {
  if (!used.has(nameKey(name))) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}${ext}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
}

/** An issue holds one file per name, so `uniqueNames` renames a clash; a comment does not. */
export function useStagedFiles({
  unit,
  video,
  uniqueNames,
}: {
  unit: "comment" | "issue";
  video: boolean;
  uniqueNames: boolean;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const t = useCopy();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const allowed = new Set(video ? [...DOC_MIMES, ...VIDEO_MIMES] : DOC_MIMES);
  const accept = [...allowed, video ? `${DOC_EXTS},${VIDEO_EXTS}` : DOC_EXTS, "text/*"].join(",");

  const acceptFiles = (picked: FileList | File[]) => {
    const accepted: File[] = [];
    const errs: string[] = [];
    for (const f of Array.from(picked)) {
      if (f.size <= 0) {
        errs.push(t("issues.files.empty", { name: f.name || t("issues.files.unnamed") }));
      } else if (f.size > MAX_BYTES) {
        errs.push(t("issues.files.tooLarge", { name: f.name || t("issues.files.unnamed") }));
      } else if (!(allowed.has(f.type) || f.type === "" || f.type.startsWith("text/"))) {
        errs.push(t("issues.files.typeNotAllowed", { name: f.name || f.type }));
      } else {
        accepted.push(f);
      }
    }
    setFiles((prev) => {
      const room = MAX_FILES - prev.length;
      if (accepted.length > room) errs.push(t(unit === "issue" ? "issues.files.tooManyIssue" : "issues.files.tooManyComment", { max: MAX_FILES }));
      const staged = accepted.slice(0, Math.max(0, room));
      if (!uniqueNames) return [...prev, ...staged];
      const used = new Set(prev.map((f) => nameKey(f.name)));
      return [
        ...prev,
        ...staged.map((f) => {
          const unique = uniqueStagedName(f.name, used);
          used.add(nameKey(unique));
          if (unique === f.name) return f;
          errs.push(t("issues.files.renamed", { from: f.name, to: unique }));
          return new File([f], unique, { type: f.type });
        }),
      ];
    });
    setWarnings(errs);
  };

  const dropZone = {
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) acceptFiles(e.dataTransfer.files);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
  };

  const onPaste = (e: ClipboardEvent) => {
    const blobs: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const ext = item.type.split("/")[1] ?? "png";
      blobs.push(
        file.name ? file : new File([file], `pasted-${blobs.length + 1}.${ext}`, { type: item.type }),
      );
    }
    if (blobs.length) {
      e.preventDefault();
      acceptFiles(blobs);
    }
  };

  const reset = useCallback(() => {
    setFiles([]);
    setWarnings([]);
    setDragOver(false);
  }, []);

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={accept}
      className="hidden"
      onChange={(e) => {
        if (e.target.files?.length) acceptFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  return {
    files,
    warnings,
    dragOver,
    dropZone,
    onPaste,
    input,
    choose: () => inputRef.current?.click(),
    remove: (index: number) => {
      setFiles((prev) => prev.filter((_, i) => i !== index));
      setWarnings([]);
    },
    reset,
  };
}

export function StagedFileList({
  files,
  warnings,
  remove,
  spaced = false,
}: {
  files: File[];
  warnings: string[];
  remove: (index: number) => void;
  spaced?: boolean;
}) {
  const t = useCopy();
  const banner = warnings.length > 0 && (
    <Banner tone="attention">
      <ul className="space-y-0.5">
        {[...new Set(warnings)].map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </Banner>
  );
  return (
    <>
      {spaced && banner ? <div className="mt-2">{banner}</div> : banner}
      {files.length > 0 && (
        <ul className={`${spaced ? "mt-2.5 " : ""}flex flex-col divide-y divide-line-subtle`}>
          {files.map((f, i) => (
            <li
              key={keyOf(f)}
              className="flex items-center gap-2.5 py-1.5"
            >
              <Icon
                name={f.type.startsWith("image/") ? "grid" : "folder"}
                size={15}
                className="flex-none text-subtle"
              />
              <span className="fg-body-sm min-w-0 flex-1 truncate text-fg" title={f.name}>
                {f.name}
              </span>
              <span className="fg-caption flex-none">{formatSize(f.size)}</span>
              <IconButton
                type="button"
                icon="x"
                size="sm"
                aria-label={t("issues.toolbar.removeChip", { label: f.name })}
                onClick={() => remove(i)}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
