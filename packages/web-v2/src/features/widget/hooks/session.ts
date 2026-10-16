import type { WidgetIdentityMode, WidgetSession, WidgetSessionRequest } from "@forge/contracts/widget";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { widgetApi } from "../api";
import { type Shown, shownOf } from "../refusal";
import { keepVisitor, readVisitor } from "../visitor-store";
import type { HostChannel } from "./host";

/** Where the visitor stands before the chat: asked who they are, waiting on the page, or refused. */
export type SessionView =
  | { step: "ask"; refusal: Shown | null }
  | { step: "wait"; refusal: Shown | null }
  | { step: "opening" }
  | { step: "open"; session: WidgetSession }
  | { step: "refused"; refusal: Shown };

/**
 * A refusal no retry from this frame can change: the binding itself, or this origin, is refused —
 * the page's own (core reads the Origin) or the one that framed it (`embeddedAt`, from the host channel).
 */
const FINAL = new Set(["WIDGET_SITE_UNKNOWN", "WIDGET_ORIGIN_REFUSED"]);

export interface VisitorSession {
  view: SessionView;
  keptEmail: string | null;
  /** Opens a session: with the email the visitor typed, or as the page signed them in. */
  start: (visitor?: { email?: string }) => void;
  /** The session ended under the chat (expired, refused): back to the step before it, saying why. */
  end: (why: Shown) => void;
}

/**
 * The visitor session, opened the way the binding's identity mode asks: `anonymous` and `email` from
 * the visitor's own answer (a returning anonymous visitor at once), `signed` as soon as the page
 * hands over its signature, and again whenever it hands over a different one.
 */
export function useVisitorSession(siteKey: string, mode: WidgetIdentityMode, host: HostChannel): VisitorSession {
  const [kept, setKept] = useState(() => readVisitor(siteKey));
  const [returning] = useState(kept.visitorId);
  const [session, setSession] = useState<WidgetSession | null>(null);
  const [refusal, setRefusal] = useState<Shown | null>(null);
  const open = useMutation({ mutationFn: (body: WidgetSessionRequest) => widgetApi.openSession(siteKey, body) });

  function start(visitor?: { email?: string }) {
    const signed = host.signed;
    if (mode === "signed" && !signed) return;
    const email = visitor?.email?.trim() || undefined;
    const body: WidgetSessionRequest = {
      ...(mode !== "signed" && email ? { visitor: { email } } : {}),
      ...(mode === "signed" && signed ? { signed } : {}),
      ...(host.context ? { context: host.context } : {}),
      ...(host.parentOrigin ? { embeddedAt: host.parentOrigin } : {}),
      ...(kept.visitorId ? { visitorId: kept.visitorId } : {}),
    };
    open.mutate(body, {
      onSuccess: (opened) => {
        const next = { visitorId: opened.visitorId, email: email ?? kept.email };
        keepVisitor(siteKey, next);
        setKept(next);
        setRefusal(null);
        setSession(opened);
      },
      onError: (err) => {
        setSession(null);
        setRefusal(shownOf(err));
      },
    });
  }

  // a returning anonymous visitor goes straight in; a signed one as soon as the page signs them in,
  // and again for each signature the page hands over that no session was opened with yet
  const autoStart = mode === "anonymous" ? returning : mode === "signed" ? (host.signed?.sig ?? null) : null;
  const startOnce = useEffectEvent((answer: string) => {
    if (open.variables?.signed?.sig === answer) return;
    start(kept.email ? { email: kept.email } : undefined);
  });
  useEffect(() => {
    if (autoStart) startOnce(autoStart);
  }, [autoStart]);

  return {
    view: viewOf(mode, session, refusal, open.isPending),
    keptEmail: kept.email,
    start,
    end: (why) => {
      setSession(null);
      setRefusal(why);
    },
  };
}

function viewOf(mode: WidgetIdentityMode, session: WidgetSession | null, refusal: Shown | null, opening: boolean): SessionView {
  if (opening) return { step: "opening" };
  if (session) return { step: "open", session };
  if (refusal && (FINAL.has(refusal.code) || refusal.code === "WIDGET_LIMIT_REACHED")) return { step: "refused", refusal };
  return mode === "signed" ? { step: "wait", refusal } : { step: "ask", refusal };
}
