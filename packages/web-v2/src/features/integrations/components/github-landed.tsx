"use client";

import { ButtonLink } from "@/design";
import { AuthShell } from "@/features/auth/components/auth-shell";

/**
 * Where GitHub's return to Forge lands a person when Forge could not finish: setup_url and the
 * manifest callback are API addresses, and a refusal there was JSON in their tab (ISS-1421 r27).
 * Worded from the refusal's code alone. Outside both route groups, as /link-chat is, so a person
 * whose session lapsed while GitHub had them reads it rather than being sent to sign in.
 */
const SIGNED_OUT =
  "You were signed out while GitHub had you, so Forge recorded nothing. Sign in, then start again from the project's Integrations tab.";

const BY_CODE: Record<string, string> = {
  NOT_FOUND:
    "No GitHub App connected to a project you administer owns this installation, so Forge recorded nothing. Install the App from the project's Integrations tab.",
  CREDENTIAL_UNREADABLE:
    "Forge could not read the stored key of a GitHub App this installation may belong to, so it recorded nothing. On the Integrations page, remove that App's connection and create the App again from the project.",
  FORBIDDEN:
    "Only an admin of the project can add a GitHub App to it, so Forge recorded nothing. Ask one of them to install the App from the project's Integrations tab.",
  ORG_ADMIN_REQUIRED:
    "Only an owner or admin of the organization can create a GitHub App it owns, so Forge recorded nothing. Ask one of them, or create the App as your own.",
  BAD_REQUEST:
    "This return from GitHub has expired or was started by someone else, so Forge recorded nothing. Start again from the project's Integrations tab.",
  UNAUTHENTICATED: SIGNED_OUT,
  INVALID_TOKEN: SIGNED_OUT,
};

const ANYTHING_ELSE =
  "Forge could not finish adding the GitHub App, so it recorded nothing. Start again from the project's Integrations tab.";

export function githubLandedWords(code: string | null): string {
  return (code && BY_CODE[code]) || ANYTHING_ELSE;
}

export function GithubLanded({ code }: { code: string | null }) {
  return (
    <AuthShell title="GitHub sent you back, but Forge could not finish" subtitle={githubLandedWords(code)}>
      <ButtonLink href="/integrations" variant="secondary">
        Go to Integrations
      </ButtonLink>
    </AuthShell>
  );
}
