"use client";

import { useState } from "react";
import { ConfirmDialog, enumLabel } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useAcceptInvitation, useDeclineInvitation, usePendingInvitations } from "../hooks";
import { toInvitationItem } from "../map";
import type { PendingInvitation } from "../types";

/** Pending invitations as actionable bell items (ISS-597), and the decline confirmation they open. */
export function useInvitationItems(open: boolean, onClose: () => void) {
  const { toast } = useToast();
  const t = useCopy();
  const language = useInterfaceLanguage();
  const pending = usePendingInvitations(open);
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  const [declining, setDeclining] = useState<PendingInvitation | null>(null);
  const busy = accept.isPending || decline.isPending;

  const items = (pending.data ?? []).map((inv) =>
    toInvitationItem(inv, [
      {
        id: "accept",
        label: t("shell.bell.accept"),
        variant: "primary",
        loading: accept.isPending && accept.variables?.ref === inv.ref,
        disabled: busy,
        onClick: () =>
          accept.mutate(
            { kind: inv.kind, ref: inv.ref },
            {
              onSuccess: () => toast({ title: t("shell.bell.joined", { name: inv.name, role: enumLabel("role", inv.role, language) }), tone: "success" }),
              onError: (err) => toast({ title: t("shell.bell.acceptFailed"), description: formatApiError(err), tone: "error" }),
            },
          ),
      },
      {
        id: "decline",
        label: t("shell.bell.decline"),
        variant: "ghost",
        loading: decline.isPending && decline.variables?.ref === inv.ref,
        disabled: busy,
        // The confirmation is a dialog in the page, under the dropdown's portal, so the dropdown steps aside.
        onClick: () => {
          setDeclining(inv);
          onClose();
        },
      },
    ], language),
  );

  const dialog = (
    <ConfirmDialog
      open={declining !== null}
      title={t("shell.bell.declineTitle", { name: declining?.name ?? "" })}
      message={t("shell.bell.declineMessage")}
      confirmLabel={t("shell.bell.declineConfirm")}
      tone="danger"
      loading={decline.isPending}
      onConfirm={() => {
        if (!declining) return;
        decline.mutate(
          { kind: declining.kind, ref: declining.ref },
          {
            onSuccess: () => toast({ title: t("shell.bell.declined"), tone: "success" }),
            onError: (err) => toast({ title: t("shell.bell.declineFailed"), description: formatApiError(err), tone: "error" }),
            onSettled: () => setDeclining(null),
          },
        );
      }}
      onClose={() => setDeclining(null)}
    />
  );

  return { items, query: pending, dialog };
}
