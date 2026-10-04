"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatApiError } from "@/lib/api/error";
import { useOpenConversation, useSendMessage, useUploadAttachment } from "../hooks";
import type { ConversationMessage, ConversationMode, OutboxMessage } from "../types";
import type { UiSnapshot } from "@forge/contracts/ui-actions";

interface OutboxArgs {
  projectId: string;
  ecosystemId: string | null;
  conversationId: string | undefined;
  onOpened: (id: string) => void;
  messages: ConversationMessage[];
  accepted: Record<string, { messageId: string }>;
  /** True once the room's mode is fixed; the first message of a fresh room carries `mode`. */
  settled: boolean;
  mode: ConversationMode;
  /** The page beside the chat; a message carries its snapshot only where the agent can see it. */
  page: { snapshot: UiSnapshot; sees: string | null };
}

/** An accepted message turns `sent`, and leaves once the room shows it; the same array when nothing moved. */
function reconcile(outbox: OutboxMessage[], accepted: OutboxArgs["accepted"], seen: Set<string>): OutboxMessage[] {
  let moved = false;
  const next = outbox.flatMap((m) => {
    const ack = accepted[m.id];
    if (ack && seen.has(ack.messageId)) {
      moved = true;
      return [];
    }
    if (ack && m.state !== "sent") {
      moved = true;
      return [{ ...m, state: "sent" as const, messageId: ack.messageId }];
    }
    return [m];
  });
  return moved ? next : outbox;
}

/** Messages typed but not yet in the room, sent one at a time; a failed one holds the queue. */
export function useOutbox(args: OutboxArgs) {
  const open = useOpenConversation();
  const send = useSendMessage();
  const upload = useUploadAttachment();
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const sending = useRef(false);
  /** Uploads a queued message already stored, so a retry does not store the same picture twice. */
  const stored = useRef(new Map<string, string[]>());
  const latest = useRef(args);
  latest.current = args;

  useEffect(() => {
    const seen = new Set(args.messages.map((m) => m.id));
    setOutbox((o) => reconcile(o, args.accepted, seen));
  }, [args.accepted, args.messages]);

  useEffect(() => {
    if (sending.current || outbox.some((m) => m.state === "failed")) return;
    const next = outbox.find((m) => m.state === "queued");
    if (!next) return;
    sending.current = true;
    setOutbox((o) => o.map((m) => (m.id === next.id ? { ...m, state: "sending" } : m)));
    const a = latest.current;
    void (async () => {
      try {
        let id = a.conversationId;
        if (!id) {
          id = (await open.mutateAsync({ projectId: a.projectId, ecosystemId: a.ecosystemId })).id;
          a.onOpened(id);
        }
        const fresh = !a.settled && a.messages.length === 0;
        const attachmentIds = [...(stored.current.get(next.id) ?? [])];
        for (const file of (next.files ?? []).slice(attachmentIds.length)) {
          attachmentIds.push((await upload.mutateAsync({ conversationId: id, file })).id);
          stored.current.set(next.id, [...attachmentIds]);
        }
        const uiSnapshot = a.page.sees ? a.page.snapshot : null;
        await send.mutateAsync({
          conversationId: id,
          content: next.content,
          ...(fresh ? { mode: a.mode } : {}),
          clientToken: next.id,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(uiSnapshot ? { uiSnapshot } : {}),
        });
        stored.current.delete(next.id);
        setOutbox((o) => o.filter((m) => m.id !== next.id));
      } catch (err) {
        setOutbox((o) =>
          o.map((m) => (m.id === next.id ? { ...m, state: "failed", error: formatApiError(err) } : m)),
        );
      } finally {
        sending.current = false;
      }
    })();
  }, [outbox, open, send, upload]);

  const enqueue = useCallback((content: string, files: File[]) => {
    setOutbox((o) => [
      ...o,
      { id: crypto.randomUUID(), content, state: "queued", ...(files.length ? { files } : {}) },
    ]);
  }, []);
  const retry = useCallback((id: string) => {
    setOutbox((o) => o.map((m) => (m.id === id ? { ...m, state: "queued", error: undefined } : m)));
  }, []);

  return { outbox, enqueue, retry, busy: send.isPending || open.isPending };
}
