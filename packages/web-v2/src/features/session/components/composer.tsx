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
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import type { InvokableSkill } from "@/features/skills/types";
import { filterSkillsByQuery, findSlashToken, replaceSlashToken } from "../slash-token";
import { SlashSkillsMenu, type SlashSkillsSource } from "./slash-skills-menu";

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
  /**
   * Controls rendered inside the bordered input row, left of the textarea and
   * right of the attach `+` (ISS-718 — the model picker goes here). A slot
   * rather than a prop per control so the run thread, which passes nothing,
   * keeps exactly its current row.
   */
  actions?: ReactNode;
  /**
   * Enables the `/`-autocomplete (ISS-718). Absent, or `items` empty with
   * nothing loading and no error, and the `/` trigger is not rendered at all —
   * a control that can do nothing must not be shown, even greyed out.
   */
  slashSkills?: SlashSkillsSource;
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
  placeholder = "Message the agent…",
  allowAttachments = false,
  sticky = true,
  actions,
  slashSkills,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const slashPanelRef = useRef<HTMLDivElement>(null);
  // Sendable when there's text OR at least one staged file.
  const canSend = !disabled && !busy && (value.trim().length > 0 || files.length > 0);

  // cm:guard `slashOpen` must stay a separate flag from "a token exists" (ISS-718) — a token remains under the caret after Escape, so deriving openness from the token alone re-opens the panel the user just dismissed and makes Escape look broken
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashCaret, setSlashCaret] = useState(0);
  // cm:guard the trigger exists only once there is something to insert, but loading AND error keep it visible — otherwise the button appears and vanishes as the query settles, and a failed fetch becomes invisible instead of offering its retry
  const skillsKnown = !!slashSkills;
  const hasSkills =
    skillsKnown &&
    (slashSkills.items.length > 0 || slashSkills.loading || !!slashSkills.error);
  const slashToken = skillsKnown ? findSlashToken(value, slashCaret) : null;
  const slashMatches = slashToken
    ? filterSkillsByQuery(slashSkills?.items ?? [], slashToken.query)
    : [];
  const slashMenuOpen = slashOpen && !!slashToken && hasSkills && !disabled;

  /** Sync the token state from the live textarea after any edit / caret move. */
  const syncSlash = useCallback(
    (next: string, caret: number, reopen: boolean) => {
      setSlashCaret(caret);
      const token = findSlashToken(next, caret);
      if (!token) {
        setSlashOpen(false);
        return;
      }
      setSlashHighlight(0);
      if (reopen) setSlashOpen(true);
    },
    [],
  );

  /** Replace the active token with the picked skill and restore the caret. */
  const insertSkill = useCallback(
    (skill: InvokableSkill) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? slashCaret;
      const token = findSlashToken(value, caret);
      if (!token) return;
      const next = replaceSlashToken(value, token, skill.name);
      setValue(next.value);
      setSlashOpen(false);
      setSlashCaret(next.caret);
      // cm:why the caret is restored after React commits the new value — set synchronously, the browser parks it at the end of the whole message instead of just past the inserted name
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(next.caret, next.caret);
      });
    },
    [value, slashCaret],
  );

  /** The `/` trigger: open on an existing token, else insert one at the caret. */
  const openSlashMenu = useCallback(() => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    if (findSlashToken(value, caret)) {
      setSlashCaret(caret);
      setSlashHighlight(0);
      setSlashOpen(true);
      el?.focus();
      return;
    }
    // cm:guard keep the token rule true — a `/` glued to the previous word is not a command, so the trigger has to insert a separating space or the menu it just opened would immediately close
    const before = value.slice(0, caret);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = `${needsSpace ? " " : ""}/`;
    const next = before + insert + value.slice(caret);
    const nextCaret = caret + insert.length;
    setValue(next);
    setSlashCaret(nextCaret);
    setSlashHighlight(0);
    setSlashOpen(true);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
    });
  }, [value]);

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
      setSlashOpen(false);
      setSlashCaret(0);
    } catch {
      // Keep the text + files; the parent surfaces the error (Banner + toast).
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // cm:guard the slash menu owns ↑/↓/Enter/Escape ONLY while it is open — widening that would regress Enter-to-send and Shift+Enter-for-newline (ISS-462 / ISS-714), which are the composer's oldest contracts
    if (slashMenuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!slashMatches.length) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setSlashHighlight(
          (h) => (h + step + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        const picked = slashMatches[slashHighlight];
        if (picked) {
          e.preventDefault();
          insertSkill(picked);
          return;
        }
        // cm:why no match to insert, so this falls through to the send below and the typed text goes as-is
      }
      if (e.key === "Escape") {
        // cm:guard Escape dismisses the menu ONLY — the typed text stays, which is the whole point of it here
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
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
        <div
          ref={rowRef}
          className="flex w-full items-end gap-0.5 rounded-2xl border border-line-strong bg-surface py-1.5 pl-1.5 pr-2 transition-shadow focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)] sm:gap-1"
        >
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
          {hasSkills && (
            <IconButton
              type="button"
              variant="ghost"
              icon="command"
              aria-label="Insert a skill"
              aria-haspopup="listbox"
              aria-expanded={slashMenuOpen}
              className="h-11 w-11 flex-none"
              // cm:guard NOT disabled by `busy` — the menu only edits the draft, the textarea stays editable while the agent works, and a control disabled with no stated reason is what the UX contract forbids
              disabled={disabled}
              onClick={openSlashMenu}
            />
          )}
          {actions}
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              syncSlash(e.target.value, e.target.selectionStart ?? 0, true);
            }}
            onKeyDown={onKeyDown}
            // cm:guard re-read the token on selection changes too — a click or an arrow key moves the caret out of (or into) a token without changing the text, so keying only off onChange leaves the menu stale
            onSelect={(e) => {
              const el = e.currentTarget;
              syncSlash(el.value, el.selectionStart ?? 0, false);
            }}
            // cm:guard a focus move INTO the panel must not close it — closing here detaches the node the pointer is pressing, so its `click` never lands. The panel also cancels mousedown's focus default (slash-skills-menu.tsx), which is what covers Safari, where this relatedTarget is null.
            onBlur={(e) => {
              if (slashPanelRef.current?.contains(e.relatedTarget as Node | null)) return;
              setSlashOpen(false);
            }}
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
        {slashSkills && (
          <SlashSkillsMenu
            open={slashMenuOpen}
            onClose={() => setSlashOpen(false)}
            query={slashToken?.query ?? ""}
            matches={slashMatches}
            highlight={slashHighlight}
            onHighlight={setSlashHighlight}
            onPick={insertSkill}
            anchorRef={rowRef}
            panelRef={slashPanelRef}
            items={slashSkills.items}
            loading={slashSkills.loading}
            error={slashSkills.error}
            retry={slashSkills.retry}
          />
        )}
      </div>
    </div>
  );
}
