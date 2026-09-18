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

const ERROR_COPY: Record<string, string> = {
  SPEAKER_SOURCE_UNKNOWN: "That chat channel is not one this Forge knows.",
  SPEAKER_NOT_FOUND: "That chat account no longer exists on the channel.",
  SPEAKER_ADDRESS_DIFFERS:
    "The two addresses do not match. Make them the same on either side, then reopen this link.",
  SPEAKER_NOT_THE_TARGET:
    "This chat account reports a different address from the one you are signed in with.",
};

function copy(err: unknown): string {
  if (err instanceof ApiError && err.code && ERROR_COPY[err.code])
    return ERROR_COPY[err.code] as string;
  return formatApiError(err);
}

function speakerName(p: Proposal): string {
  return p.speaker.username ?? p.speaker.externalId;
}

function LinkChat() {
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
      .catch((err) => setLoadError(copy(err)));
  }, [path, body]);

  useEffect(() => {
    if (!ready) {
      setLoadError("This link is missing the chat account it is about.");
      return;
    }
    if (!user) return;
    load();
  }, [ready, user, load]);

  async function confirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      await apiClient(path, { method: "POST", body });
      setLinked(true);
    } catch (err) {
      setConfirmError(copy(err));
    } finally {
      setConfirming(false);
    }
  }

  const mine = proposal?.candidates.find((c) => c.userId === user?.id);

  return (
    <AuthShell
      title={linked ? "Chat account linked" : "Link your chat account"}
      subtitle={
        linked
          ? "Answers you send from that account now count as yours."
          : "Confirm that the chat account below is you, so Forge can record what you answer."
      }
      footer={
        !user && !authLoading ? (
          <>
            Sign in with the email this chat account uses, then reopen this link.
          </>
        ) : undefined
      }
    >
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
        <Banner tone="success">
          Linked. Go back to the chat thread and answer again — the reply will be
          recorded as you.
        </Banner>
      ) : !proposal ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-3/4 rounded-md" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-line bg-surface px-4 py-3">
            <p className="text-fg">
              <strong>{speakerName(proposal)}</strong> on{" "}
              <strong>{proposal.speaker.namespace}</strong>
            </p>
            <p className="fg-body-sm text-muted">
              That channel reports{" "}
              <strong>{proposal.speaker.emailOnChannel ?? "no address"}</strong>{" "}
              for it. You are signed in as <strong>{user.email}</strong>.
            </p>
          </div>

          {confirmError && <Banner tone="danger">{confirmError}</Banner>}

          {mine?.confirmable ? (
            <Button
              variant="primary"
              className="w-full"
              loading={confirming}
              onClick={confirm}
            >
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
