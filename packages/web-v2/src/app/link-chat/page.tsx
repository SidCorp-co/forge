"use client";

// Confirm that a chat account is yours — the target of the link every unlinked-speaker
// refusal carries (`/link-chat?projectId=…&source=…&externalId=…`). Outside (auth), whose
// layout bounces signed-in users, and outside (workspace), which wraps a shell: like
// /invite/accept this page must serve both auth states.
//
// Adapter-agnostic on purpose. `source` is whatever the channel called itself and is only
// ever echoed back to the API and shown as a label, so a new transport needs no change here.

import { Banner, Button, Skeleton } from "@/design";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { ApiError, apiClient } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useAuth } from "@/providers/auth-provider";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

interface Candidate {
  userId: string;
  email: string;
  matchedOn: "address" | "local-part";
  confirmable: boolean;
}

interface Proposal {
  speaker: {
    source: string;
    namespace: string;
    externalId: string;
    username: string | null;
    emailOnChannel: string | null;
  };
  candidates: Candidate[];
  youMayConfirm: boolean;
}

const ERROR_COPY: Record<string, (t: Copy) => string> = {
  SPEAKER_SOURCE_UNKNOWN: (t) => t("auth.linkChatRefused.sourceUnknown"),
  SPEAKER_NOT_FOUND: (t) => t("auth.linkChatRefused.notFound"),
  SPEAKER_ADDRESS_DIFFERS: (t) => t("auth.linkChatRefused.addressDiffers"),
  SPEAKER_NOT_THE_TARGET: (t) => t("auth.linkChatRefused.notTheTarget"),
};

function copy(err: unknown, t: Copy): string {
  const said = err instanceof ApiError && err.code ? ERROR_COPY[err.code] : undefined;
  return said ? said(t) : formatApiError(err);
}

function speakerName(p: Proposal): string {
  return p.speaker.username ?? p.speaker.externalId;
}

function LinkChat() {
  const t = useCopy();
  const params = useSearchParams();
  const { user, isLoading: authLoading } = useAuth();

  const projectId = params.get("projectId") ?? "";
  const source = params.get("source") ?? "";
  const externalId = params.get("externalId") ?? "";
  const ready = Boolean(projectId && source && externalId);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [linked, setLinked] = useState(false);

  const body = JSON.stringify({ source, externalId });
  const path = `/projects/${encodeURIComponent(projectId)}/speaker-links`;

  const load = useCallback(() => {
    apiClient<Proposal>(`${path}/proposals`, { method: "POST", body })
      .then(setProposal)
      .catch((err) => setLoadError(copy(err, t)));
  }, [path, body, t]);

  useEffect(() => {
    if (!ready) {
      setLoadError(t("auth.linkChatRefused.missing"));
      return;
    }
    if (!user) return;
    load();
  }, [ready, user, load, t]);

  async function confirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await apiClient(path, { method: "POST", body });
      setLinked(true);
    } catch (err) {
      setConfirmError(copy(err, t));
    } finally {
      setConfirming(false);
    }
  }

  const mine = proposal?.candidates.find((c) => c.userId === user?.id);

  return (
    <AuthShell
      title={linked ? t("auth.linkChat.titleLinked") : t("auth.linkChat.title")}
      subtitle={linked ? t("auth.linkChat.linked") : undefined}
      footer={!user && !authLoading ? t("auth.linkChat.signInThen") : undefined}
    >
      {loadError ? (
        <Banner tone="danger">{loadError}</Banner>
      ) : authLoading ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : !user ? (
        <Link href="/login" className="block">
          <Button variant="primary" className="w-full">
            {t("auth.linkChat.signInToContinue")}
          </Button>
        </Link>
      ) : linked ? (
        <Banner tone="success">{t("auth.linkChat.answerAgain")}</Banner>
      ) : !proposal ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-3/4 rounded-md" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-line bg-surface px-4 py-3">
            <p className="font-semibold text-fg">
              {t("auth.linkChat.speakerOn", { name: speakerName(proposal), channel: proposal.speaker.namespace })}
            </p>
            <p className="fg-body-sm text-muted">
              {t("auth.linkChat.channelAddress", { address: proposal.speaker.emailOnChannel ?? t("auth.linkChat.noAddress") })}
            </p>
            <p className="fg-body-sm text-muted">{t("auth.linkChat.signedInAs", { email: user.email })}</p>
          </div>

          {confirmError && <Banner tone="danger">{confirmError}</Banner>}

          {mine?.confirmable ? (
            <Button
              variant="primary"
              className="w-full"
              loading={confirming}
              onClick={confirm}
            >
              {t("auth.linkChat.confirm")}
            </Button>
          ) : (
            <Banner tone="attention">
              {mine ? t("auth.linkChat.domainsDiffer") : t("auth.linkChat.cannotConfirm")}
            </Banner>
          )}
        </div>
      )}
    </AuthShell>
  );
}

export default function LinkChatPage() {
  return (
    <Suspense fallback={null}>
      <LinkChat />
    </Suspense>
  );
}
