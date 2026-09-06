"use client";

import { Badge, Button, Input, NativeSelect } from "@/design";
import { useMemo } from "react";
import { useCoolifyApplications, useCoolifyTargets } from "../hooks";
import type { CoolifyApplication, CoolifyTargetInput } from "../types";

/**
 * ISS-925 — the deploy targets of one Coolify binding, picked rather than
 * transcribed.
 *
 * The uuid used to be a field an operator copied out of another browser tab,
 * with nothing in Forge able to say whether the one they pasted was the app
 * they meant. Coolify lists its applications, so the field is a pick-list, and
 * a bound target renders the name, domain and branch@sha Coolify reports for
 * it — a wrong binding is then visible without leaving Forge.
 */
export function CoolifyTargetsField({
  projectId,
  environment,
  integrationId,
  baseUrl,
  apiToken,
  targets,
  onChange,
  inherited,
}: {
  projectId: string;
  environment: string;
  integrationId: string | undefined;
  baseUrl: string;
  apiToken: string;
  targets: CoolifyTargetInput[];
  onChange: (next: CoolifyTargetInput[]) => void;
  inherited: boolean;
}) {
  // cm:edge contract -> packages/core/src/integrations/coolify-routes.ts — the credential-in-the-form branch is not a convenience: without it the picker cannot exist until after a save, and a first save is exactly where an operator would otherwise transcribe the uuid (ISS-925).
  const auth = integrationId
    ? { integrationId }
    : baseUrl.trim() && apiToken.trim().length >= 8
      ? { baseUrl: baseUrl.trim(), apiToken: apiToken.trim() }
      : null;
  const apps = useCoolifyApplications(projectId, auth);
  const identities = useCoolifyTargets(projectId, integrationId);

  const options = useMemo(
    () =>
      (apps.data?.applications ?? []).map((a: CoolifyApplication) => ({
        value: a.uuid,
        label: a.name ? `${a.name} — ${a.uuid.slice(0, 8)}` : a.uuid,
      })),
    [apps.data],
  );
  const identityFor = (uuid: string) =>
    (identities.data?.targets ?? []).find((t) => t.uuid === uuid);

  function updateTarget(idx: number, patch: Partial<CoolifyTargetInput>) {
    onChange(targets.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-subtle p-3">
      <legend className="fg-label px-1 text-subtle">
        Deploy targets · this project · {environment}
      </legend>
      <p className="fg-body-sm text-muted">
        The Coolify application(s) this project deploys for {environment}. Add
        one row per app — e.g. a separate backend and frontend; they deploy
        together and the pipeline only completes once all succeed.
        {inherited
          ? " Currently inherited from the shared connection — saving stores project-level targets."
          : ""}
      </p>
      {apps.isError && (
        <p className="fg-body-sm text-muted">
          Could not read the application list from Coolify — enter the resource
          UUID by hand, or fix the base URL and token above and try again.
        </p>
      )}
      {targets.map((t, idx) => {
        const identity = identityFor(t.resourceUuid);
        return (
          <div key={t.id ?? idx} className="flex flex-col gap-1">
            <div className="flex items-end gap-2">
              <div className="w-40 shrink-0">
                {idx === 0 && (
                  <span className="fg-label mb-1 block text-subtle">Label</span>
                )}
                <Input
                  value={t.label}
                  onChange={(e) => updateTarget(idx, { label: e.target.value })}
                  placeholder="Backend"
                />
              </div>
              <div className="flex-1">
                {idx === 0 && (
                  <span className="fg-label mb-1 block text-subtle">
                    Coolify application
                  </span>
                )}
                {options.length > 0 ? (
                  <NativeSelect
                    aria-label="Coolify application"
                    value={t.resourceUuid}
                    options={[
                      { value: "", label: "Select an application…" },
                      ...options,
                    ]}
                    onChange={(e) =>
                      updateTarget(idx, { resourceUuid: e.target.value })
                    }
                  />
                ) : (
                  <Input
                    value={t.resourceUuid}
                    onChange={(e) =>
                      updateTarget(idx, { resourceUuid: e.target.value })
                    }
                    placeholder="application uuid from Coolify"
                  />
                )}
              </div>
              <Button
                variant="ghost"
                icon="trash"
                aria-label="Remove target"
                disabled={targets.length <= 1}
                onClick={() =>
                  onChange(
                    targets.length <= 1
                      ? targets
                      : targets.filter((_, i) => i !== idx),
                  )
                }
              />
            </div>
            {identity && !identity.found && (
              <Badge tone="red">Coolify does not list this application</Badge>
            )}
            {identity?.found && (
              <span className="fg-body-sm text-muted">
                {identity.name ?? "unnamed"}
                {identity.fqdn ? ` · ${identity.fqdn}` : ""}
                {identity.gitBranch ? ` · ${identity.gitBranch}` : ""}
                {identity.gitCommitSha
                  ? `@${identity.gitCommitSha.slice(0, 7)}`
                  : ""}
              </span>
            )}
          </div>
        );
      })}
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => onChange([...targets, { label: "", resourceUuid: "" }])}
        >
          Add target
        </Button>
      </div>
    </fieldset>
  );
}
