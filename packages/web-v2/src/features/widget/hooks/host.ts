import type { WidgetPageContext, WidgetSessionRequest } from "@forge/contracts/widget";
import { useEffect, useRef, useState } from "react";
import { type FrameSays, hostMessageOf, parentOriginOf, postToHost } from "../host-channel";

export type SignedVisitor = NonNullable<WidgetSessionRequest["signed"]>;

export interface HostChannel {
  /** The embedding page's origin, or null when the frame is opened on its own. */
  parentOrigin: string | null;
  context: WidgetPageContext | null;
  signed: SignedVisitor | null;
  /** Whether the page shows the frame; hidden, assistant replies count as unread. */
  visible: boolean;
  /** Counts each time the page opens the frame, so the frame can move focus in. */
  opened: number;
  unread: number;
  noteAssistantReply: () => void;
  tell: (message: FrameSays) => void;
}

/** The frame's end of the loader channel: what the page sent, and a way to answer it. */
export function useHostChannel(): HostChannel {
  const [parentOrigin] = useState(() => parentOriginOf());
  const [context, setContext] = useState<WidgetPageContext | null>(null);
  const [signed, setSigned] = useState<SignedVisitor | null>(null);
  const [visible, setVisible] = useState(true);
  const [opened, setOpened] = useState(0);
  const [unread, setUnread] = useState(0);
  const shownRef = useRef(true);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const read = hostMessageOf(event, parentOrigin, window.parent === window ? null : window.parent);
      if (!read) return;
      if ("fault" in read) {
        console.error(`[forge-widget] ${read.fault}`);
        return;
      }
      const message = read.message;
      if (message.type === "context") setContext(message.context);
      else if (message.type === "identify")
        setSigned((was) => (was?.sig === message.signed.sig && was.userId === message.signed.userId ? was : message.signed));
      else if (message.type === "open") {
        shownRef.current = true;
        setVisible(true);
        setUnread(0);
        setOpened((n) => n + 1);
      } else {
        shownRef.current = false;
        setVisible(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") postToHost({ type: "close" }, parentOrigin);
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    postToHost({ type: "ready" }, parentOrigin);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [parentOrigin]);

  useEffect(() => {
    postToHost({ type: "unread", count: unread }, parentOrigin);
  }, [unread, parentOrigin]);

  return {
    parentOrigin,
    context,
    signed,
    visible,
    opened,
    unread,
    noteAssistantReply: () => {
      if (!shownRef.current) setUnread((n) => n + 1);
    },
    tell: (message) => postToHost(message, parentOrigin),
  };
}
