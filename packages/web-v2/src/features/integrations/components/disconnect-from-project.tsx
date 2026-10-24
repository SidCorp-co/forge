"use client";

import { useState } from "react";
import { Button } from "@/design";
import { useDeleteProviderIntegration } from "../hooks";
import type { IntegrationSummary } from "../types";
import { bindsRemovedConnection } from "./integration-enabled-control";

export const DISCONNECT_FROM_PROJECT = "Disconnect from this project…";

/** What a disconnect does, said before it is confirmed: the row stays, switched off (ISS-1421 r26). */
export function disconnectSays(
  subject: string,
  binding: Pick<IntegrationSummary, "connectionActive" | "hasSecrets">,
): string {
  const off = `Disconnecting switches ${subject} off for this project`;
  if (bindsRemovedConnection(binding)) return `${off}, so it stays off if the connection is turned back on.`;
  // Enabled alone does not bring back a binding whose shared connection is off too.
  const back = binding.connectionActive
    ? "until Enabled in this drawer switches it back on"
    : "until its shared connection is turned back on and Enabled in this drawer switches it back on";
  return `${off}, and nothing here uses it ${back}. The connection and its key stay.`;
}

/**
 * One way every provider takes a binding off a project. Coolify and Epodsystem called it Delete behind
 * a browser confirm, Google and Rocket.Chat asked in a browser confirm, Sentry and Postman sent it on
 * one click, and GitHub asked here (ISS-1421 r26); none of them deletes the row, which stays switched
 * off. A binding already off is offered none (judge-105 (7)). Drawn inside a wrapping row, the
 * question takes the row's full width beneath the buttons.
 */
export function DisconnectFromProject({
  projectId,
  binding,
  says,
}: {
  projectId: string;
  binding: Pick<IntegrationSummary, "id" | "bindingActive">;
  /** The question's sentence: what stops for this project, and what stays. */
  says: string;
}) {
  const remove = useDeleteProviderIntegration(projectId);
  const [confirming, setConfirming] = useState(false);
  if (!binding.bindingActive) return null;

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setConfirming((v) => !v)}>
        {DISCONNECT_FROM_PROJECT}
      </Button>
      {confirming && (
        <div className="flex basis-full flex-col gap-2 border-y border-line py-2.5">
          <p className="fg-body-sm text-fg">{says}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate(binding.id, { onSuccess: () => setConfirming(false) })}
            >
              Disconnect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
