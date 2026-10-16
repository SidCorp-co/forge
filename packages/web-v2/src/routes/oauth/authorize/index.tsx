import { createFileRoute } from "@tanstack/react-router";
// An MCP client's sign-in (Claude Code connecting to this Forge's /mcp): the client sends the
// browser here with its OAuth request, the person picks the reach to give it, and core answers where
// the browser goes back to — the client's own redirect URI, carrying the code or the denial. Outside
// _auth, whose layout bounces signed-in people, and outside _workspace, which wraps a shell.

import { Banner, Button, Skeleton } from "@/design";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { loginHref } from "@/features/auth";
import { ConsentForm, requestFrom, useConsentView } from "@/features/mcp-auth";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { Link, useSearchParams } from "@/lib/navigation/router";
import { useAuth } from "@/providers/auth-provider";
import { Suspense } from "react";

function Authorize() {
  const t = useCopy();
  const params = useSearchParams();
  const { user, isLoading: authLoading } = useAuth();
  const request = requestFrom(params);
  const complete = Boolean(request.client_id && request.redirect_uri && request.code_challenge);
  const viewQ = useConsentView(request, complete && Boolean(user));
  // base-path relative, as every in-app href is: sign-in and an SSO re-auth both come back here
  const returnPath = `/oauth/authorize?${new URLSearchParams(request)}`;

  const loadError = !complete
    ? t("auth.mcpConsent.incomplete")
    : viewQ.isError
      ? formatApiError(viewQ.error)
      : params.get("reauth_error")
        ? t("settings.tokens.reauth.failed")
        : null;

  return (
    <AuthShell
      title={t("auth.mcpConsent.title")}
      footer={!user && !authLoading ? t("auth.mcpConsent.signInFirst") : undefined}
    >
      {loadError ? (
        <Banner tone="danger">{loadError}</Banner>
      ) : authLoading ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : !user ? (
        <Link href={loginHref(returnPath)} className="block">
          <Button variant="primary" className="w-full">
            {t("auth.linkChat.signInToContinue")}
          </Button>
        </Link>
      ) : !viewQ.data ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-3/4 rounded-md" />
        </div>
      ) : (
        <ConsentForm view={viewQ.data} request={request} returnPath={returnPath} />
      )}
    </AuthShell>
  );
}

function AuthorizePage() {
  return (
    <Suspense fallback={null}>
      <Authorize />
    </Suspense>
  );
}

export const Route = createFileRoute("/oauth/authorize/")({ component: AuthorizePage });
