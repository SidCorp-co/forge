"use client";

// The one composer, for the conversations pane and the run thread: one bordered frame, staged
// files and the box on top, the controls underneath. Each surface brings its attachment policy,
// its footer control, and whether a running turn can be stopped.

import { createContext, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { Banner, Button, Icon, IconButton } from "@/design";
import { acceptAttribute, type AttachmentPolicy, formatSize, refusalSentence } from "../attachments";
import { SketchPad } from "./sketch/sketch-pad";
import { type StagedFile, useStagedFiles } from "./use-staged-files";

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

const KEY_HINT = "Enter sends · Shift+Enter for a new line";
/** Narrower than this, the composer's footer has no room left for a hint line worth reading. */
const HINT_ROW_MIN_WIDTH = 560;

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
   * The surface's own control, in the footer row before the send button. The conversations pane puts its mode control here.
   */
  footerControl?: ReactNode;
  /**
   * End the turn that is running. Given, the send button IS the stop button, so
   * a caller passes it only while there is a turn to end. Absent, and no stop
   * is offered — which is the state a turn handed to a paired box is in.
   */
  onStop?: () => void;
  /** A stop is in flight. */
  stopping?: boolean;
  initialValue?: string;
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

const FRAME =
  "flex w-full flex-col rounded-2xl border bg-surface transition-shadow focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)]";

// cm:why the hint is a line of its own under the box, never inside the footer row, where it ran over
// the footer's own controls in a narrow dock (REQ-11 BC-8); a narrow composer keeps it on Send's tooltip
function hintLine(files: StagedFile[], frameWidth: number | null): string | null {
  if (files.length > 0) {
    const bytes = files.reduce((n, { file }) => n + file.size, 0);
    return `${files.length} file${files.length === 1 ? "" : "s"} · ${formatSize(bytes)}`;
  }
  return (frameWidth ?? 0) >= HINT_ROW_MIN_WIDTH ? KEY_HINT : null;
}

function useWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function ChatComposer(props: ChatComposerProps) {
  const { onSend, disabled, busy, queueWhileBusy, attachments } = props;
  const [value, setValue] = useState(props.initialValue ?? "");
  const [sketching, setSketching] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const frameWidth = useWidth(rowRef);
  const staged = useStagedFiles(attachments, Boolean(disabled || busy));
  const { files } = staged;
  const { getRootProps, getInputProps, open: openPicker, isDragActive } = staged.dropzone;

  const canSend =
    !disabled && (queueWhileBusy || !busy) && (value.trim().length > 0 || files.length > 0);

  const submit = async () => {
    if (!canSend) return;
    const text = value.trim();
    const picked = files.map(({ file }) => file);
    const clear = () => {
      setValue("");
      staged.clear();
    };
    if (queueWhileBusy) {
      clear();
      return onSend(text, picked);
    }
    // A failed send keeps the text and the files; the caller surfaces the error.
    await onSend(text, picked).then(clear, () => {});
  };
  const hint = hintLine(files, frameWidth);

  return (
    <ComposerWidthContext.Provider value={frameWidth}>
      <div className={bandClass(props.sticky ?? true, "px-4 py-3 sm:px-6")} onPaste={staged.onPaste}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 xl:max-w-4xl">
          {staged.refusals.length > 0 && <RefusalBanner refusals={staged.refusals} />}
          <div
            {...getRootProps({
              ref: rowRef,
              "data-testid": "chat-composer",
              // react-dropzone marks its root aria-disabled whenever dropping is off, and this root
              // holds the footer, Stop included; each control states its own disabled state instead.
              "aria-disabled": undefined,
              className: `${FRAME} ${isDragActive ? "border-dashed border-[color:var(--link)]" : "border-line-strong"}`,
            })}
          >
            {attachments && (
              // Hidden from the accessibility tree so "Attach files" is not announced twice.
              <input {...getInputProps({ accept: acceptAttribute(attachments), "aria-hidden": true })} />
            )}
            {files.length > 0 && <StagedChips files={files} busy={busy} onRemove={staged.remove} />}

            <MessageBox
              value={value}
              onChange={setValue}
              onEnter={submit}
              disabled={disabled}
              placeholder={disabled ? "No device online — start a runner to chat." : (props.placeholder ?? "Message the agent…")}
            />

            <ComposerFooter
              attachments={attachments}
              locked={Boolean(disabled || busy)}
              busy={busy}
              onAttach={openPicker}
              onSketch={() => setSketching(true)}
              control={props.footerControl}
              onStop={props.onStop}
              stopping={props.stopping}
              canSend={canSend}
              onSend={submit}
            />
          </div>

          {hint && (
            <p className="fg-caption px-1 text-right text-disabled" data-testid="composer-hint">
              {hint}
            </p>
          )}
        </div>
      </div>
      {sketching && <SketchPad open onClose={() => setSketching(false)} onAttach={(file) => staged.take([file])} />}
    </ComposerWidthContext.Provider>
  );
}

/** The box itself: grows to `MAX_ROWS`, Enter sends, Shift+Enter breaks the line. */
function MessageBox(p: {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  disabled: boolean | undefined;
  placeholder: string;
}) {
  return (
    <TextareaAutosize
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        p.onEnter();
      }}
      disabled={p.disabled}
      minRows={1}
      maxRows={MAX_ROWS}
      placeholder={p.placeholder}
      aria-label="Message"
      className="w-full resize-none border-0 bg-transparent px-4 pb-1 pt-3.5 text-base text-fg outline-none placeholder:text-disabled disabled:cursor-not-allowed md:text-sm"
    />
  );
}

/** Under the box: attach and sketch, the surface's own control, then Send — or Stop while a turn runs. */
function ComposerFooter(p: {
  attachments: AttachmentPolicy | undefined;
  locked: boolean;
  busy: boolean | undefined;
  onAttach: () => void;
  onSketch: () => void;
  control: ReactNode;
  onStop: (() => void) | undefined;
  stopping: boolean | undefined;
  canSend: boolean;
  onSend: () => void;
}) {
  const ghost = "h-11 w-11 flex-none";
  return (
    <div className="flex items-center gap-1 px-2 pb-2">
      {p.attachments && (
        <IconButton type="button" variant="ghost" icon="plus" aria-label="Attach files" className={ghost} disabled={p.locked} onClick={p.onAttach} />
      )}
      {p.attachments?.mimes.includes("image/png") && (
        <IconButton type="button" variant="ghost" icon="sketch" aria-label="Sketch" title="Sketch something to send" className={ghost} disabled={p.locked} onClick={p.onSketch} />
      )}
      {p.control}
      <div className="ml-auto flex flex-none items-center gap-2.5">
        {/* Stop is offered on the turn, not on this browser's send: `onStop` is given only while there is a turn to end. */}
        {p.onStop ? (
          <Button variant="secondary" size="md" icon="stop" aria-label="Stop answering" className="h-11 w-11 flex-none rounded-full p-0" loading={p.stopping} onClick={p.onStop} />
        ) : (
          <Button variant="primary" size="md" icon="arrowRight" aria-label="Send message" title={`Send · ${KEY_HINT}`} className="h-11 w-11 flex-none rounded-full p-0" loading={p.busy} disabled={!p.canSend} onClick={p.onSend} />
        )}
      </div>
    </div>
  );
}

function RefusalBanner({ refusals }: { refusals: ReturnType<typeof useStagedFiles>["refusals"] }) {
  return (
    <Banner tone="attention">
      <ul className="space-y-0.5">{refusals.map((r) => <li key={`${r.name}-${r.reason}`}>{refusalSentence(r)}</li>)}</ul>
    </Banner>
  );
}

function StagedChips({ files, busy, onRemove }: { files: StagedFile[]; busy: boolean | undefined; onRemove: (id: string) => void }) {
  return (
    <ul className="flex flex-wrap gap-1.5 px-2.5 pt-2.5" data-testid="composer-chips">
      {files.map(({ id, file }) => (
        <li key={id} className="flex max-w-60 items-center gap-2 rounded-md border border-line-subtle bg-sunken py-1 pl-2 pr-1">
          <Icon name={file.type.startsWith("image/") ? "grid" : "folder"} size={14} className="flex-none text-subtle" />
          <span className="fg-caption min-w-0 flex-1 truncate text-fg" title={file.name}>
            {file.name}
          </span>
          <span className="fg-caption flex-none">{formatSize(file.size)}</span>
          <IconButton type="button" icon="x" size="sm" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => onRemove(id)} />
        </li>
      ))}
    </ul>
  );
}
