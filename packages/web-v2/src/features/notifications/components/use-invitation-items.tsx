"use client";

import { useState } from "react";
import { ConfirmDialog, enumLabel } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { useAcceptInvitation, useDeclineInvitation, usePendingInvitations } from "../hooks";
import { toInvitationItem } from "../map";
import type { PendingInvitation } from "../types";

/** Pending invitations as actionable bell items (ISS-597), and the decline confirmation they open. */
export function useInvitationItems(open: boolean, onClose: () => void) {
  const { toast } = useToast();
  const pending = usePendingInvitations(open);
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  const [declining, setDeclining] = useState<PendingInvitation | null>(null);
  const busy = accept.isPending || decline.isPending;

  const items = (pending.data ?? []).map((inv) =>
    toInvitationItem(inv, [
      {
        id: "accept",
        label: "Accept",
        variant: "primary",
        loading: accept.isPending && accept.variables?.ref === inv.ref,
        disabled: busy,
        onClick: () =>
          accept.mutate(
            { kind: inv.kind, ref: inv.ref },
            {
              onSuccess: () => toast({ title: `You joined ${inv.name} as ${enumLabel("role", inv.role)}`, tone: "success" }),
              onError: (err) => toast({ title: "Failed to accept invitation", description: formatApiError(err), tone: "error" }),
            },
          ),
      },
      {
        id: "decline",
        label: "Decline",
        variant: "ghost",
        loading: decline.isPending && decline.variables?.ref === inv.ref,
        disabled: busy,
        // The confirmation is a dialog in the page, under the dropdown's portal, so the dropdown steps aside.
        onClick: () => {
          setDeclining(inv);
          onClose();
        },
      },
    ]),
  );

  const dialog = (
    <ConfirmDialog
      open={declining !== null}
      title={`Decline invitation to ${declining?.name ?? ""}?`}
      message="You will no longer see this invitation in your notifications. You can still accept it via the original email link."
      confirmLabel="Yes, decline"
      tone="danger"
      loading={decline.isPending}
      onConfirm={() => {
        if (!declining) return;
        decline.mutate(
          { kind: declining.kind, ref: declining.ref },
          {
            onSuccess: () => toast({ title: "Invitation declined", tone: "success" }),
            onError: (err) => toast({ title: "Failed to decline invitation", description: formatApiError(err), tone: "error" }),
            onSettled: () => setDeclining(null),
          },
        );
      }}
      onClose={() => setDeclining(null)}
    />
  );

  return { items, query: pending, dialog };
}
