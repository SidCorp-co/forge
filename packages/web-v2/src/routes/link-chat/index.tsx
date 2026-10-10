import { createFileRoute } from "@tanstack/react-router";
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
import { Link, useSearchParams } from "@/lib/navigation/router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Suspense } from "react";

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

const linksPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/speaker-links`;
const speakerBody = (source: string, externalId: string) => JSON.stringify({ source, externalId });

function LinkChat() {
  const t = useCopy();
  const params = useSearchParams();
  const { user, isLoading: authLoading } = useAuth();

  const projectId = params.get("projectId") ?? "";
  const source = params.get("source") ?? "";
  const externalId = params.get("externalId") ?? "";
  const ready = Boolean(projectId && source && externalId);
  const proposalQ = useQuery({
    queryKey: ["speaker-link-proposal", projectId, source, externalId],
    queryFn: () => apiClient<Proposal>(`${linksPath(projectId)}/proposals`, { method: "POST", body: speakerBody(source, externalId) }),
    enabled: ready && Boolean(user),
    retry: false,
  });
  const confirm = useMutation({ mutationFn: () => apiClient(linksPath(projectId), { method: "POST", body: speakerBody(source, externalId) }) });
  const loadError = !ready ? t("auth.linkChatRefused.missing") : proposalQ.isError ? copy(proposalQ.error, t) : null;
  const linked = confirm.isSuccess;

  return (
    <AuthShell
      title={linked ? t("auth.linkChat.titleLinked") : t("auth.linkChat.title")}
      subtitle={linked ? t("auth.linkChat.linked") : undefined}
      footer={!user && !authLoading ? t("auth.linkChat.signInThen") : undefined}
    >
      <LinkChatState
        loadError={loadError}
        authLoading={authLoading}
        user={user}
        linked={linked}
        proposal={proposalQ.data}
        confirming={confirm.isPending}
        confirmError={confirm.isError ? copy(confirm.error, t) : null}
        onConfirm={() => confirm.mutate()}
      />
    </AuthShell>
  );
}

/** Where the link stands: a refusal, signing in, linked, loading, or the proposal to confirm. */
function LinkChatState({
  loadError,
  authLoading,
  user,
  linked,
  proposal,
  confirming,
  confirmError,
  onConfirm,
}: {
  loadError: string | null;
  authLoading: boolean;
  user: { id: string; email: string } | null | undefined;
  linked: boolean;
  proposal: Proposal | undefined;
  confirming: boolean;
  confirmError: string | null;
  onConfirm: () => void;
}) {
  const t = useCopy();
  return (
    <>
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
      <SpeakerProposal
        proposal={proposal}
        userId={user.id}
        email={user.email}
        confirming={confirming}
        confirmError={confirmError}
        onConfirm={onConfirm}
      />
    )}
    </>
  );
}

/** The chat account the link is about, and either the confirm act or why it cannot be confirmed. */
function SpeakerProposal({
  proposal,
  userId,
  email,
  confirming,
  confirmError,
  onConfirm,
}: {
  proposal: Proposal;
  userId: string;
  email: string;
  confirming: boolean;
  confirmError: string | null;
  onConfirm: () => void;
}) {
  const t = useCopy();
  const mine = proposal.candidates.find((c) => c.userId === userId);
  return (
    <div className="space-y-4">
      <div className="space-y-2 border-y border-line-subtle py-3">
        <p className="font-semibold text-fg">{t("auth.linkChat.speakerOn", { name: speakerName(proposal), channel: proposal.speaker.namespace })}</p>
        <p className="fg-body-sm text-muted">
          {t("auth.linkChat.channelAddress", { address: proposal.speaker.emailOnChannel ?? t("auth.linkChat.noAddress") })}
        </p>
        <p className="fg-body-sm text-muted">{t("auth.linkChat.signedInAs", { email })}</p>
      </div>
      {confirmError ? <Banner tone="danger">{confirmError}</Banner> : null}
      {mine?.confirmable ? (
        <Button variant="primary" className="w-full" loading={confirming} onClick={onConfirm}>
          {t("auth.linkChat.confirm")}
        </Button>
      ) : (
        <Banner tone="attention">
          {mine ? t("auth.linkChat.domainsDiffer") : t("auth.linkChat.cannotConfirm")}
        </Banner>
      )}
    </div>
  );
}

function LinkChatPage() {
  return (
    <Suspense fallback={null}>
      <LinkChat />
    </Suspense>
  );
}

export const Route = createFileRoute("/link-chat/")({ component: LinkChatPage });
