"use client";

import { Banner, Button, Icon, IconButton, Textarea } from "@/design";
// Message composer — Textarea + Send. Enter sends, Shift+Enter inserts a
// newline. Shared by the run thread + Chat. ≥44px touch targets. Pinned with
// `position: sticky` by default (the page-scroll run thread); the bounded "My
// conversations" drawer passes `sticky={false}` for a flow-positioned bottom
// bar (ISS-506).
// With `allowAttachments` (the "My conversations" Chat surface, ISS-499) it also
// stages files: attach button + preview chips + remove + image paste. The run
// thread leaves it off, so its UI is unchanged.
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useRef,
  useState,
} from "react";

// Mirror core's session attachment allow-list (agent-sessions/attachment-service
// ALLOWED_MIMES) + UPLOADS_MAX_BYTES so the server never 400s what we staged.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface ComposerProps {
  /**
   * Deliver the message (+ staged files). MUST reject (throw) on failure — the
   * composer clears the input only when this resolves, so a failed send keeps
   * the typed text + files for retry instead of discarding them (ISS-462).
   */
  onSend: (message: string, files: File[]) => Promise<void>;
  /** Disable input entirely (e.g. no device available). */
  disabled?: boolean;
  /** Send is in flight / the agent is busy. */
  busy?: boolean;
  placeholder?: string;
  /** Enable file attachment UI (Chat / "My conversations" only, ISS-499). */
  allowAttachments?: boolean;
  /**
   * Pin the band with `position: sticky` (default — the run-thread page-scroll
   * surface). The bounded "My conversations" drawer passes `false` so the band
   * is a normal flow-positioned `flex-none` bottom bar: a cross-scroll-boundary
   * sticky inside the drawer desynced paint vs. hit-test, leaving the composer
   * visible but unclickable in some browsers/zoom levels (ISS-506).
   */
  sticky?: boolean;
}

/** Band wrapper styling shared by the Composer + the read-only note. `sticky`
    (default) keeps the page-scroll run-thread behavior; `false` flattens it into
    an opaque flow-positioned bottom bar for the bounded drawer (ISS-506). */
function bandClass(sticky: boolean, pad: string): string {
  return sticky
    ? `sticky bottom-0 z-10 border-t border-line bg-app/95 backdrop-blur ${pad}`
    : `flex-none border-t border-line bg-app ${pad}`;
}

/** Rendered in place of the Composer for project viewers (read-only role). */
export function ReadOnlyComposerNote({ sticky = true }: { sticky?: boolean }) {
  return (
    <div className={bandClass(sticky, "px-4 py-4 sm:px-6")}>
      <p className="fg-body-sm text-center text-muted">Read-only access</p>
    </div>
  );
}

export function Composer({
  onSend,
  disabled,
  busy,
  placeholder = "Send a message…",
  allowAttachments = false,
  sticky = true,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Sendable when there's text OR at least one staged file.
  const canSend = !disabled && !busy && (value.trim().length > 0 || files.length > 0);

  // Validate + stage picked/pasted files against the allow-list (size/mime/count
  // caps) so the server never rejects what we accepted.
  const acceptFiles = useCallback((picked: FileList | File[]) => {
    const accepted: File[] = [];
    const errs: string[] = [];
    for (const f of Array.from(picked)) {
      if (f.size <= 0) {
        errs.push(`Empty file skipped: ${f.name || "(unnamed)"}`);
        continue;
      }
      if (f.size > MAX_BYTES) {
        errs.push(`Too large (max 10 MB): ${f.name || "(unnamed)"}`);
        continue;
      }
      const mime = f.type || "application/octet-stream";
      if (!ALLOWED_MIMES.has(mime)) {
        errs.push(`File type not allowed: ${f.name || mime}`);
        continue;
      }
      accepted.push(f);
    }
    setFiles((prev) => {
      const room = MAX_FILES - prev.length;
      if (accepted.length > room) {
        errs.push(`Max ${MAX_FILES} attachments. Extras skipped.`);
      }
      return [...prev, ...accepted.slice(0, Math.max(0, room))];
    });
    setWarnings(errs);
  }, []);

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) acceptFiles(e.target.files);
      e.target.value = "";
    },
    [acceptFiles],
  );

  // Clipboard paste of a copied/screenshotted image. Only image blobs are pulled
  // in; pasted text falls through to the Textarea. Clipboard images often have
  // an empty name → supply one.
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!allowAttachments) return;
      const blobs: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          if (file.name) {
            blobs.push(file);
          } else {
            const ext = item.type.split("/")[1] ?? "png";
            blobs.push(new File([file], `pasted-${blobs.length + 1}.${ext}`, { type: item.type }));
          }
        }
      }
      if (blobs.length) {
        e.preventDefault();
        acceptFiles(blobs);
      }
    },
    [allowAttachments, acceptFiles],
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setWarnings([]);
  };

  const submit = async () => {
    if (!canSend) return;
    const text = value.trim();
    const staged = files;
    try {
      await onSend(text, staged);
      // Clear only on success — a thrown send (e.g. 409 no online runner)
      // leaves the typed text + files in place so the user can retry (ISS-462).
      setValue("");
      setFiles([]);
      setWarnings([]);
    } catch {
      // Keep the text + files; the parent surfaces the error (Banner + toast).
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={bandClass(sticky, "px-4 py-3 sm:px-6")}
      onPaste={allowAttachments ? onPaste : undefined}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 xl:max-w-4xl">
        {allowAttachments && warnings.length > 0 && (
          <Banner tone="attention">
            <ul className="space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        )}

        {allowAttachments && files.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center gap-2.5 rounded-md border border-line-subtle bg-surface px-2.5 py-1.5"
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
                  aria-label={`Remove ${f.name}`}
                  disabled={busy}
                  onClick={() => removeFile(i)}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Single rounded input container (Gemini-style) — attach + textarea +
            send live inside ONE bordered box instead of three flex siblings,
            with the focus ring moving to the container so it reads as one
            control (ISS-714). */}
        <div className="flex w-full items-end gap-1 rounded-2xl border border-line-strong bg-surface py-1.5 pl-1.5 pr-2 transition-shadow focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)]">
          {allowAttachments && (
            <>
              <IconButton
                type="button"
                variant="ghost"
                icon="plus"
                aria-label="Attach files"
                className="h-11 w-11 flex-none"
                disabled={disabled || busy}
                onClick={() => fileInputRef.current?.click()}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                // Hint the native picker toward the allow-list (acceptFiles still
                // re-validates every pick; `accept` is advisory, not a guarantee).
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md"
                className="hidden"
                onChange={onPick}
              />
            </>
          )}
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            placeholder={
              disabled ? "No device online — start a runner to chat." : placeholder
            }
            className="max-h-40 min-h-11 min-w-0 flex-1 border-0 bg-transparent px-1.5 py-2.5 shadow-none focus-visible:shadow-none"
            aria-label="Message"
          />
          <Button
            variant="primary"
            size="md"
            icon="arrowRight"
            aria-label="Send message"
            className="h-11 w-11 flex-none rounded-full p-0"
            loading={busy}
            disabled={!canSend}
            onClick={submit}
          />
        </div>
      </div>
    </div>
  );
}
