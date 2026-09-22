"use client";

// Project settings → Testing. View/edit the project's `environments` blob: BOTH sides of the
// deployment — the live address a release ships to and the preview one QA opens — plus the test
// credentials and the limits of either. Persisted via PATCH /api/projects/:id (owner-gated
// server-side, validated by `environmentsPatchSchema`). Mirrors the basics-tab dirty/save pattern
// and the labels-tab add/remove-row UI. Passwords are masked by default with a per-row reveal
// toggle; values are never logged.
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  Field,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  SectionTitle,
  Textarea,
} from "@/design";
import type { ProjectDetail } from "@/features/projects/types";
import { useUpdateProject } from "../hooks";
import type { EnvironmentsConfig, TestCredential, TestingUrl } from "../types";

// Backend caps (see `testingUrlSchema` / `testCredentialSchema` in core).
const MAX_ROWS = 50;
const LABEL_MAX = 80;
const URL_MAX = 500;
const USERNAME_MAX = 200;
const PASSWORD_MAX = 500;
const LIMITS_MAX = 8000;
const COMMIT_PATH_MAX = 200;

type UrlRow = TestingUrl & Record<string, unknown>;
type CredRow = TestCredential & Record<string, unknown>;

type PreviewShape = "deployed" | "local";

interface Form {
  previewShape: PreviewShape;
  liveUrl: string;
  liveCommitUrl: string;
  liveCommitPath: string;
  previewUrl: string;
  previewApiUrl: string;
  previewUrls: UrlRow[];
  testCredentials: CredRow[];
  limits: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
}

function urlRows(value: unknown): UrlRow[] {
  return objects(value).map((u) => ({
    ...u,
    label: String(u.label ?? ""),
    url: String(u.url ?? ""),
  }));
}

function credRows(value: unknown): CredRow[] {
  return objects(value).map((c) => ({
    ...c,
    label: String(c.label ?? ""),
    username: String(c.username ?? ""),
    password: String(c.password ?? ""),
  }));
}

/** Read the stored jsonb blob into editable form state (defensive — jsonb is
 *  typed `unknown`, so coerce every field and tolerate partial/legacy shapes). */
function parse(raw: unknown, previewShape: PreviewShape): Form {
  const env = (raw ?? {}) as EnvironmentsConfig;
  const live = (env.live ?? {}) as Record<string, unknown>;
  const preview = (env.preview ?? {}) as Record<string, unknown>;
  return {
    previewShape,
    liveUrl: text(live.url),
    liveCommitUrl: text(live.commitUrl),
    liveCommitPath: text(live.commitPath),
    previewUrl: text(preview.url),
    previewApiUrl: text(preview.apiUrl),
    previewUrls: urlRows(preview.urls),
    testCredentials: credRows(env.testCredentials),
    limits: text(env.limits),
  };
}

/** The stored preview side as an object, or `null` where the project declares none. */
function storedPreviewOf(raw: unknown): Record<string, unknown> | null {
  const preview = ((raw ?? {}) as EnvironmentsConfig).preview;
  return typeof preview === "object" && preview !== null && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : null;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function trimmedOrNull(value: string): string | null {
  return value.trim() === "" ? null : value.trim();
}

function keptUrlRows(rows: UrlRow[]): UrlRow[] {
  return rows
    .filter((u) => u.label.trim() !== "" && u.url.trim() !== "")
    .map((u) => ({ ...u, label: u.label.trim(), url: u.url.trim() }));
}

function keptCredentials(rows: CredRow[]): CredRow[] {
  return rows
    .filter((c) => c.label.trim() !== "")
    .map((c) => ({ ...c, label: c.label.trim(), username: c.username.trim(), password: c.password }));
}

/**
 * Whether a preview side is stored at all — ISS-1189, and it is the DECLARATION that decides.
 *
 * It used to be derived here, from whether any preview field happened to be filled in, which is
 * exactly the inference this screen now replaces: a project's shape was whatever its blob looked
 * like, and nobody could be told they had got it wrong. `local` sends `preview: null`, which is
 * this project saying it has no preview side rather than having forgotten to fill one in.
 */
function previewDeclared(form: Form): boolean {
  return form.previewShape === "deployed";
}

/** Canonical JSON of the known fields, used for dirty detection. Empty URL fields normalize to
 *  null; blank/partial rows are dropped — matching what the save path actually sends, so a
 *  freshly-loaded form reads as not-dirty. */
function canonical(form: Form): string {
  return JSON.stringify({
    previewShape: form.previewShape,
    live: {
      url: trimmedOrNull(form.liveUrl),
      commitUrl: trimmedOrNull(form.liveCommitUrl),
      commitPath: trimmedOrNull(form.liveCommitPath),
    },
    preview: previewDeclared(form)
      ? {
          url: trimmedOrNull(form.previewUrl),
          apiUrl: trimmedOrNull(form.previewApiUrl),
          urls: keptUrlRows(form.previewUrls),
        }
      : null,
    testCredentials: keptCredentials(form.testCredentials),
    limits: trimmedOrNull(form.limits),
  });
}

export function TestingTab({ project, canEdit }: { project: ProjectDetail; canEdit: boolean }) {
  const update = useUpdateProject(project.id);

  const [form, setForm] = useState<Form>(() =>
    parse(project.environments, project.previewShape as PreviewShape),
  );
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  // Re-hydrate when the project refetches (e.g. after a save invalidates it).
  useEffect(() => {
    setForm(parse(project.environments, project.previewShape as PreviewShape));
    setRevealed(new Set());
  }, [project.environments, project.previewShape]);

  const storedPreview = useMemo(
    () => storedPreviewOf(project.environments),
    [project.environments],
  );
  const original = useMemo(
    () => canonical(parse(project.environments, project.previewShape as PreviewShape)),
    [project.environments, project.previewShape],
  );
  const dirty = canonical(form) !== original;

  // Validation — block save on malformed URLs or partially-filled rows.
  function urlError(value: string): string | undefined {
    return value.trim() !== "" && !isValidUrl(value.trim())
      ? "Enter a valid URL (including http(s)://)."
      : undefined;
  }
  const liveUrlError = urlError(form.liveUrl);
  const liveCommitUrlError = urlError(form.liveCommitUrl);
  const previewUrlError = urlError(form.previewUrl);
  const previewApiUrlError = urlError(form.previewApiUrl);

  function testingUrlError(row: UrlRow): string | undefined {
    const label = row.label.trim();
    const url = row.url.trim();
    if (label === "" && url === "") return undefined; // empty row — dropped on save
    if (label === "") return "Label is required.";
    if (url === "") return "URL is required.";
    if (!isValidUrl(url)) return "Enter a valid URL (including http(s)://).";
    return undefined;
  }

  function credentialError(row: CredRow): string | undefined {
    if (row.label.trim() === "" && (row.username !== "" || row.password !== "")) {
      return "Label is required.";
    }
    return undefined;
  }

  // The server refuses `deployed` with no preview host by name; saying so here means the operator
  // reads it beside the empty field rather than as a 400 after the save.
  const previewShapeError =
    form.previewShape === "deployed" &&
    form.previewUrl.trim() === "" &&
    form.previewApiUrl.trim() === "" &&
    keptUrlRows(form.previewUrls).length === 0
      ? "A deployed preview needs an address. Give it a URL, or declare the preview local."
      : undefined;

  const hasErrors =
    !!previewShapeError ||
    !!liveUrlError ||
    !!liveCommitUrlError ||
    !!previewUrlError ||
    !!previewApiUrlError ||
    form.previewUrls.some((r) => !!testingUrlError(r)) ||
    form.testCredentials.some((r) => !!credentialError(r));

  function setField(key: keyof Form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setUrlRow(index: number, patch: Partial<UrlRow>) {
    setForm((f) => ({
      ...f,
      previewUrls: f.previewUrls.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }
  function addUrlRow() {
    setForm((f) =>
      f.previewUrls.length >= MAX_ROWS
        ? f
        : { ...f, previewUrls: [...f.previewUrls, { label: "", url: "" }] },
    );
  }
  function removeUrlRow(index: number) {
    setForm((f) => ({ ...f, previewUrls: f.previewUrls.filter((_, i) => i !== index) }));
  }

  function setCredRow(index: number, patch: Partial<CredRow>) {
    setForm((f) => ({
      ...f,
      testCredentials: f.testCredentials.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }
  function addCredRow() {
    setForm((f) =>
      f.testCredentials.length >= MAX_ROWS
        ? f
        : {
            ...f,
            testCredentials: [...f.testCredentials, { label: "", username: "", password: "" }],
          },
    );
  }
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

  function save() {
    if (!dirty || hasErrors) return;
    const stored = (project.environments ?? {}) as Record<string, unknown>;
    const storedLive = (stored.live ?? {}) as Record<string, unknown>;
    const environments: EnvironmentsConfig = {
      ...stored,
      live: {
        ...storedLive,
        url: trimmedOrNull(form.liveUrl),
        commitUrl: trimmedOrNull(form.liveCommitUrl),
        commitPath: trimmedOrNull(form.liveCommitPath),
      },
      preview: previewDeclared(form)
        ? {
            ...(storedPreview ?? {}),
            url: trimmedOrNull(form.previewUrl),
            apiUrl: trimmedOrNull(form.previewApiUrl),
            urls: keptUrlRows(form.previewUrls),
          }
        : null,
      testCredentials: keptCredentials(form.testCredentials),
      limits: trimmedOrNull(form.limits),
    };
    // Both halves in one PATCH: the server judges the configuration the write leaves behind, so a
    // shape sent without the blob it agrees with would be refused on the way past.
    update.mutate({ previewShape: form.previewShape, environments });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent>
          <SectionTitle className="fg-h3 mb-1">What this environment does not have</SectionTitle>
          <p className="fg-caption mb-4 text-muted">
            The settings below say what exists. This one says what does <i>not</i>. Agents read it
            before planning a live test, so a limit written here is caught while work is still being
            scoped instead of after the code is finished. Everyone on the project can read it
            &mdash; never put a password here, use Test credentials below.
          </p>
          <Field
            label="Limits"
            hint="What a test account cannot reach, states this environment never contains, anything that must not be faked."
          >
            <Textarea
              value={form.limits}
              onChange={(e) => setField("limits", e.target.value)}
              disabled={!canEdit}
              rows={8}
              maxLength={LIMITS_MAX}
              aria-label="Environment limits"
              placeholder={
                "e.g.\n- The QA account is not a member of every project — check before promising a live walk.\n- No issue ever rests at the release gate here, so anything triggered by that state cannot be exercised.\n- Runner health must not be faked; it would break live work."
              }
            />
          </Field>
          <p className="fg-caption mt-2 text-muted">
            {form.limits.length.toLocaleString()} / {LIMITS_MAX.toLocaleString()}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <SectionTitle className="fg-h3 mb-1">Live</SectionTitle>
          <p className="fg-caption mb-4 text-muted">
            Where a release of this project actually ships. Without the commit endpoint below, every
            live deploy binding has to declare its own verification probe, and a release is refused
            until one does.
          </p>
          <div className="space-y-4">
            <Field
              label="Live URL"
              hint="The address a person opens, e.g. https://app.example.com"
              error={liveUrlError}
            >
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
              error={liveCommitUrlError}
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <SectionTitle className="fg-h3 mb-1">Preview</SectionTitle>
          <p className="fg-caption mb-4 text-muted">
            Where work on this project is exercised before it reaches live. This is a choice, not
            something read off the fields below: whoever configures the project says which shape it
            is, and every reader &mdash; the pipeline, the release sweep, a session deciding where
            to test a change &mdash; reads that answer instead of guessing one.
          </p>
          <Field label="Preview" error={previewShapeError}>
            <RadioGroup
              name="preview-shape"
              value={form.previewShape}
              onChange={(v) =>
                canEdit && setForm((f) => ({ ...f, previewShape: v as PreviewShape }))
              }
            >
              <Radio
                value="local"
                disabled={!canEdit}
                label="Local — work is exercised on the machine the session runs on. Normal for a one-box project, not a gap."
              />
              <Radio
                value="deployed"
                disabled={!canEdit}
                label="Deployed — a separate deployment someone opens before a release."
              />
            </RadioGroup>
          </Field>
          <div className={form.previewShape === "deployed" ? "mt-4 space-y-4" : "hidden"}>
            <Field
              label="Preview URL"
              hint="Frontend URL, e.g. https://staging.example.com"
              error={previewUrlError}
            >
              <Input
                value={form.previewUrl}
                onChange={(e) => setField("previewUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://staging.example.com"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
            <Field
              label="Preview API URL"
              hint="Backend/API base URL."
              error={previewApiUrlError}
            >
              <Input
                value={form.previewApiUrl}
                onChange={(e) => setField("previewApiUrl", e.target.value)}
                disabled={!canEdit}
                placeholder="https://api.staging.example.com"
                maxLength={URL_MAX}
                inputMode="url"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <SectionTitle className="fg-h3 mb-1">Testing URLs</SectionTitle>
          <p className="fg-caption mb-4 text-muted">
            Named links QA opens while verifying the preview side — admin panels, mailbox,
            dashboards.
          </p>
          {form.previewUrls.length === 0 ? (
            <p className="fg-body-sm text-muted">No testing URLs.</p>
          ) : (
            <ul className="space-y-3">
              {form.previewUrls.map((row, i) => {
                const err = testingUrlError(row);
                return (
                  <li key={i} className="flex items-start gap-2">
                    <div className="w-40 shrink-0">
                      <Input
                        value={row.label}
                        onChange={(e) => setUrlRow(i, { label: e.target.value })}
                        disabled={!canEdit}
                        placeholder="Label"
                        maxLength={LABEL_MAX}
                        aria-label={`Testing URL ${i + 1} label`}
                      />
                    </div>
                    <div className="flex-1">
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
                        <p role="alert" className="fg-caption mt-1" style={{ color: "var(--red-600)" }}>
                          {err}
                        </p>
                      )}
                    </div>
                    {canEdit && (
                      <IconButton
                        icon="trash"
                        aria-label={`Remove testing URL ${i + 1}`}
                        onClick={() => removeUrlRow(i)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && (
            <div className="mt-4">
              <Button
                variant="secondary"
                icon="plus"
                onClick={addUrlRow}
                disabled={form.previewUrls.length >= MAX_ROWS}
                className="min-h-11"
              >
                Add URL
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <SectionTitle className="fg-h3 mb-1">Test credentials</SectionTitle>
          <p className="fg-caption mb-4 text-muted">
            Login accounts QA uses against either side. Passwords are masked by default.
          </p>
          {form.testCredentials.length === 0 ? (
            <p className="fg-body-sm text-muted">No test credentials.</p>
          ) : (
            <ul className="space-y-3">
              {form.testCredentials.map((row, i) => {
                const err = credentialError(row);
                return (
                  <li key={i} className="rounded-md border border-line p-3">
                    <div className="flex items-start gap-2">
                      <div className="grid flex-1 gap-2 sm:grid-cols-3">
                        <Input
                          value={row.label}
                          onChange={(e) => setCredRow(i, { label: e.target.value })}
                          disabled={!canEdit}
                          placeholder="Label (e.g. Admin)"
                          maxLength={LABEL_MAX}
                          aria-label={`Credential ${i + 1} label`}
                          aria-invalid={err ? true : undefined}
                        />
                        <Input
                          value={row.username}
                          onChange={(e) => setCredRow(i, { username: e.target.value })}
                          disabled={!canEdit}
                          placeholder="Username"
                          maxLength={USERNAME_MAX}
                          autoComplete="off"
                          aria-label={`Credential ${i + 1} username`}
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
                      <p role="alert" className="fg-caption mt-2" style={{ color: "var(--red-600)" }}>
                        {err}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit && (
            <div className="mt-4">
              <Button
                variant="secondary"
                icon="plus"
                onClick={addCredRow}
                disabled={form.testCredentials.length >= MAX_ROWS}
                className="min-h-11"
              >
                Add credential
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <div>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || hasErrors}
            onClick={save}
            className="min-h-11"
          >
            Save testing config
          </Button>
        </div>
      )}
    </div>
  );
}
