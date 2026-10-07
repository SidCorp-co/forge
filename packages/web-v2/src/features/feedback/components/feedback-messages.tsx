"use client";

// Messages from a feedback item: the thread of what was sent to reporters and the internal notes kept
// for members, and a composer. A message to reporters picks its audience, previews the exact notice,
// then sends; an internal note is marked as one, and says it is never sent to anyone.

import { useState } from "react";
import { Button, LEGEND, Radio, RadioGroup, Textarea } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { usePreviewMessage, useSendMessage } from "../hooks";
import type { FeedbackMessagePreview, FeedbackMessageView, FeedbackView } from "../types";

type Mode = "reporters" | "note";
type Audience = "reporter" | "all_reporters";

function Thread({ messages }: { messages: FeedbackMessageView[] }) {
  const t = useCopy();
  const time = useTimeFormat();
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
                  {t("feedback.messages.noteHead")}
                </span>
              ) : (
                <span className="text-11 font-semibold uppercase tracking-wide text-muted">
                  {t("feedback.messages.sentTo", { names: m.recipients.map((r) => r.name ?? t("feedback.messages.aReporter")).join(", ") || t(`feedback.audience.${m.audience}`).toLowerCase() })}
                </span>
              )}
              <span className="text-12 text-muted">
                {m.sentByName ?? m.sentBy} ·{" "}
                <span title={time.dateTime(m.sentAt)}>{time.relative(m.sentAt)}</span>
              </span>
            </span>
            <span className="max-w-[80ch] whitespace-pre-wrap">{m.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The exact notice a message to reporters becomes, and who it does not reach, read before Send. */
export function MessagePreview({ shown }: { shown: FeedbackMessagePreview }) {
  const t = useCopy();
  const someone = t("feedback.messages.aReporter");
  return (
    <div className="grid gap-1 border-l-2 border-line py-1 pl-3" data-testid="message-preview">
      <span className="text-11 font-semibold uppercase tracking-wide text-muted">{t("feedback.messages.previewHead")}</span>
      <span className="text-13 font-semibold">{shown.title}</span>
      <span className="max-w-[80ch] whitespace-pre-wrap text-13">{shown.body}</span>
      <span className="text-12 text-muted">{t("feedback.messages.to", { names: shown.recipients.map((r) => r.name ?? someone).join(", ") })}</span>
      {shown.notReached.map((r) => (
        <span key={r.id} className="text-12 text-muted">
          {t("feedback.messages.notTold", { name: r.name ?? someone })} {r.why}
        </span>
      ))}
    </div>
  );
}

function Composer({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
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
          <Radio value="reporters" label={t("feedback.messages.toReporters")} />
          <Radio value="note" label={t("feedback.messages.note")} />
        </RadioGroup>
      ) : null}
      {mode === "reporters" && merged ? (
        <RadioGroup name={`message-audience-${f.key}`} value={audience} onChange={(v) => change(() => setAudience(v as Audience))} className="flex flex-wrap gap-4">
          <Radio value="reporter" label={t("feedback.audience.reporter")} />
          <Radio value="all_reporters" label={`${t("feedback.audience.all_reporters")} (${f.reporters.length})`} />
        </RadioGroup>
      ) : null}
      <Textarea
        aria-label={mode === "note" ? t("feedback.messages.note") : t("feedback.messages.messageAria")}
        rows={3}
        value={text}
        onChange={(e) => change(() => setText(e.target.value))}
        placeholder={mode === "note" ? t("feedback.messages.notePlaceholder") : t("feedback.messages.messagePlaceholder")}
      />
      {mode === "note" ? (
        <p className="text-12 text-muted">{t("feedback.messages.noteWarning")}</p>
      ) : null}
      {shown ? <MessagePreview shown={shown} /> : null}
      <RefusalLine error={preview.error ?? send.error} />
      <div className="flex gap-2">
        {mode === "note" ? (
          <Button type="button" variant="primary" size="sm" loading={send.isPending} disabled={!text.trim()} onClick={sendNow}>
            {t("feedback.messages.addNote")}
          </Button>
        ) : shown ? (
          <Button type="button" variant="primary" size="sm" loading={send.isPending} onClick={sendNow}>
            {t("feedback.messages.send")}
          </Button>
        ) : (
          <Button type="button" size="sm" loading={preview.isPending} disabled={!text.trim()} onClick={() => preview.mutate({ audience, text })}>
            {t("feedback.messages.preview")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The item's thread, with the composer for those who may write to its reporters or leave a note. */
export function Messages({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  if (f.messages.length === 0 && !f.can.message && !f.can.note) return null;
  return (
    <section className="grid gap-3" data-testid="feedback-messages">
      <h2 className="text-15 font-semibold leading-snug text-fg">{t("feedback.messages.heading")}</h2>
      <Thread messages={f.messages} />
      {f.can.message || f.can.note ? <Composer projectId={projectId} f={f} /> : null}
    </section>
  );
}
