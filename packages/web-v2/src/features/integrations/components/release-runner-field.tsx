"use client";

// ISS-1275 — the release runner label, on the two tiers the release warning names. It offered
// clearing the label as the free way out while the key was on no editable surface at all.
// Provider-agnostic the way `AgentAccessControl` is: every provider carries the key. `config` is
// the merged connection+binding view and `bindingConfig` this project's own, which is how the
// control says WHICH tier the label in force came from.

import { useState } from "react";
import { Button, PageSectionTitle, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useUpdateConnection, useUpdateProviderIntegration } from "../hooks";
import type { BindingSummary, ConnectionSummary, IntegrationSummary } from "../types";

/** The config key itself, so no screen spells it differently from the API. */
export const RELEASE_RUNNER_LABEL_KEY = "releaseRunnerLabel";

function declaredIn(config: Record<string, unknown> | undefined | null): string | null {
  const value = config?.[RELEASE_RUNNER_LABEL_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A label ranks the pool a RELEASE is offered to, and a release reads it off the deploy
 *  binding the project document's production environment names — which no binding knows of
 *  itself, so every deploy binding offers it and a service binding, which no environment
 *  names, does not. */
export function labelDecidesFor(binding: Pick<IntegrationSummary, "role">): boolean {
  return binding.role === "deploy";
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
  disabledReason: ProductCopyKey;
  hint: ProductCopyKey;
  /** What this tier's silence means, which differs between a project and a shared credential. */
  none: ProductCopyKey;
  busy: boolean;
  failure: string | null;
  onSave: (label: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(declared ?? "");
  const t = useCopy();
  const heading = t("integrations.releaseRunner.heading");

  return (
    <section className="flex flex-col gap-2">
      <PageSectionTitle>{heading}</PageSectionTitle>
      <p className="fg-body-sm text-muted">
        {declared ? (
          <>
            <span className="font-mono">{declared}</span> — {t("integrations.releaseRunner.declared")}
          </>
        ) : inherited ? (
          <>
            <span className="font-mono">{inherited}</span> — {t("integrations.releaseRunner.inherited")}
          </>
        ) : (
          t(none)
        )}
      </p>
      {canEdit ? (
        <Field label={heading} hint={t(hint)}>
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="release"
              aria-label={heading}
              disabled={busy}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || draft.trim().length === 0}
              onClick={() => onSave(draft.trim())}
            >
              {t("integrations.edit.save")}
            </Button>
            {declared && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
                {t("integrations.releaseRunner.clear")}
              </Button>
            )}
          </div>
        </Field>
      ) : (
        <p className="fg-body-sm text-subtle">{t(disabledReason)}</p>
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
  binding: Pick<IntegrationSummary, "id" | "role" | "config" | "bindingConfig">;
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
      disabledReason="integrations.access.deniedProject"
      hint="integrations.releaseRunner.bindingHint"
      none="integrations.releaseRunner.noneBinding"
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
      disabledReason="integrations.releaseRunner.deniedConnection"
      hint="integrations.releaseRunner.connectionHint"
      none="integrations.releaseRunner.noneConnection"
      busy={update.isPending}
      failure={failure}
      onSave={(label) => write(label)}
      onClear={() => write(null)}
    />
  );
}
