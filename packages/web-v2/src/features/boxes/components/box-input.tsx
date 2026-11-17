// The holder's hands on the box (ISS-1276 c5): over the live view, in its exact bounds, a layer that
// turns pointer, taps, wheel and keys into `BoxInput` lines on the input socket, entered with its own
// one-minute ticket. Only the person holding the box gets this layer; everyone else watches.

import type { BoxInput } from "@forge/contracts/box-wire";
import type { BoxRecord } from "@forge/contracts/boxes";
import { useQuery } from "@tanstack/react-query";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import { boxSocketUrl } from "../api";
import { boxQueries } from "../queries";
import { type InputSocket, keyInput, openInput, pointOn } from "../view/input";

/** A drag sends at most this many moves a second. */
const MOVE_EVERY_MS = 33;

export function BoxInputLayer({ box, label, onInput }: { box: BoxRecord; label: string; onInput: () => void }) {
  const t = useCopy();
  const ticket = useQuery(boxQueries.ticket(box.id, "input", box.heldSince ?? ""));
  const url = ticket.data?.url ?? null;
  const socketRef = useRef<InputSocket | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const pressedRef = useRef(false);
  const lastMoveRef = useRef(0);

  useEffect(() => {
    if (!url) return;
    const s = openInput(boxSocketUrl(url), setRefused);
    socketRef.current = s;
    return () => {
      socketRef.current = null;
      s.close();
    };
  }, [url]);

  const send = (input: BoxInput) => {
    socketRef.current?.send(input);
    onInput();
  };
  const at = (e: PointerEvent<HTMLButtonElement>) => pointOn(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
  const why = refused ?? (ticket.error ? ticket.error.message : null);

  // a button, so it takes focus and keys as a control does; it has no click of its own, and a key it
  // sends is kept from activating it
  return (
    <>
    <button
      type="button"
      aria-label={t("boxes.view.title", { box: label })}
      data-testid="box-input"
      className="absolute inset-0 cursor-crosshair touch-none bg-transparent outline-none focus-visible:shadow-focus"
      onPointerDown={(e) => {
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        pressedRef.current = true;
        send({ t: "pointer", action: "down", ...at(e) });
      }}
      onPointerMove={(e) => {
        if (!pressedRef.current || e.timeStamp - lastMoveRef.current < MOVE_EVERY_MS) return;
        lastMoveRef.current = e.timeStamp;
        send({ t: "pointer", action: "move", ...at(e) });
      }}
      onPointerUp={(e) => {
        pressedRef.current = false;
        send({ t: "pointer", action: "up", ...at(e) });
      }}
      onWheel={(e) => send({ t: "scroll", ...pointOn(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY), dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) })}
      onKeyDown={(e) => {
        const input = keyInput(e);
        if (!input) return;
        e.preventDefault();
        send(input);
      }}
    />
    {why ? (
      <p role="alert" className="pointer-events-none absolute inset-x-0 bottom-0 bg-danger-3 px-3 py-1.5 text-12 text-danger-11" data-testid="box-input-refused">
        {t("boxes.input.failed", { why })}
      </p>
    ) : null}
    </>
  );
}
