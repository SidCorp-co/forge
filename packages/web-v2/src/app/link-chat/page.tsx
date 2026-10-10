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
import { useAuth } from "@/providers/auth-provider";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

const ERROR_COPY: Record<string, string> = {
  SPEAKER_SOURCE_UNKNOWN: "That chat channel is not one this Forge knows.",
  SPEAKER_NOT_FOUND: "That chat account no longer exists on the channel.",
  SPEAKER_ADDRESS_DIFFERS:
    "The two addresses do not match. Make them the same on either side, then reopen this link.",
  SPEAKER_NOT_THE_TARGET:
    "This chat account reports a different address from the one you are signed in with.",
};

function copy(err: unknown): string {
  const known = err instanceof ApiError && err.code ? ERROR_COPY[err.code] : undefined;
  return known ?? formatApiError(err);
}

function speakerName(p: Proposal): string {
  return p.speaker.username ?? p.speaker.externalId;
}

const linksPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/speaker-links`;
const speakerBody = (source: string, externalId: string) => JSON.stringify({ source, externalId });

function LinkChat() {
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
  const loadError = !ready ? "This link is missing the chat account it is about." : proposalQ.isError ? copy(proposalQ.error) : null;
  const linked = confirm.isSuccess;

  return (
    <AuthShell
      title={linked ? "Chat account linked" : "Link your chat account"}
      subtitle={linked ? "Answers you send from that account now count as yours." : "Confirm that the chat account below is you, so Forge can record what you answer."}
      footer={!user && !authLoading ? <>Sign in with the email this chat account uses, then reopen this link.</> : undefined}
    >
      <LinkChatState
        loadError={loadError}
        authLoading={authLoading}
        user={user}
        linked={linked}
        proposal={proposalQ.data}
        confirming={confirm.isPending}
        confirmError={confirm.isError ? copy(confirm.error) : null}
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
  return (
    <>
    {loadError ? (
      <Banner tone="danger">{loadError}</Banner>
    ) : authLoading ? (
      <Skeleton className="h-9 w-full rounded-md" />
    ) : !user ? (
      <Link href="/login" className="block">
        <Button variant="primary" className="w-full">
          Sign in to continue
        </Button>
      </Link>
    ) : linked ? (
      <Banner tone="success">Linked. Go back to the chat thread and answer again — the reply will be recorded as you.</Banner>
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
  const mine = proposal.candidates.find((c) => c.userId === userId);
  return (
    <div className="space-y-4">
      <div className="space-y-2 border-y border-line-subtle py-3">
        <p className="text-fg">
          <strong>{speakerName(proposal)}</strong> on <strong>{proposal.speaker.namespace}</strong>
        </p>
        <p className="fg-body-sm text-muted">
          That channel reports <strong>{proposal.speaker.emailOnChannel ?? "no address"}</strong> for it. You are signed in as <strong>{email}</strong>.
        </p>
      </div>
      {confirmError ? <Banner tone="danger">{confirmError}</Banner> : null}
      {mine?.confirmable ? (
        <Button variant="primary" className="w-full" loading={confirming} onClick={onConfirm}>
          This is me — link it
        </Button>
      ) : (
        <Banner tone="attention">
          {mine
            ? "The local parts match but the domains do not, which proposes a link and cannot confirm one. Make the two addresses the same, on either side, then reopen this link."
            : "This chat account reports an address no Forge account of yours holds. Change it on either side so the two match, then reopen this link — nobody can confirm this on your behalf."}
        </Banner>
      )}
    </div>
  );
}

export default function LinkChatPage() {
  return (
    <Suspense fallback={null}>
      <LinkChat />
    </Suspense>
  );
}
