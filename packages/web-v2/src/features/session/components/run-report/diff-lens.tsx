"use client";

// The Diff lens — what the run actually changed, one file at a time.
//
// There is no diff endpoint: the hunks are reconstructed from the Edit/Write
// tool inputs in the transcript (`deriveFilesChanged`), so a file the agent
// changed outside a tool call cannot appear here. That is a real limit, and it
// is why the file list shows counts derived from the same source rather than a
// git stat that would disagree with it.

import { EmptyState } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { shortenPath } from "../../run-report";
import type { FileDiff } from "../../derive";
import { InlineDiff } from "../tool-card";

export function DiffLens({
  files,
  selectedPath,
  onSelect,
  repoPath,
}: {
  files: FileDiff[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  repoPath?: string | null;
}) {
  const t = useCopy();
  const time = useTimeFormat();
  const active = files.find((f) => f.path === selectedPath) ?? files[0];
  if (!active) {
    return <EmptyState title={t("runs.diff.empty")} message={t("runs.diff.emptyBody")} />;
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-line-subtle flex items-center gap-2 border-b px-3 py-2">
        <span className="fg-caption min-w-0 flex-1 truncate font-mono" title={active.path}>
          {shortenPath(active.path, repoPath)}
        </span>
        <span className="fg-caption font-mono" style={{ color: "var(--green-600)" }}>
          +{time.number(active.added)}
        </span>
        <span className="fg-caption font-mono" style={{ color: "var(--red-600)" }}>
          −{time.number(active.removed)}
        </span>
      </div>
      {files.length > 1 && (
        <div className="border-line-subtle flex gap-1 overflow-x-auto border-b px-3 py-1.5">
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelect(file.path)}
              aria-current={file.path === active.path}
              className="fg-caption flex-none rounded-sm px-2 py-1 font-mono hover:bg-hover"
              style={
                file.path === active.path
                  ? { background: "var(--bg-active)", color: "var(--fg-default)" }
                  : undefined
              }
            >
              {file.path.split("/").pop()}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <InlineDiff diff={active} />
      </div>
    </div>
  );
}
