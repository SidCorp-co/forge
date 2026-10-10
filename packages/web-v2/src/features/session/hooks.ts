"use client";


import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useToastWrite } from "@/providers/toast-write";
import { formatRefusal } from "@/lib/api/error";
import { type EditTurnOpts, type ForkOpts, type SendOpts, sessionApi } from "./api";
import { sessionsKeys } from "@/features/sessions";
import { sessionKeys, sessionQueries } from "./queries";
import { TURN_PAGE_CAP } from "./turns";

export { fetchAllTurns, TURN_PAGE_CAP, TURN_PAGE_SIZE } from "./turns";

/** Session detail row. Keyed `['agent-session', id]` — WS-invalidated. */
export function useSession(id: string | undefined) {
  return useQuery(sessionQueries.detail(id));
}

/**
 * Session turns, the first `pages` pages of `TURN_PAGE_SIZE`. Keyed
 * `['agent-session', id, 'turns', pages]` — the WS prefix invalidation still reaches it. A non-null
 * `nextCursor` means later turns exist and were not loaded; raise `pages` to load them.
 */
function useSessionTurns(id: string | undefined, pages: number = TURN_PAGE_CAP) {
  return useQuery(sessionQueries.turns(id, pages));
}

/** The session's turns, plus the act that loads the next `TURN_PAGE_CAP` pages past a cap. */
export function useSessionTurnPages(id: string) {
  const [loaded, setLoaded] = useState({ id, pages: TURN_PAGE_CAP });
  const pages = loaded.id === id ? loaded.pages : TURN_PAGE_CAP;
  const turnsQ = useSessionTurns(id, pages);
  return { turnsQ, loadMoreTurns: () => setLoaded({ id, pages: pages + TURN_PAGE_CAP }) };
}

/** The whole `['agent-session', id]` family and the sessions list, stale after a write to the session. */
const sessionTouches = (id: string) => [sessionKeys.detail(id), sessionsKeys.all];

/**
 * Send a chat turn, optionally with staged files (ISS-499). Files are uploaded
 * sequentially to the turn's session FIRST (multipart), then their ids ride the
 * `send` as `attachmentIds`. A per-file upload failure toasts but does not abort
 * the send — the message still goes with whatever uploaded (mirrors the comment
 * attachment flow). `opts.sessionId` is the resolved session id.
 */
export function useSendMessage(id: string) {
  const { toast } = useToast();
  const t = useCopy();
  return useToastWrite(
    async ({ files, ...opts }: SendOpts & { files?: File[] }) => {
      const ids: string[] = [...(opts.attachmentIds ?? [])];
      for (const file of files ?? []) {
        try {
          ids.push((await sessionApi.uploadAttachment(opts.sessionId, file)).id);
        } catch (err) {
          toast({ title: t("sessions.toast.attachmentFailed"), description: `${file.name}: ${formatRefusal(err)}`, tone: "error" });
        }
      }
      return sessionApi.send({ ...opts, attachmentIds: ids.length ? ids : undefined });
    },
    { touches: sessionTouches(id), failed: t("sessions.toast.failed"), describe: formatRefusal },
  );
}

export function useRegenerateTurn(id: string) {
  const t = useCopy();
  return useToastWrite((turnId: string) => sessionApi.regenerate(id, turnId), { touches: sessionTouches(id), failed: t("sessions.toast.failed"), describe: formatRefusal });
}

export function useEditTurn(id: string) {
  const t = useCopy();
  return useToastWrite(({ turnId, ...opts }: EditTurnOpts & { turnId: string }) => sessionApi.editTurn(id, turnId, opts), {
    touches: sessionTouches(id),
    failed: t("sessions.toast.failed"),
    describe: formatRefusal,
  });
}

export function useForkSession(id: string) {
  const t = useCopy();
  return useToastWrite((opts: ForkOpts) => sessionApi.fork(id, opts), { said: t("sessions.toast.forked"), failed: t("sessions.toast.failed"), describe: formatRefusal });
}
