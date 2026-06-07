"use client";

// Project settings → Agent. Ports the two LIVE v1 agent settings sections
// (`packages/web/.../settings/components/chat-agent-section.tsx` +
// `providers-tools-section.tsx`) into web-v2. Backed by the existing
// `GET/PUT /api/app-config/:projectId` via `features/app-config`. Mirrors the
// testing-tab load → form → dirty → save pattern. Owner/admin can edit (server
// PUT is owner|admin-gated); everyone else sees read-only inputs.
import { useEffect, useMemo, useState } from "react";
import { Button, Card, CardContent, ErrorState, Field, Input, Skeleton, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useAppConfig, useUpsertAppConfig } from "@/features/app-config/hooks";
import type { AppConfig, AppConfigPatch } from "@/features/app-config/types";

// Backend caps are lenient (text columns); keep generous client maxLengths.
const PROVIDER_MAX = 200;
const MODEL_MAX = 200;
const PROMPT_MAX = 20000;

interface Form {
  systemPromptOverride: string;
  chatProviderId: string;
  chatModel: string;
}

/** Seed editable form state from the loaded row (null row → all empty). */
function parse(cfg: AppConfig | null | undefined): Form {
  return {
    systemPromptOverride: cfg?.systemPromptOverride ?? "",
    chatProviderId: cfg?.chatProviderId ?? "",
    chatModel: cfg?.chatModel ?? "",
  };
}

/** Trimmed string, or null when empty — matches v1 `nullableString` so an empty
 *  field clears the stored value. */
function nullable(v: string): string | null {
  const t = v.trim();
  return t.length === 0 ? null : t;
}

export function AgentTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const cfgQ = useAppConfig(projectId);
  const upsert = useUpsertAppConfig(projectId);

  const initial = useMemo<Form>(() => parse(cfgQ.data), [cfgQ.data]);
  const [form, setForm] = useState<Form>(initial);

  // Re-hydrate when the query resolves / refetches (e.g. after a save).
  useEffect(() => {
    setForm(initial);
  }, [initial]);

  const dirty =
    form.systemPromptOverride !== initial.systemPromptOverride ||
    form.chatProviderId !== initial.chatProviderId ||
    form.chatModel !== initial.chatModel;

  function setField<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function save() {
    if (!dirty || !canEdit) return;
    // Send only changed fields; empty → null (clears the stored override).
    const patch: AppConfigPatch = {};
    if (form.systemPromptOverride !== initial.systemPromptOverride)
      patch.systemPromptOverride = nullable(form.systemPromptOverride);
    if (form.chatProviderId !== initial.chatProviderId)
      patch.chatProviderId = nullable(form.chatProviderId);
    if (form.chatModel !== initial.chatModel) patch.chatModel = nullable(form.chatModel);
    upsert.mutate(patch);
  }

  if (cfgQ.isLoading) {
    return (
      <Card>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-32 w-full rounded-md" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (cfgQ.isError) {
    return (
      <Card>
        <CardContent>
          <ErrorState message={formatApiError(cfgQ.error)} onRetry={() => cfgQ.refetch()} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Chat Agent</h2>
          <p className="fg-caption mb-4 text-muted">
            Project-specific instructions appended to the default agent prompt. Leave empty to use
            the platform default.
          </p>
          <Field label="Custom system prompt" hint="Stored on app_config.systemPromptOverride. Empty clears the override.">
            <Textarea
              value={form.systemPromptOverride}
              onChange={(e) => setField("systemPromptOverride", e.target.value)}
              disabled={!canEdit}
              rows={10}
              maxLength={PROMPT_MAX}
              placeholder="Project-specific instructions for the chat agent…"
              className="font-mono text-xs"
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-1">Chat Provider</h2>
          <p className="fg-caption mb-4 text-muted">
            Provider and model used for project chat. Empty values fall back to the platform
            default.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider ID" hint="Provider key registered in the core chat registry.">
              <Input
                value={form.chatProviderId}
                onChange={(e) => setField("chatProviderId", e.target.value)}
                disabled={!canEdit}
                placeholder="anthropic"
                maxLength={PROVIDER_MAX}
                className="font-mono"
              />
            </Field>
            <Field label="Model ID" hint="Model identifier for the selected provider.">
              <Input
                value={form.chatModel}
                onChange={(e) => setField("chatModel", e.target.value)}
                disabled={!canEdit}
                placeholder="claude-opus-4-7"
                maxLength={MODEL_MAX}
                className="font-mono"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      {canEdit && (
        <div>
          <Button
            variant="primary"
            loading={upsert.isPending}
            disabled={!dirty}
            onClick={save}
            className="min-h-11"
          >
            Save agent settings
          </Button>
        </div>
      )}
    </div>
  );
}
