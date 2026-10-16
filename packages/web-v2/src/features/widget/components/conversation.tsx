import type { WidgetMessage, WidgetPublicConfig } from "@forge/contracts/widget";
import { useQueryClient } from "@tanstack/react-query";
import { Banner, Button, Spinner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useEffect, useRef, useState } from "react";
import { WidgetRefusal } from "../api";
import type { HostChannel } from "../hooks/host";
import { useLive } from "../hooks/live";
import { useConfirmDraft, useDiscardDraft, useFiledLinks, useSendMessage, useWidgetHistory, widgetKeys } from "../hooks/queries";
import { type Shown, shownOf } from "../refusal";
import { Composer } from "./composer";
import { DraftConfirm } from "./draft-confirm";
import { RefusalNote } from "./refusal-note";

interface Outgoing {
  id: string;
  text: string;
  failed: boolean;
}

function Bubble({ from, text, pending, failed }: { from: WidgetMessage["role"]; text: string; pending?: boolean; failed?: boolean }) {
  const t = useCopy();
  const mine = from === "visitor";
  return (
    <li className={cn("flex", mine ? "justify-end" : "justify-start")} data-role={from}>
      <div
        className={cn(
          "text-13 max-w-5/6 whitespace-pre-wrap break-words rounded-md px-3 py-2",
          mine ? "bg-primary text-primary-foreground" : "bg-sunken text-fg",
          pending && "opacity-70",
          failed && "border border-danger-9",
        )}
      >
        <span className="sr-only">{mine ? t("widget.chat.you") : t("widget.chat.assistant")}: </span>
        {text}
      </div>
    </li>
  );
}

/**
 * The open conversation: its history and live replies, the drafts the assistant proposes, and the
 * visitor's line. A limit met stops the line and says why; a session that ends hands back to the frame.
 */
export function Conversation({
  token,
  config,
  host,
  onEnded,
}: {
  token: string;
  config: WidgetPublicConfig;
  host: HostChannel;
  onEnded: (why: Shown) => void;
}) {
  const t = useCopy();
  const qc = useQueryClient();
  const history = useWidgetHistory(token);
  const filed = useFiledLinks(token);
  const live = useLive(token, { assistantReplied: host.noteAssistantReply, ended: onEnded });
  const send = useSendMessage(token, host.context);
  const confirm = useConfirmDraft(token);
  const discard = useDiscardDraft(token);
  const [outbox, setOutbox] = useState<Outgoing[]>([]);
  const [draftRefusal, setDraftRefusal] = useState<{ draftId: string; refusal: Shown } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const messages = history.data?.messages ?? [];
  const drafts = history.data?.drafts ?? [];
  const stopped = live.limit?.code === "WIDGET_LIMIT_REACHED";

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, drafts.length, outbox.length, live.typing]);

  function refused(err: unknown): Shown {
    const shown = shownOf(err);
    if (err instanceof WidgetRefusal && err.code === "WIDGET_SESSION_INVALID") onEnded(shown);
    if (err instanceof WidgetRefusal && err.code === "WIDGET_LIMIT_REACHED") live.noteLimit({ code: err.code, detail: err.message });
    return shown;
  }

  function post(item: Outgoing) {
    setOutbox((all) => [...all.filter((o) => o.id !== item.id), { ...item, failed: false }]);
    send.mutate(item.text, {
      onSuccess: (message) => {
        // a reply that is not the message itself: the line stays pending until the history holds it
        const landed = message ? Promise.resolve() : qc.invalidateQueries({ queryKey: widgetKeys.history(token) });
        void landed.then(() => setOutbox((all) => all.filter((o) => o.id !== item.id)));
      },
      onError: (err) => {
        refused(err);
        setOutbox((all) => all.map((o) => (o.id === item.id ? { ...o, failed: true } : o)));
      },
    });
  }

  function act(kind: "send" | "discard", draftId: string) {
    setDraftRefusal(null);
    (kind === "send" ? confirm : discard).mutate(draftId, {
      onError: (err) => setDraftRefusal({ draftId, refusal: refused(err) }),
    });
  }

  const busyOf = (draftId: string) =>
    confirm.isPending && confirm.variables === draftId ? "send" : discard.isPending && discard.variables === draftId ? "discard" : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="widget-conversation">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {config.greeting && messages.length === 0 && <Bubble from="assistant" text={config.greeting} />}
        {history.isLoading && <Spinner size={16} />}
        {history.isError && <RefusalNote refusal={shownOf(history.error)} />}
        <ol className="flex flex-col gap-2" aria-label={t("widget.chat.label")} role="log" aria-live="polite">
          {messages.map((m) => (
            <Bubble key={m.id} from={m.role} text={m.text} />
          ))}
          {outbox.map((o) => (
            <Bubble key={o.id} from="visitor" text={o.text} pending={!o.failed} failed={o.failed} />
          ))}
        </ol>
        {outbox.some((o) => o.failed) && (
          <Banner
            tone="danger"
            action={
              <Button size="sm" variant="secondary" onClick={() => outbox.filter((o) => o.failed).forEach(post)}>
                {t("widget.chat.retry")}
              </Button>
            }
          >
            {t("widget.chat.sendFailed")}
          </Banner>
        )}
        {drafts.map((d) => (
          <DraftConfirm
            key={d.draftId}
            draft={d}
            filed={filed[d.draftId] ?? null}
            busy={busyOf(d.draftId)}
            refusal={draftRefusal?.draftId === d.draftId ? draftRefusal.refusal : null}
            onSend={() => act("send", d.draftId)}
            onDiscard={() => act("discard", d.draftId)}
          />
        ))}
        {live.typing && (
          <p className="fg-caption text-subtle" role="status">
            {t("widget.chat.typing")}
          </p>
        )}
        {live.limit && (
          <div data-testid="widget-limit">
            <RefusalNote refusal={{ code: live.limit.code, rawCode: live.limit.code, detail: live.limit.detail }} />
          </div>
        )}
        {live.link === "retrying" && <Banner tone="attention">{t("widget.chat.reconnecting")}</Banner>}
        {live.fault && (
          <p className="fg-caption text-danger" data-testid="widget-stream-fault" title={live.fault}>
            {t("widget.chat.unreadable")}
          </p>
        )}
        <div ref={endRef} />
      </div>
      <Composer maxChars={config.messageMaxChars} disabled={stopped} onSend={(text) => post({ id: crypto.randomUUID(), text, failed: false })} />
    </div>
  );
}
