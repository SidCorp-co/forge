import type { WidgetHistory, WidgetRefusalCode, WidgetStreamEvent } from "@forge/contracts/widget";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { withDraft, withMessage } from "../history";
import { type Shown, shownOf } from "../refusal";
import { follow, type StreamRead } from "../stream";
import type { WidgetRefusal } from "../api";
import { keepFiled, widgetKeys } from "./queries";

export type LinkState = "connecting" | "live" | "retrying";

export interface Live {
  link: LinkState;
  typing: boolean;
  limit: { code: WidgetRefusalCode; detail: string } | null;
  /** The last event the frame could not read, by name; shown, never skipped silently. */
  fault: string | null;
  noteLimit: (limit: { code: WidgetRefusalCode; detail: string }) => void;
}

/**
 * Follows the session's stream into the query cache: each message and draft folds into the history,
 * a filed draft keeps its status link, and every reconnect reads the history again to fill the gap.
 */
export function useLive(token: string, on: { assistantReplied: () => void; ended: (why: Shown) => void }): Live {
  const qc = useQueryClient();
  const [link, setLink] = useState<LinkState>("connecting");
  const [typing, setTyping] = useState(false);
  const [limit, setLimit] = useState<Live["limit"]>(null);
  const [fault, setFault] = useState<string | null>(null);

  const apply = useEffectEvent((event: WidgetStreamEvent) => {
    const history = widgetKeys.history(token);
    switch (event.type) {
      case "message":
        if (event.message.role === "assistant") {
          setTyping(false);
          const seen = qc.getQueryData<WidgetHistory>(history)?.messages.some((m) => m.id === event.message.id);
          if (!seen) on.assistantReplied();
        }
        qc.setQueryData<WidgetHistory>(history, (h) => withMessage(h, event.message));
        return;
      case "typing":
        setTyping(event.on);
        return;
      case "draft":
        qc.setQueryData<WidgetHistory>(history, (h) => withDraft(h, event.draft));
        return;
      case "filed":
        keepFiled(qc, token, event.draftId, { feedbackKey: event.feedbackKey, statusUrl: event.statusUrl });
        return;
      case "limit":
        setTyping(false);
        setLimit({ code: event.code, detail: event.detail });
    }
  });
  const read = useEffectEvent((r: StreamRead) => {
    if ("fault" in r) {
      console.error(`[forge-widget] stream: ${r.fault}`);
      setFault(r.fault);
    } else apply(r.event);
  });
  const opened = useEffectEvent(() => {
    setLink("live");
    void qc.invalidateQueries({ queryKey: widgetKeys.history(token) });
  });
  const retrying = useEffectEvent(() => {
    setLink("retrying");
    setTyping(false);
  });
  const refused = useEffectEvent((refusal: WidgetRefusal) => on.ended(shownOf(refusal)));

  useEffect(() => {
    const ctrl = new AbortController();
    void follow(token, ctrl.signal, { onRead: read, onOpen: opened, onRetry: retrying, onRefused: refused });
    return () => ctrl.abort();
  }, [token]);

  return { link, typing, limit, fault, noteLimit: setLimit };
}
