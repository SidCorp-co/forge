import { IconButton, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { type FormEvent, type KeyboardEvent, useState } from "react";

/** How many characters before the cap the count starts showing. */
const SHOW_LEFT_UNDER = 200;

/** The visitor's line: Enter sends, Shift+Enter breaks the line, and the cap is counted down near its end. */
export function Composer({
  maxChars,
  disabled,
  onSend,
}: {
  maxChars: number;
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const t = useCopy();
  const [text, setText] = useState("");
  const typed = text.trim();
  const left = maxChars - text.length;
  const canSend = !disabled && typed !== "" && left >= 0;

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    onSend(typed);
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  return (
    <form className="flex flex-col gap-1 border-t border-line bg-surface p-2" onSubmit={send} data-testid="widget-composer">
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          aria-label={t("widget.chat.message")}
          placeholder={t("widget.chat.placeholder")}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-32 flex-1 resize-none"
          data-autofocus=""
        />
        <IconButton type="submit" icon="arrowUp" variant="secondary" aria-label={t("widget.chat.send")} disabled={!canSend} />
      </div>
      {left < SHOW_LEFT_UNDER && (
        <p className={left < 0 ? "fg-caption px-1 text-danger" : "fg-caption px-1 text-subtle"} aria-live="polite">
          {left < 0 ? t("widget.chat.over", { n: -left }) : t("widget.chat.left", { n: left })}
        </p>
      )}
    </form>
  );
}
