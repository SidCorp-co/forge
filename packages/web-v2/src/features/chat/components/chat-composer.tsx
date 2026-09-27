"use client";

// The one composer. Both surfaces that host one render this: the conversations
// pane and the run thread.
//
// Its shape is a single bordered frame of two rows — staged files and the box
// on top, the controls underneath — so every control the composer offers sits
// on the same column as the text it acts on. What each surface brings is its
// own attachment policy, its own control for the footer slot, and its own
// answer to whether a running turn can be stopped.

import {
  type ClipboardEvent,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useDropzone } from "react-dropzone";
import TextareaAutosize from "react-textarea-autosize";
import { Banner, Button, Icon, IconButton } from "@/design";
import { SlashSkillsMenu, type SlashSkillsSource } from "@/features/session/components/slash-skills-menu";
import {
  filterSkillsByQuery,
  findSlashToken,
  replaceSlashToken,
} from "@/features/session/slash-token";
import type { InvokableSkill } from "@/features/skills/types";
import {
  acceptAttribute,
  type AttachmentPolicy,
  formatSize,
  refusalSentence,
  stageFiles,
  type StagingRefusal,
} from "../attachments";

/** How tall the box may grow before it scrolls instead. */
const MAX_ROWS = 8;

/**
 * How wide the composer's own frame is, for a control in the footer slot that
 * has to shrink with it. Null until it has been measured — and in a runtime
 * with no `ResizeObserver`, which is what a reader of this value renders for.
 * The frame is the subject rather than the viewport: this composer is as wide
 * as the pane it is in, and the dock is 420px inside a 1440px window.
 */
export const ComposerWidthContext = createContext<number | null>(null);

interface StagedFile {
  id: string;
  file: File;
}

export interface ChatComposerProps {
  /**
   * Deliver the message and its staged files. MUST reject on failure — the box
   * clears only when this resolves, so a failed send keeps the text and the
   * files for a retry instead of discarding them (ISS-462).
   */
  onSend: (message: string, files: File[]) => Promise<void>;
  /** Nothing can be typed or sent — no device, no room. */
  disabled?: boolean;
  /** A send is in flight, or the agent is answering. */
  busy?: boolean;
  /** Take a send while `busy`, for a caller that queues rather than refuses. */
  queueWhileBusy?: boolean;
  placeholder?: string;
  /**
   * What this surface stages. Absent, and there is no attach control, no paste
   * and no drop — a composer with nowhere to put a file must not offer one.
   */
  attachments?: AttachmentPolicy;
  sticky?: boolean;
  /**
   * The surface's own control, in the footer row between the slash trigger and
   * the send button. The conversations pane puts its mode control here.
   */
  footerControl?: ReactNode;
  /**
   * Enables the `/`-autocomplete. Absent, or empty with nothing loading and no
   * error, and the trigger is not rendered at all.
   */
  slashSkills?: SlashSkillsSource;
  /**
   * End the turn that is running. Given, the send button IS the stop button, so
   * a caller passes it only while there is a turn to end. Absent, and no stop
   * is offered — which is the state a turn handed to a paired box is in.
   */
  onStop?: () => void;
  /** A stop is in flight. */
  stopping?: boolean;
}

function bandClass(sticky: boolean, pad: string): string {
  return sticky
    ? `sticky bottom-0 z-10 border-t border-line bg-app/95 backdrop-blur ${pad}`
    : `flex-none border-t border-line bg-app ${pad}`;
}

/** Rendered in place of the composer for project viewers (read-only role). */
export function ReadOnlyComposerNote({ sticky = true }: { sticky?: boolean }) {
  return (
    <div className={bandClass(sticky, "px-4 py-4 sm:px-6")}>
      <p className="fg-body-sm text-center text-muted">Read-only access</p>
    </div>
  );
}

export function ChatComposer({
  onSend,
  disabled,
  busy,
  queueWhileBusy,
  placeholder = "Message the agent…",
  attachments,
  sticky = true,
  footerControl,
  slashSkills,
  onStop,
  stopping,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [refusals, setRefusals] = useState<StagingRefusal[]>([]);
  const nextFileId = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const slashPanelRef = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setFrameWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setFrameWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const canSend =
    !disabled && (queueWhileBusy || !busy) && (value.trim().length > 0 || files.length > 0);
  // Stop is offered on the turn, not on this browser's own send: anyone in the
  // room watching an answer arrive may end it, and `onStop` is given only while
  // there is a turn to end, so its presence is the whole condition.
  const showStop = Boolean(onStop);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashCaret, setSlashCaret] = useState(0);
  const slashDismissedAt = useRef<number | null>(null);
  const skillsKnown = !!slashSkills;
  const hasSkills =
    skillsKnown && (slashSkills.items.length > 0 || slashSkills.loading || !!slashSkills.error);
  const slashToken = skillsKnown ? findSlashToken(value, slashCaret) : null;
  const slashMatches = slashToken
    ? filterSkillsByQuery(slashSkills?.items ?? [], slashToken.query)
    : [];
  const slashMenuOpen = slashOpen && !!slashToken && hasSkills && !disabled;

  /** Sync the token state from the live box after any edit or caret move. */
  const syncSlash = useCallback((next: string, caret: number, reopen: boolean) => {
    setSlashCaret(caret);
    const token = findSlashToken(next, caret);
    if (!token) {
      setSlashOpen(false);
      slashDismissedAt.current = null;
      return;
    }
    setSlashHighlight(0);
    const dismissed = slashDismissedAt.current === token.start;
    if (!dismissed) slashDismissedAt.current = null;
    if (reopen && !dismissed) setSlashOpen(true);
  }, []);

  /** Put the caret back after a programmatic edit of the box's value. */
  const restoreCaret = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  }, []);

  const insertSkill = useCallback(
    (skill: InvokableSkill) => {
      const caret = textareaRef.current?.selectionStart ?? slashCaret;
      const token = findSlashToken(value, caret);
      if (!token) return;
      const next = replaceSlashToken(value, token, skill.name);
      setValue(next.value);
      setSlashOpen(false);
      setSlashCaret(next.caret);
      restoreCaret(next.caret);
    },
    [value, slashCaret, restoreCaret],
  );

  /** The `/` trigger: open on an existing token, else insert one at the caret. */
  const openSlashMenu = useCallback(() => {
    const caret = textareaRef.current?.selectionStart ?? value.length;
    slashDismissedAt.current = null;
    setSlashHighlight(0);
    setSlashOpen(true);
    if (findSlashToken(value, caret)) {
      setSlashCaret(caret);
      textareaRef.current?.focus();
      return;
    }
    const before = value.slice(0, caret);
    const insert = `${before.length > 0 && !/\s$/.test(before) ? " " : ""}/`;
    const nextCaret = caret + insert.length;
    setValue(before + insert + value.slice(caret));
    setSlashCaret(nextCaret);
    restoreCaret(nextCaret);
  }, [value, restoreCaret]);

  /**
   * Every route in — the dialog, a drop, a paste — lands here, so a file is
   * judged by the same policy however it arrived and a refusal always names it.
   */
  const take = useCallback(
    (picked: readonly File[]) => {
      if (!attachments) return;
      const outcome = stageFiles(picked, attachments, files.length);
      setRefusals(outcome.refused);
      if (outcome.accepted.length === 0) return;
      setFiles((prev) => [
        ...prev,
        ...outcome.accepted.map((file) => ({ id: `file-${nextFileId.current++}`, file })),
      ]);
    },
    [attachments, files.length],
  );

  const { getRootProps, getInputProps, open: openPicker, isDragActive } = useDropzone({
    onDrop: take,
    noClick: true,
    noKeyboard: true,
    multiple: true,
    disabled: !attachments || disabled || busy,
  });

  /**
   * A pasted screenshot. Only image blobs are pulled in; pasted text falls
   * through to the box. Clipboard images often carry no name, so supply one.
   */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!attachments) return;
      const blobs: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        if (file.name) {
          blobs.push(file);
          continue;
        }
        const ext = item.type.split("/")[1] ?? "png";
        blobs.push(new File([file], `pasted-${blobs.length + 1}.${ext}`, { type: item.type }));
      }
      if (blobs.length === 0) return;
      e.preventDefault();
      take(blobs);
    },
    [attachments, take],
  );

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((file) => file.id !== id));
    setRefusals([]);
  };

  const submit = async () => {
    if (!canSend) return;
    const text = value.trim();
    const staged = files.map(({ file }) => file);
    const clear = () => {
      setValue("");
      setFiles([]);
      setRefusals([]);
      setSlashOpen(false);
      setSlashCaret(0);
    };
    if (queueWhileBusy) {
      clear();
      await onSend(text, staged);
      return;
    }
    try {
      await onSend(text, staged);
      clear();
    } catch {
      // The text and the files stay; the caller surfaces the error.
    }
  };

  const onSlashKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (slashMatches.length === 0) return true;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSlashHighlight((h) => (h + step + slashMatches.length) % slashMatches.length);
      return true;
    }
    if (e.key === "Tab" && !e.shiftKey && slashSkills?.error) {
      const focusable = slashPanelRef.current?.querySelector<HTMLElement>("button");
      if (focusable) {
        e.preventDefault();
        focusable.focus();
        return true;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const picked = slashMatches[slashHighlight];
      if (picked) {
        e.preventDefault();
        insertSkill(picked);
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setSlashOpen(false);
      slashDismissedAt.current = slashToken?.start ?? null;
      return true;
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen && onSlashKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const staged = files.reduce((bytes, { file }) => bytes + file.size, 0);
  const hint =
    files.length > 0
      ? `${files.length} file${files.length === 1 ? "" : "s"} · ${formatSize(staged)}`
      : "Enter sends · Shift+Enter for a new line";

  return (
    <ComposerWidthContext.Provider value={frameWidth}>
      <div className={bandClass(sticky, "px-4 py-3 sm:px-6")} onPaste={attachments ? onPaste : undefined}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 xl:max-w-4xl">
          {refusals.length > 0 && (
            <Banner tone="attention">
              <ul className="space-y-0.5">
                {refusals.map((refusal) => (
                  <li key={`${refusal.name}-${refusal.reason}`}>{refusalSentence(refusal)}</li>
                ))}
              </ul>
            </Banner>
          )}

          <div
            {...getRootProps({
              ref: rowRef,
              "data-testid": "chat-composer",
              // react-dropzone marks its root aria-disabled whenever dropping is
              // off, and this root holds the footer: every control in it, Stop
              // included, would be announced disabled for the whole of a turn.
              // Each control states its own disabled state instead.
              "aria-disabled": undefined,
              className: [
                "flex w-full flex-col rounded-2xl border bg-surface transition-shadow",
                "focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)]",
                isDragActive ? "border-dashed border-[color:var(--link)]" : "border-line-strong",
              ].join(" "),
            })}
          >
            {attachments && (
              // The picker's own input, which "Attach files" opens: hidden from
              // the accessibility tree so the one control is not announced twice.
              <input {...getInputProps({ accept: acceptAttribute(attachments), "aria-hidden": true })} />
            )}

            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 px-2.5 pt-2.5" data-testid="composer-chips">
                {files.map(({ id, file }) => (
                  <li
                    key={id}
                    className="flex max-w-60 items-center gap-2 rounded-md border border-line-subtle bg-sunken py-1 pl-2 pr-1"
                  >
                    <Icon
                      name={file.type.startsWith("image/") ? "grid" : "folder"}
                      size={14}
                      className="flex-none text-subtle"
                    />
                    <span className="fg-caption min-w-0 flex-1 truncate text-fg" title={file.name}>
                      {file.name}
                    </span>
                    <span className="fg-caption flex-none">{formatSize(file.size)}</span>
                    <IconButton
                      type="button"
                      icon="x"
                      size="sm"
                      aria-label={`Remove ${file.name}`}
                      disabled={busy}
                      onClick={() => removeFile(id)}
                    />
                  </li>
                ))}
              </ul>
            )}

            <TextareaAutosize
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                syncSlash(e.target.value, e.target.selectionStart ?? 0, true);
              }}
              onKeyDown={onKeyDown}
              onSelect={(e) => {
                const el = e.currentTarget;
                syncSlash(el.value, el.selectionStart ?? 0, false);
              }}
              onBlur={(e) => {
                if (slashPanelRef.current?.contains(e.relatedTarget as Node | null)) return;
                setSlashOpen(false);
              }}
              disabled={disabled}
              minRows={1}
              maxRows={MAX_ROWS}
              placeholder={disabled ? "No device online — start a runner to chat." : placeholder}
              aria-label="Message"
              className="w-full resize-none border-0 bg-transparent px-4 pb-1 pt-3.5 text-base text-fg outline-none placeholder:text-disabled disabled:cursor-not-allowed md:text-sm"
            />

            <div className="flex items-center gap-1 px-2 pb-2">
              {attachments && (
                <IconButton
                  type="button"
                  variant="ghost"
                  icon="plus"
                  aria-label="Attach files"
                  className="h-11 w-11 flex-none"
                  disabled={disabled || busy}
                  onClick={openPicker}
                />
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
                  disabled={disabled}
                  onClick={openSlashMenu}
                />
              )}
              {footerControl}
              <div className="ml-auto flex items-center gap-2.5">
                <span className="fg-caption hidden text-disabled sm:inline">{hint}</span>
                {showStop ? (
                  <Button
                    variant="secondary"
                    size="md"
                    icon="stop"
                    aria-label="Stop answering"
                    className="h-11 w-11 flex-none rounded-full p-0"
                    loading={stopping}
                    onClick={onStop}
                  />
                ) : (
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
                )}
              </div>
            </div>
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
              onLeave={(dismissed) => {
                setSlashOpen(false);
                if (dismissed) slashDismissedAt.current = slashToken?.start ?? null;
                textareaRef.current?.focus();
              }}
              onReturnFocus={() => textareaRef.current?.focus()}
              homeRef={textareaRef}
              items={slashSkills.items}
              loading={slashSkills.loading}
              error={slashSkills.error}
              fetching={slashSkills.fetching}
              retry={slashSkills.retry}
            />
          )}
        </div>
      </div>
    </ComposerWidthContext.Provider>
  );
}
