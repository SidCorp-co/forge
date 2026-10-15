"use client";

// Preview and Live as one block each — the branch it tracks, its addresses, and the deploy
// connections serving that stage — then the test access both sides share. Every field edits the
// environments draft the Shape & release page holds; a connection is named here and edited on
// Integrations, where its credential lives.

import Link from "next/link";
import { useState } from "react";
import {
  Button,
  Field,
  IconButton,
  Input,
  SectionTitle,
  type SettingsForm,
  SettingsSection,
  Textarea,
} from "@/design";
import { useIntegrationsList } from "@/features/integrations/hooks";
import { providerLabel } from "@/features/integrations/providers/registry";
import type { DeployStage, IntegrationSummary } from "@/features/integrations/types";
import {
  COMMIT_PATH_MAX,
  type CredRow,
  type EnvironmentsDraft,
  LABEL_MAX,
  LIMITS_MAX,
  MAX_ROWS,
  PASSWORD_MAX,
  URL_MAX,
  type UrlRow,
  USERNAME_MAX,
} from "../environments-form";

const FIELD_ERROR = { color: "var(--red-600)" } as const;

function connectionName(b: IntegrationSummary): string {
  const branch = typeof b.config?.branch === "string" && b.config.branch ? ` · ${b.config.branch}` : "";
  return `${providerLabel(b.provider)}${b.label ? ` (${b.label})` : ""}${branch}`;
}

function Connections({
  projectId,
  stage,
  slug,
  none,
}: {
  projectId: string;
  stage: DeployStage;
  slug?: string;
  /** What to say where nothing serves this stage. */
  none: string;
}) {
  const q = useIntegrationsList(projectId);
  const serving = (q.data?.items ?? []).filter(
    (b) => b.role === "deploy" && b.stages.includes(stage),
  );
  const href = slug ? `/projects/${slug}/settings?tab=integrations` : undefined;
  return (
    <div>
      <p className="fg-label text-fg">Deploy connections</p>
      {q.isLoading ? (
        <p className="fg-caption text-muted">Reading…</p>
      ) : q.isError ? (
        <p className="fg-caption text-muted">The connections could not be read just now.</p>
      ) : serving.length === 0 ? (
        <p className="fg-caption text-muted">{none}</p>
      ) : (
        <ul className="fg-body-sm text-fg">
          {serving.map((b) => (
            <li key={b.id}>
              {connectionName(b)}
              {!b.active && <span className="fg-caption ml-2 text-muted">switched off</span>}
            </li>
          ))}
        </ul>
      )}
      {href && (
        <Link href={href} className="fg-caption text-accent-text hover:underline">
          Manage deploy connections on Integrations
        </Link>
      )}
    </div>
  );
}

function Tracks({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p className="fg-label text-fg">Branch</p>
      <p className="fg-body-sm text-muted">{children}</p>
    </div>
  );
}

export function EnvironmentBlocks({
  projectId,
  slug,
  form: held,
  canEdit,
  liveBranch,
  shipsNothing,
}: {
  projectId: string;
  slug?: string;
  form: SettingsForm<EnvironmentsDraft>;
  canEdit: boolean;
  /** What Live tracks, in words: the chain's last branch, or why there is none. */
  liveBranch: string;
  /** True where the draft's shape declares no release, so no deploy connection is needed. */
  shipsNothing: boolean;
}) {
  const form = held.draft;
  const setForm = held.setDraft;
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  const setField = (key: keyof EnvironmentsDraft, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setUrlRow = (index: number, patch: Partial<UrlRow>) =>
    setForm((f) => ({
      ...f,
      previewUrls: f.previewUrls.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  const setCredRow = (index: number, patch: Partial<CredRow>) =>
    setForm((f) => ({
      ...f,
      testCredentials: f.testCredentials.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  function removeCredRow(index: number) {
    setForm((f) => ({ ...f, testCredentials: f.testCredentials.filter((_, i) => i !== index) }));
    setRevealed((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      });
      return next;
    });
  }
  function toggleReveal(index: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <>
      <SettingsSection id="environments">
        <SectionTitle className="fg-h3 mb-1">Environments</SectionTitle>
        <p className="fg-caption mb-5 text-muted">
          Where this project runs. Agents read these addresses before they test anything.
        </p>

        <div className="divide-y divide-line">
          <div id="environment-preview" className="space-y-4 pb-6">
            <h4 className="fg-h4 text-fg">Preview</h4>
            <p className="fg-caption text-muted">
              A separate deployment QA opens before a release. Leave it blank where there is none,
              which is normal for a one-box project — nothing reports it as missing.
            </p>
            <Tracks>Whatever its deploy connection builds; the project declares none for it.</Tracks>
            <Field label="Preview URL" hint="Frontend URL, e.g. https://staging.example.com" error={held.errorAt("previewUrl")}>
              <Input
                value={form.previewUrl}
                onChange={(e) => setField("previewUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://staging.example.com"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
            <Field label="Preview API URL" hint="Backend/API base URL." error={held.errorAt("previewApiUrl")}>
              <Input
                value={form.previewApiUrl}
                onChange={(e) => setField("previewApiUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://api.staging.example.com"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
            <div>
              <p className="fg-label text-fg">Testing URLs</p>
              <p className="fg-caption mb-2 text-muted">
                Named links QA opens while verifying this side — admin panels, mailbox, dashboards.
              </p>
              {form.previewUrls.length === 0 ? (
                <p className="fg-body-sm text-muted">No testing URLs.</p>
              ) : (
                <ul className="space-y-3">
                  {form.previewUrls.map((row, i) => {
                    const err = held.errorAt(`previewUrls.${i}`);
                    return (
                      // A row IS its position; the half-typed label is not.
                      // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                      <li key={i} className="flex items-start gap-2">
                        <div className="w-32 shrink-0 sm:w-40">
                          <Input
                            value={row.label}
                            onChange={(e) => setUrlRow(i, { label: e.target.value })}
                            disabled={!canEdit}
                            placeholder="Label"
                            maxLength={LABEL_MAX}
                            aria-label={`Testing URL ${i + 1} label`}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Input
                            value={row.url}
                            onChange={(e) => setUrlRow(i, { url: e.target.value })}
                            disabled={!canEdit}
                            placeholder="https://…"
                            maxLength={URL_MAX}
                            inputMode="url"
                            aria-label={`Testing URL ${i + 1} address`}
                            aria-invalid={err ? true : undefined}
                          />
                          {err && (
                            <p role="alert" className="fg-caption mt-1" style={FIELD_ERROR}>
                              {err}
                            </p>
                          )}
                        </div>
                        {canEdit && (
                          <IconButton
                            icon="trash"
                            aria-label={`Remove testing URL ${i + 1}`}
                            onClick={() =>
                              setForm((f) => ({ ...f, previewUrls: f.previewUrls.filter((_, j) => j !== i) }))
                            }
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {canEdit && (
                <Button
                  variant="secondary"
                  icon="plus"
                  className="mt-3 min-h-11"
                  disabled={form.previewUrls.length >= MAX_ROWS}
                  onClick={() =>
                    setForm((f) =>
                      f.previewUrls.length >= MAX_ROWS
                        ? f
                        : { ...f, previewUrls: [...f.previewUrls, { label: "", url: "" }] },
                    )
                  }
                >
                  Add URL
                </Button>
              )}
            </div>
            <Connections
              projectId={projectId}
              stage="preview"
              slug={slug}
              none="None serves Preview."
            />
          </div>

          <div id="environment-live" className="space-y-4 pt-6">
            <h4 className="fg-h4 text-fg">Live</h4>
            <p className="fg-caption text-muted">
              Where real users are. A release ships here; agents read this address as where the
              product runs, whether or not Forge releases to it.
            </p>
            <Tracks>{liveBranch}</Tracks>
            <Field label="Live URL" hint="The address a person opens, e.g. https://app.example.com" error={held.errorAt("liveUrl")}>
              <Input
                value={form.liveUrl}
                onChange={(e) => setField("liveUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://app.example.com"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
            <Field
              label="Live commit endpoint"
              hint="The endpoint that reports the running commit — often a different address from the one above, e.g. https://api.example.com/health"
              error={held.errorAt("liveCommitUrl")}
            >
              <Input
                value={form.liveCommitUrl}
                onChange={(e) => setField("liveCommitUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://api.example.com/health"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
            <Field
              label="Live commit path"
              hint="Dot path to the commit inside that endpoint's JSON body — e.g. commit, or data.commit. Leave it blank where the whole response body is the commit."
            >
              <Input
                value={form.liveCommitPath}
                onChange={(e) => setField("liveCommitPath", e.target.value)}
                disabled={!canEdit}
                placeholder="commit"
                maxLength={COMMIT_PATH_MAX}
              />
            </Field>
            <Connections
              projectId={projectId}
              stage="live"
              slug={slug}
              none={
                shipsNothing
                  ? "None needed: this project ships nothing, so no release lands here."
                  : "None serves Live, so a release has nowhere to land."
              }
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection id="test-access">
        <SectionTitle className="fg-h3 mb-1">Test access</SectionTitle>
        <p className="fg-caption mb-4 text-muted">
          The accounts QA logs in with on either side, and what neither side has. Agents read both
          before they plan a live test.
        </p>
        <p className="fg-label text-fg">Test credentials</p>
        <p className="fg-caption mb-2 text-muted">Passwords are masked by default.</p>
        {form.testCredentials.length === 0 ? (
          <p className="fg-body-sm text-muted">No test credentials.</p>
        ) : (
          <ul className="divide-y divide-line">
            {form.testCredentials.map((row, i) => {
              const at = (field: "label" | "username" | "password") =>
                held.errorAt(`testCredentials.${i}.${field}`);
              const errLabel = at("label");
              const errUser = at("username");
              const errPass = at("password");
              const err = errLabel ?? errUser ?? errPass;
              const errId = `credential-${i}-error`;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
                <li key={i} className="py-3">
                  <div className="flex items-start gap-2">
                    <div className="grid flex-1 gap-2 sm:grid-cols-3">
                      <Input
                        value={row.label}
                        onChange={(e) => setCredRow(i, { label: e.target.value })}
                        disabled={!canEdit}
                        placeholder="Label (e.g. Admin)"
                        maxLength={LABEL_MAX}
                        aria-label={`Credential ${i + 1} label`}
                        aria-invalid={errLabel ? true : undefined}
                        aria-describedby={errLabel ? errId : undefined}
                      />
                      <Input
                        value={row.username}
                        onChange={(e) => setCredRow(i, { username: e.target.value })}
                        disabled={!canEdit}
                        placeholder="Username"
                        maxLength={USERNAME_MAX}
                        autoComplete="off"
                        aria-label={`Credential ${i + 1} username`}
                        aria-invalid={errUser ? true : undefined}
                        aria-describedby={errUser ? errId : undefined}
                      />
                      <div className="flex items-center gap-2">
                        <Input
                          value={row.password}
                          onChange={(e) => setCredRow(i, { password: e.target.value })}
                          disabled={!canEdit}
                          placeholder="Password"
                          type={revealed.has(i) ? "text" : "password"}
                          maxLength={PASSWORD_MAX}
                          autoComplete="off"
                          aria-label={`Credential ${i + 1} password`}
                          aria-invalid={errPass ? true : undefined}
                          aria-describedby={errPass ? errId : undefined}
                          className="flex-1"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleReveal(i)}
                          aria-label={revealed.has(i) ? "Hide password" : "Show password"}
                          className="shrink-0"
                        >
                          {revealed.has(i) ? "Hide" : "Show"}
                        </Button>
                      </div>
                    </div>
                    {canEdit && (
                      <IconButton
                        icon="trash"
                        aria-label={`Remove credential ${i + 1}`}
                        onClick={() => removeCredRow(i)}
                      />
                    )}
                  </div>
                  {err && (
                    <p id={errId} role="alert" className="fg-caption mt-2" style={FIELD_ERROR}>
                      {err}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <Button
            variant="secondary"
            icon="plus"
            className="mt-3 min-h-11"
            disabled={form.testCredentials.length >= MAX_ROWS}
            onClick={() =>
              setForm((f) =>
                f.testCredentials.length >= MAX_ROWS
                  ? f
                  : {
                      ...f,
                      testCredentials: [...f.testCredentials, { label: "", username: "", password: "" }],
                    },
              )
            }
          >
            Add credential
          </Button>
        )}

        <div className="mt-6">
          <Field
            label="Limits"
            hint="What a test account cannot reach, states this environment never contains, anything that must not be faked. Everyone on the project can read it — never put a password here."
          >
            <Textarea
              value={form.limits}
              onChange={(e) => setField("limits", e.target.value)}
              disabled={!canEdit}
              rows={5}
              maxLength={LIMITS_MAX}
              aria-label="Environment limits"
              placeholder={
                "e.g.\n- The QA account is not a member of every project — check before promising a live walk.\n- Runner health must not be faked; it would break live work."
              }
            />
          </Field>
          <p className="fg-caption mt-2 text-muted">
            {form.limits.length.toLocaleString()} / {LIMITS_MAX.toLocaleString()}
          </p>
        </div>
      </SettingsSection>
    </>
  );
}
