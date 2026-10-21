import { useState } from "react";
import { Banner, Button, Field, Input, PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useGitHubConnect } from "../../hooks";
import type { GitHubConnectStart } from "../../types";
import { useCompleteGitHubApp, useOrgGitHubConnect } from "./app";

type CompleteStart = Extract<GitHubConnectStart, { kind: "complete" }>;

function submitManifest(start: Extract<GitHubConnectStart, { kind: "manifest" }>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${start.postUrl}?state=${encodeURIComponent(start.state)}`;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = JSON.stringify(start.manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

/**
 * An App made before this Forge had one is completed, never joined by a second: an operator pastes
 * its client secret, and Connect GitHub then goes on to its install page.
 */
function CompleteApp({ start, onDone }: { start: CompleteStart; onDone: () => void }) {
  const complete = useCompleteGitHubApp();
  const [secret, setSecret] = useState("");
  const t = useCopy();
  return (
    <section className="flex flex-col gap-3 border-t border-line-subtle pt-4" data-testid="github-complete-app">
      <h3 className="fg-label">{t("integrations.github.completeTitle")}</h3>
      <p className="fg-body-sm text-muted">{t("integrations.github.completeBody", { app: start.displayName })}</p>
      <Field label={t("integrations.github.clientSecret")}>
        <Input
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          aria-label={t("integrations.github.clientSecret")}
        />
      </Field>
      {complete.isError && <Banner tone="danger">{formatApiError(complete.error)}</Banner>}
      <div>
        <Button
          onClick={() => complete.mutate({ connectionId: start.connectionId, clientSecret: secret }, { onSuccess: onDone })}
          disabled={secret.trim().length < 8 || complete.isPending}
        >
          {complete.isPending ? t("integrations.github.completing") : t("integrations.github.complete")}
        </Button>
      </div>
    </section>
  );
}

/**
 * Connect GitHub: one button. It goes to the instance App's install page; where this Forge has no
 * App yet and the caller is its operator, to the manifest that makes it; where an App made before
 * awaits completion, to completing it. Begun from a project it lands back there; begun for an org
 * from the workspace Integrations page (`returnTo`), there, where the App is bound into projects.
 */
export function CreateApp(props: { projectId: string; returnTo?: "integrations" } | { orgId: string; returnTo: "integrations" }) {
  const viaProject = useGitHubConnect("projectId" in props ? props.projectId : undefined);
  const viaOrg = useOrgGitHubConnect("orgId" in props ? props.orgId : undefined);
  const connect = "projectId" in props ? viaProject : viaOrg;
  const [completing, setCompleting] = useState<CompleteStart | null>(null);
  const t = useCopy();

  const start = async () => {
    const res = await connect.mutateAsync(props.returnTo ? { returnTo: props.returnTo } : {});
    if (res.kind === "install") window.location.assign(res.installUrl);
    else if (res.kind === "manifest") submitManifest(res);
    else setCompleting(res);
  };

  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("integrations.github.createTitle")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody className="flex flex-col gap-4">
        {connect.isError && <Banner tone="danger">{formatApiError(connect.error)}</Banner>}

        {completing ? (
          <CompleteApp
            start={completing}
            onDone={() => {
              setCompleting(null);
              void start();
            }}
          />
        ) : (
          <div>
            <Button onClick={() => void start()} disabled={connect.isPending} data-testid="github-connect">
              {connect.isPending ? t("integrations.github.preparing") : t("integrations.github.create")}
            </Button>
          </div>
        )}
      </PageSectionBody>
    </PageSection>
  );
}

/** GitHub's step on the workspace Integrations page: one button for the active org, no form. */
export function WorkspaceCreateApp({ orgId }: { orgId: string }) {
  return <CreateApp orgId={orgId} returnTo="integrations" />;
}
