"use client";

// Messages from a feedback item: the thread of what was sent to reporters and the internal notes kept
// for members, and a composer. A message to reporters picks its audience, previews the exact notice,
// then sends; an internal note is marked as one, and says it is never sent to anyone.

import { FEEDBACK_MESSAGE_AUDIENCE_LABELS } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, LEGEND, Radio, RadioGroup, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { formatRelativeTime, formatStamp } from "@/lib/utils/format";
import { usePreviewMessage, useSendMessage } from "../hooks";
import type { FeedbackMessageView, FeedbackView } from "../types";

type Mode = "reporters" | "note";
type Audience = "reporter" | "all_reporters";

function Thread({ messages }: { messages: FeedbackMessageView[] }) {
  if (messages.length === 0) return null;
  return (
    <ol className="border-t border-line-subtle" data-testid="feedback-thread">
      {messages.map((m) => {
        const note = m.audience === "internal";
        return (
          <li key={m.id} className="grid gap-0.5 border-b border-line-subtle py-2.5 text-13" data-testid={note ? "feedback-note" : "feedback-message"}>
            <span className="flex flex-wrap items-baseline gap-x-2">
              {note ? (
                <span className="text-11 font-semibold uppercase tracking-wide" style={{ color: LEGEND.you.fg }}>
                  Internal note · members only
                </span>
              ) : (
                <span className="text-11 font-semibold uppercase tracking-wide text-muted">
                  Sent to {m.recipients.map((r) => r.name ?? "a reporter").join(", ") || FEEDBACK_MESSAGE_AUDIENCE_LABELS[m.audience].toLowerCase()}
                </span>
              )}
              <span className="text-12 text-muted">
                {m.sentByName ?? m.sentBy} ·{" "}
                <span title={formatStamp(m.sentAt)}>{formatRelativeTime(m.sentAt)}</span>
              </span>
            </span>
            <span className="max-w-[80ch] whitespace-pre-wrap">{m.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Composer({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const canMessage = f.can.message;
  const canNote = f.can.note;
  const [mode, setMode] = useState<Mode>(canMessage ? "reporters" : "note");
  const [audience, setAudience] = useState<Audience>("reporter");
  const [text, setText] = useState("");
  const preview = usePreviewMessage(projectId, f.key);
  const send = useSendMessage(projectId, f.key);
  const merged = f.reporters.length > 1;
  const shown = preview.data?.preview;
  const reset = () => {
    setText("");
    preview.reset();
  };
  const change = (fn: () => void) => {
    fn();
    preview.reset();
  };
  const sendNow = () => send.mutate({ audience: mode === "note" ? "internal" : audience, text }, { onSuccess: reset });
  return (
    <div className="grid gap-2" data-testid="feedback-composer">
      {canMessage && canNote ? (
        <RadioGroup name={`message-mode-${f.key}`} value={mode} onChange={(v) => change(() => setMode(v as Mode))} className="flex flex-wrap gap-4">
          <Radio value="reporters" label="Message to reporters" />
          <Radio value="note" label="Internal note" />
        </RadioGroup>
      ) : null}
      {mode === "reporters" && merged ? (
        <RadioGroup name={`message-audience-${f.key}`} value={audience} onChange={(v) => change(() => setAudience(v as Audience))} className="flex flex-wrap gap-4">
          <Radio value="reporter" label={FEEDBACK_MESSAGE_AUDIENCE_LABELS.reporter} />
          <Radio value="all_reporters" label={`${FEEDBACK_MESSAGE_AUDIENCE_LABELS.all_reporters} (${f.reporters.length})`} />
        </RadioGroup>
      ) : null}
      <Textarea
        aria-label={mode === "note" ? "Internal note" : "Message"}
        rows={3}
        value={text}
        onChange={(e) => change(() => setText(e.target.value))}
        placeholder={mode === "note" ? "Only project members read this" : "What the reporter reads"}
      />
      {mode === "note" ? (
        <p className="text-12 text-muted">An internal note is shown to project members only. It is never sent to a reporter, in a notice or any other way.</p>
      ) : null}
      {shown ? (
        <div className="grid gap-1 border-l-2 border-line py-1 pl-3" data-testid="message-preview">
          <span className="text-11 font-semibold uppercase tracking-wide text-muted">Exactly what the reporter will see</span>
          <span className="text-13 font-semibold">{shown.title}</span>
          <span className="max-w-[80ch] whitespace-pre-wrap text-13">{shown.body}</span>
          <span className="text-12 text-muted">To {shown.recipients.map((r) => r.name ?? "a reporter").join(", ")}</span>
          {shown.notReached.map((r) => (
            <span key={r.id} className="text-12 text-muted">
              Not told: {r.name ?? "a reporter"}. {r.why}
            </span>
          ))}
        </div>
      ) : null}
      <RefusalLine error={preview.error ?? send.error} />
      <div className="flex gap-2">
        {mode === "note" ? (
          <Button type="button" variant="primary" size="sm" loading={send.isPending} disabled={!text.trim()} onClick={sendNow}>
            Add note
          </Button>
        ) : shown ? (
          <Button type="button" variant="primary" size="sm" loading={send.isPending} onClick={sendNow}>
            Send
          </Button>
        ) : (
          <Button type="button" size="sm" loading={preview.isPending} disabled={!text.trim()} onClick={() => preview.mutate({ audience, text })}>
            Preview
          </Button>
        )}
      </div>
    </div>
  );
}

/** The item's thread, with the composer for those who may write to its reporters or leave a note. */
export function Messages({ projectId, f }: { projectId: string; f: FeedbackView }) {
  if (f.messages.length === 0 && !f.can.message && !f.can.note) return null;
  return (
    <section className="grid gap-3" data-testid="feedback-messages">
      <h2 className="text-15 font-semibold leading-snug text-fg">Messages</h2>
      <Thread messages={f.messages} />
      {f.can.message || f.can.note ? <Composer projectId={projectId} f={f} /> : null}
    </section>
  );
}
