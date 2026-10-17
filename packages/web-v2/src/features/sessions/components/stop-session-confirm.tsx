"use client";

import { ConfirmDialog } from "@/design";

export interface StopTarget {
  /** The session as the page names it. */
  name: string;
  /** The box running it, where one is known. */
  box?: string | null;
}

/** What a stop ends, said before it ends it: the agent's process goes, and nothing brings it back. */
export function stopSessionMessage(target: StopTarget): string {
  const where = target.box ? ` on ${target.box}` : "";
  return `${target.name}${where} stops now. Its agent's process ends and any issue it holds is let go. It reads Stopped from then on, and Rerun starts a fresh session.`;
}

/**
 * The one confirmation every Stop session asks (ISS-1228): a stop ends a running agent, so it names
 * which one before it does. Open while `target` is set.
 */
export function StopSessionConfirm({
  target,
  loading,
  onConfirm,
  onClose,
}: {
  target: StopTarget | null;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={target !== null}
      title="Stop this session?"
      message={target ? stopSessionMessage(target) : ""}
      confirmLabel="Stop session"
      cancelLabel="Keep it running"
      tone="danger"
      loading={loading}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
