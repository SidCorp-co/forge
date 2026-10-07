"use client";

import { Banner, Button } from "@/design";
import { useProject } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { CORE_URL } from "@/lib/utils/core-url";
import { useState } from "react";
import { useRotateIntegrationSecret } from "../../hooks";
import { Ticked } from "../shared";

/** The events Forge reads off a GitLab webhook; any other ticked event is refused by core. */
const GITLAB_WEBHOOK_EVENTS = ["Push events", "Merge request events", "Pipeline events"] as const;

/** Where GitLab posts deliveries for this project: core's inbound door, under the project's slug. */
function webhookUrl(slug: string | undefined): string {
  const origin = CORE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/api/webhooks/in/${slug ?? "<project slug>"}`;
}

/** How to point the GitLab project's webhook at Forge: the URL, a secret token, the three events. */
export function GitlabWebhookPanel({ projectId, bindingId }: { projectId: string; bindingId: string }) {
  const project = useProject(projectId);
  const rotate = useRotateIntegrationSecret(projectId);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useCopy();

  async function generate() {
    setError(null);
    try {
      setSecret((await rotate.mutateAsync(bindingId)).integrationSecret);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3" data-testid="gitlab-webhook">
      <span className="fg-label">Webhook</span>
      <p className="fg-body-sm text-muted">
        <Ticked text={t("integrations.gitlab.webhookHow")} />
      </p>
      <dl className="fg-body-sm grid grid-cols-1 gap-1 sm:grid-cols-[max-content_1fr] sm:gap-x-3">
        <dt className="text-muted">URL</dt>
        <dd className="min-w-0 break-all font-mono">{webhookUrl(project.data?.slug)}</dd>
        <dt className="text-muted">{t("integrations.gitlab.secret")}</dt>
        <dd className="min-w-0">
          {secret ? (
            <span className="break-all font-mono">{secret}</span>
          ) : (
            <span className="text-muted">
              {t("integrations.gitlab.secretHidden")}
            </span>
          )}
        </dd>
        <dt className="text-muted">{t("integrations.gitlab.trigger")}</dt>
        <dd>
          <Ticked text={t("integrations.gitlab.triggerEvents", { events: `\`${GITLAB_WEBHOOK_EVENTS.join(", ")}\`` })} />
        </dd>
      </dl>
      {secret && (
        <Banner tone="attention">{t("integrations.gitlab.copyNow")}</Banner>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      <div>
        <Button variant="secondary" onClick={generate} loading={rotate.isPending}>
          {t("integrations.gitlab.generate")}
        </Button>
      </div>
      <p className="fg-body-sm text-muted">
        {t("integrations.gitlab.generateNote")}
      </p>
    </div>
  );
}
