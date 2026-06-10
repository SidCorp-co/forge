"use client";

import { Badge, Banner, Button, Skeleton } from "@/design";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { ApiError, apiClient } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
// Invitation accept landing — the target of every invitation email
// (`/invite/accept?token=…[&kind=org]`). Lives OUTSIDE the (auth) group (its
// layout bounces signed-in users to /) and outside (workspace) (no shell):
// the page must serve both auth states — show the invite, then either accept
// (signed in) or hand off to login/register (signed out).
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

interface InviteInfo {
  /** Project invites carry projectName; org invites carry orgName. */
  projectName?: string;
  orgName?: string;
  inviterEmail: string;
  role: string;
  email: string;
  expiresAt: string;
}

const ERROR_COPY: Record<string, string> = {
  INVALID_TOKEN: "This invitation link is invalid or was revoked.",
  EXPIRED_TOKEN: "This invitation has expired — ask for a new one.",
  ALREADY_ACCEPTED: "This invitation was already accepted.",
  INVITATION_EMAIL_MISMATCH:
    "You are signed in with a different email than the one this invitation was sent to.",
};

function inviteCopy(err: unknown): string {
  if (err instanceof ApiError && err.code && ERROR_COPY[err.code])
    return ERROR_COPY[err.code];
  return formatApiError(err);
}

function AcceptInvite() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();

  const token = params.get("token") ?? "";
  const isOrg = params.get("kind") === "org";
  const base = isOrg ? "/org-invitations" : "/invitations";

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError(ERROR_COPY.INVALID_TOKEN ?? "Missing invitation token.");
      return;
    }
    apiClient<InviteInfo>(`${base}/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((err) => setLoadError(inviteCopy(err)));
  }, [token, base]);

  async function accept() {
    setAccepting(true);
    setAcceptError(null);
    try {
      await apiClient(`${base}/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      router.push(isOrg ? "/settings?tab=orgs" : "/projects");
    } catch (err) {
      setAcceptError(inviteCopy(err));
      setAccepting(false);
    }
  }

  const targetName = info?.orgName ?? info?.projectName ?? "";
  const kindLabel = isOrg ? "organization" : "project";

  return (
    <AuthShell
      title="You're invited"
      subtitle={
        info
          ? `Join the ${targetName} ${kindLabel} on Forge.`
          : "Checking your invitation…"
      }
      footer={
        !user ? (
          <>
            New to Forge?{" "}
            <Link
              href={`/register${info ? `?email=${encodeURIComponent(info.email)}` : ""}`}
              className="text-link font-semibold"
            >
              Create an account
            </Link>{" "}
            with the invited email, then reopen this link.
          </>
        ) : undefined
      }
    >
      {loadError ? (
        <Banner tone="danger">{loadError}</Banner>
      ) : !info ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-3/4 rounded-md" />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-line bg-surface px-4 py-3">
            <p className="text-fg">
              <strong>{info.inviterEmail}</strong> invited{" "}
              <strong>{info.email}</strong> to join{" "}
              <strong>{targetName}</strong> as{" "}
              <Badge tone="accent">{info.role}</Badge>
            </p>
            <p className="fg-body-sm text-muted">
              Valid until {new Date(info.expiresAt).toLocaleDateString()}.
            </p>
          </div>

          {acceptError && <Banner tone="danger">{acceptError}</Banner>}

          {authLoading ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : user ? (
            <Button
              variant="primary"
              className="w-full"
              loading={accepting}
              onClick={accept}
            >
              Accept invitation
            </Button>
          ) : (
            <Link
              href={`/login?email=${encodeURIComponent(info.email)}`}
              className="block"
            >
              <Button variant="primary" className="w-full">
                Sign in to accept
              </Button>
            </Link>
          )}
        </div>
      )}
    </AuthShell>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInvite />
    </Suspense>
  );
}
