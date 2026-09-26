"use client";

// ISS-1275 — the release runner label, on the two tiers the release warning names. It offered
// clearing the label as the free way out while the key was on no editable surface at all.
// Provider-agnostic the way `AgentAccessControl` is: every provider carries the key. `config` is
// the merged connection+binding view and `bindingConfig` this project's own, which is how the
// control says WHICH tier the label in force came from.

import { useState } from "react";
import { Button, CardTitle, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useUpdateConnection, useUpdateProviderIntegration } from "../hooks";
import type { BindingSummary, ConnectionSummary, IntegrationSummary } from "../types";

/** The config key itself, so no screen spells it differently from the API. */
export const RELEASE_RUNNER_LABEL_KEY = "releaseRunnerLabel";

export const RELEASE_RUNNER_HEADING = "Release runner label";

/** The same words the Release card uses for the same state (ISS-1275). */
export const NO_RELEASE_RUNNER_LABEL =
  "none — a release goes to any box in this project's pool";

export const NO_CONNECTION_RUNNER_LABEL =
  "none — each project bound to this credential uses its own binding, or its own pool";

const WHERE_THE_CONNECTION_IS_EDITED = "Integrations in the workspace rail";

function declaredIn(config: Record<string, unknown> | undefined | null): string | null {
  const value = config?.[RELEASE_RUNNER_LABEL_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A label ranks the pool a RELEASE is offered to, so only a live deploy binding
 *  has one to declare. Rendering it elsewhere would offer a setting that decides
 *  nothing. */
export function labelDecidesFor(
  binding: Pick<IntegrationSummary, "role" | "stages">,
): boolean {
  return binding.role === "deploy" && binding.stages.includes("live");
}

function Editor({
  declared,
  inherited,
  canEdit,
  disabledReason,
  hint,
  none,
  busy,
  failure,
  onSave,
  onClear,
}: {
  /** The label this tier declares, or null where it declares none. */
  declared: string | null;
  /** The label in force from the tier underneath, shown only where this one is silent. */
  inherited?: string | null;
  canEdit: boolean;
  disabledReason: string;
  hint: string;
  /** What this tier's silence means, which differs between a project and a shared credential. */
  none: string;
  busy: boolean;
  failure: string | null;
  onSave: (label: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(declared ?? "");

  return (
    <section className="flex flex-col gap-2">
      <CardTitle>{RELEASE_RUNNER_HEADING}</CardTitle>
      <p className="fg-body-sm text-muted">
        {declared ? (
          <>
            <span className="font-mono">{declared}</span> — a release prefers a box carrying
            it, and still runs on the pool it has where no box does.
          </>
        ) : inherited ? (
          <>
            <span className="font-mono">{inherited}</span> — inherited from the shared
            connection behind this binding, which is where it is declared. Clearing it here
            removes nothing: change that one under {WHERE_THE_CONNECTION_IS_EDITED}.
          </>
        ) : (
          none
        )}
      </p>
      {canEdit ? (
        <Field label={RELEASE_RUNNER_HEADING} hint={hint}>
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="release"
              aria-label={RELEASE_RUNNER_HEADING}
              disabled={busy}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || draft.trim().length === 0}
              onClick={() => onSave(draft.trim())}
            >
              Save
            </Button>
            {declared && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
                Clear
              </Button>
            )}
          </div>
        </Field>
      ) : (
        <p className="fg-body-sm text-subtle">{disabledReason}</p>
      )}
      {failure && <p className="fg-body-sm text-[var(--red-600)]">{failure}</p>}
    </section>
  );
}

/**
 * The binding tier, in the project's own Integrations drawer. This is the tier a
 * label is declared on in practice: `splitProviderConfig` routes the key here
 * for every provider, and `withdrawNulls` on the binding PATCH means a null
 * REMOVES it rather than storing one.
 */
export function BindingReleaseRunnerField({
  projectId,
  binding,
  canEdit,
}: {
  projectId: string;
  binding: Pick<IntegrationSummary, "id" | "role" | "stages" | "config" | "bindingConfig">;
  canEdit: boolean;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const [failure, setFailure] = useState<string | null>(null);

  if (!labelDecidesFor(binding)) return null;

  const declared = declaredIn(binding.bindingConfig);
  const effective = declaredIn(binding.config);

  const write = (value: string | null) => {
    setFailure(null);
    update.mutate(
      { id: binding.id, body: { config: { [RELEASE_RUNNER_LABEL_KEY]: value } } },
      { onError: (err) => setFailure(formatApiError(err)) },
    );
  };

  return (
    <Editor
      // Re-seeds the input when a save lands or the read arrives after the mount.
      key={declared ?? ""}
      declared={declared}
      inherited={declared === null ? effective : null}
      canEdit={canEdit}
      disabledReason="Only a project admin can change this."
      hint="Which box this project's releases should prefer, matched against a runner's labels under Settings → Runners. Clearing it falls back to the shared connection's label where that declares one, and otherwise to any box in this project's pool."
      none={NO_RELEASE_RUNNER_LABEL}
      busy={update.isPending}
      failure={failure}
      onSave={(label) => write(label)}
      onClear={() => write(null)}
    />
  );
}

/**
 * The connection tier, in the workspace connection drawer, because that is where
 * connection-scoped management lives and the server refuses it to anyone but the
 * credential's owner or an org admin. A clearing here sends null and the route
 * removes the key, as the binding PATCH does.
 */
export function ConnectionReleaseRunnerField({
  connection,
  bindings,
  canManage,
}: {
  connection: Pick<ConnectionSummary, "id" | "config">;
  bindings: BindingSummary[];
  canManage: boolean;
}) {
  const update = useUpdateConnection();
  const [failure, setFailure] = useState<string | null>(null);

  if (!bindings.some(labelDecidesFor)) return null;

  const declared = declaredIn(connection.config);

  const write = (value: string | null) => {
    setFailure(null);
    update.mutate(
      { id: connection.id, body: { config: { [RELEASE_RUNNER_LABEL_KEY]: value } } },
      { onError: (err) => setFailure(formatApiError(err)) },
    );
  };

  return (
    <Editor
      key={declared ?? ""}
      declared={declared}
      canEdit={canManage}
      disabledReason="Only the credential's owner, or an org owner or admin, can change this."
      hint="The release runner every project bound to this credential prefers. A project's own live deploy binding overrides it."
      none={NO_CONNECTION_RUNNER_LABEL}
      busy={update.isPending}
      failure={failure}
      onSave={(label) => write(label)}
      onClear={() => write(null)}
    />
  );
}
