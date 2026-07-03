"use client";

// ISS-609 — Rocket.Chat bot integration config (project settings →
// Integrations → Rocket.Chat card). One binding per project: the org-shared
// bot credential (server URL + bot PAT + bot user id) lives on the connection;
// the room this project's channel maps to (`rid`) is binding-tier. Saving any
// of it hot-reloads the live bot socket server-side — no core restart.

import {
  Badge,
  type BadgeProps,
  Banner,
  Button,
  Field,
  Input,
  Textarea,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useUpdateProject } from "@/features/project-settings/hooks";
import { useProject } from "@/features/projects/hooks";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useOrgConnectionLocked,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../hooks";
import type {
  IntegrationSummary,
  IntegrationTestResult,
  ProviderConfig,
} from "../types";
import { ConnectionOwnerField } from "./connection-owner-field";

interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

function badgeFor(existing: IntegrationSummary | undefined): BadgeView {
  if (!existing) return { label: "Not configured", tone: "amber" };
  if (!existing.active) return { label: "Disabled", tone: "neutral" };
  if (existing.lastHealthStatus === "ok") return { label: "Connected", tone: "green" };
  if (existing.lastHealthStatus === "needs_reauth")
    return { label: "Bot credential rejected", tone: "red" };
  if (existing.lastHealthStatus === "error") return { label: "Error", tone: "red" };
  return { label: "Untested", tone: "neutral" };
}

export function RocketchatSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const binding = useMemo(
    () => (list.data?.items ?? []).find((i) => i.provider === "rocketchat"),
    [list.data],
  );

  if (list.isLoading) return <p className="fg-body-sm text-muted">Loading…</p>;
  if (!binding) return <AddRocketchatForm projectId={projectId} />;
  return (
    <div className="flex flex-col gap-4">
      <RocketchatBindingPanel projectId={projectId} binding={binding} />
      <BotPersonalityPanel projectId={projectId} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Bot personality (agentConfig.personaStyle — additive style knob)
// ─────────────────────────────────────────────────────────────

// The example is deliberately in the operator's own language — the knob exists
// precisely to style the bot in whatever language the channel speaks.
const STYLE_PLACEHOLDER = `e.g. "Xưng 'em', gọi user là 'anh'. Tone thân thiện. Khi phân tích alert luôn kết bằng đề xuất hành động."`; // i18n-allow: demonstrates styling in the user's language

function BotPersonalityPanel({ projectId }: { projectId: string }) {
  const projectQ = useProject(projectId);
  const update = useUpdateProject(projectId);

  const saved =
    ((projectQ.data?.agentConfig as Record<string, unknown> | null)?.personaStyle as
      | string
      | undefined) ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <span className="fg-label font-semibold">Bot personality</span>
      <p className="fg-body-sm text-muted">
        Per-project reply style for the chat bot — tone, address form, language,
        formatting habits. Layered on top of the built-in rules (draft-first issue
        capture, tool use), so it can&apos;t break them. Leave empty for the default
        style.
      </p>
      <Textarea
        rows={4}
        placeholder={STYLE_PLACEHOLDER}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        disabled={projectQ.isLoading}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={update.isPending}
          disabled={draft === null || draft === saved}
          onClick={() =>
            update.mutate(
              { personaStyle: value.trim() ? value.trim() : null },
              { onSuccess: () => setDraft(null) },
            )
          }
        >
          Save personality
        </Button>
        {saved && (
          <Button
            variant="ghost"
            size="sm"
            loading={update.isPending}
            onClick={() =>
              update.mutate({ personaStyle: null }, { onSuccess: () => setDraft(null) })
            }
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Existing binding: rid editor + credential rotate + test/toggle/delete
// ─────────────────────────────────────────────────────────────

function RocketchatBindingPanel({
  projectId,
  binding,
}: {
  projectId: string;
  binding: IntegrationSummary;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const list = useIntegrationsList(projectId);
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);

  const cfg = binding.config as ProviderConfig;
  const [rid, setRid] = useState(cfg.rid ?? "");
  const [authToken, setAuthToken] = useState("");
  const [botUserId, setBotUserId] = useState("");
  const [showRotate, setShowRotate] = useState(false);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badge = badgeFor(binding);

  async function saveRid() {
    setError(null);
    try {
      await update.mutateAsync({ id: binding.id, body: { config: { rid: rid.trim() } } });
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function saveCredential() {
    setError(null);
    const secrets: Record<string, string> = {};
    if (authToken.trim()) secrets.authToken = authToken.trim();
    if (botUserId.trim()) secrets.userId = botUserId.trim();
    if (Object.keys(secrets).length === 0) return;
    try {
      await update.mutateAsync({ id: binding.id, body: { secrets } });
      setAuthToken("");
      setBotUserId("");
      setShowRotate(false);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function handleTest() {
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await test.mutateAsync(binding.id));
      list.refetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  function handleDelete() {
    if (!window.confirm("Disconnect the Rocket.Chat bot from this project?")) return;
    remove.mutate(binding.id);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="fg-body-sm font-semibold">
          {cfg.serverUrl ?? "Rocket.Chat"}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <p className="fg-body-sm text-muted">
        The bot answers @-mentions in the bound room, reads the discussion, and can
        capture it as a <span className="font-mono">draft</span> Forge issue. A human
        moves drafts to <span className="font-mono">open</span> to start the pipeline.
      </p>

      {error && <Banner tone="danger">{error}</Banner>}
      {testResult &&
        (testResult.status === "ok" ? (
          <Banner tone="success">{testResult.message ?? "Bot credential OK"}</Banner>
        ) : (
          <Banner tone="danger">{testResult.message ?? "Connection failed"}</Banner>
        ))}

      <Field
        label="Room ID"
        hint="The Rocket.Chat room (rid) this project listens on — admin → Rooms, or the room's admin info panel."
      >
        <div className="flex items-center gap-2">
          <Input
            placeholder="GENERAL"
            value={rid}
            onChange={(e) => setRid(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            disabled={!rid.trim() || rid.trim() === (cfg.rid ?? "")}
            onClick={saveRid}
          >
            Save room
          </Button>
        </div>
      </Field>

      {showRotate && !orgLocked && (
        <>
          <Field
            label="New bot auth token"
            hint="Personal-access token of the bot user. Leave blank to keep the current one."
          >
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="bot PAT…"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
            />
          </Field>
          <Field label="Bot user ID" hint="Only needed if the bot account changed.">
            <Input
              placeholder="bot user id…"
              value={botUserId}
              onChange={(e) => setBotUserId(e.target.value)}
            />
          </Field>
        </>
      )}

      {orgLocked && (
        <p className="fg-body-sm text-muted">
          Org-shared credential — only an org owner/admin can change it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!orgLocked &&
          (showRotate ? (
            <>
              <Button
                variant="primary"
                onClick={saveCredential}
                loading={update.isPending}
                disabled={!authToken.trim() && !botUserId.trim()}
              >
                Save credential
              </Button>
              <Button variant="secondary" onClick={() => setShowRotate(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setShowRotate(true)}>
              Rotate credential
            </Button>
          ))}
        <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
          Test
        </Button>
        <label className="flex items-center gap-2">
          <span className="fg-body-sm text-muted">Enabled</span>
          <Toggle
            checked={binding.active}
            onChange={(active) => update.mutate({ id: binding.id, body: { active } })}
            disabled={orgLocked}
          />
        </label>
        <Button
          variant="danger"
          icon="trash"
          loading={remove.isPending}
          onClick={handleDelete}
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// First-time connect form
// ─────────────────────────────────────────────────────────────

function AddRocketchatForm({ projectId }: { projectId: string }) {
  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const [serverUrl, setServerUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [botUserId, setBotUserId] = useState("");
  const [rid, setRid] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    /^https?:\/\/.+/.test(serverUrl.trim()) &&
    authToken.trim().length >= 8 &&
    botUserId.trim().length > 0 &&
    rid.trim().length > 0 &&
    !create.isPending;

  async function handleCreate() {
    setError(null);
    try {
      await create.mutateAsync({
        provider: "rocketchat",
        config: { serverUrl: serverUrl.trim().replace(/\/+$/, ""), rid: rid.trim() },
        secrets: { authToken: authToken.trim(), userId: botUserId.trim() },
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-subtle p-4">
      <span className="fg-label font-semibold">Connect Rocket.Chat bot</span>
      <p className="fg-body-sm text-muted">
        Create a bot user on your Rocket.Chat server, add it to the project&apos;s
        channel, and paste its personal-access token below. The bot replies to
        @-mentions in the bound room.
      </p>

      <ConnectionOwnerField
        projectId={projectId}
        value={ownerOrgId}
        onChange={setOwnerOrgId}
      />

      <Field label="Server URL" hint="e.g. https://chat.example.com" required>
        <Input
          placeholder="https://chat.example.com"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
      </Field>

      <Field
        label="Bot auth token"
        hint="Personal-access token of the bot user (My Account → Personal Access Tokens). Stored encrypted; never shown again."
        required
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="bot PAT…"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
        />
      </Field>

      <Field
        label="Bot user ID"
        hint="Shown next to the token when it is created (X-User-Id)."
        required
      >
        <Input
          placeholder="e.g. hZDkzcnDqnvHDbtLo"
          value={botUserId}
          onChange={(e) => setBotUserId(e.target.value)}
        />
      </Field>

      <Field
        label="Room ID"
        hint="The room (rid) this project listens on — admin → Rooms, or the room's admin info panel."
        required
      >
        <Input placeholder="GENERAL" value={rid} onChange={(e) => setRid(e.target.value)} />
      </Field>

      {error && <Banner tone="danger">{error}</Banner>}

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={handleCreate}
          loading={create.isPending}
          disabled={!canSubmit}
        >
          Connect bot
        </Button>
      </div>
    </div>
  );
}
