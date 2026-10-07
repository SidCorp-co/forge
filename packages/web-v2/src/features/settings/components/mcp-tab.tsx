"use client";

// Settings → MCP. There is no backend "MCP config" to persist (the `/mcp`
// endpoint is the protocol surface; access is by PAT). So this tab does the two
// real things v1's /settings/mcp does, both against the live endpoint:
//   1. Generate per-client config snippets (token rendered as a placeholder —
//      secrets are never echoed here; the plaintext shows once, on Tokens).
//   2. Test the connection live via JSON-RPC `tools/list`.
import { Fragment, type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Banner,
  Button,
  PageSection,
  PageSectionBody,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  SectionTitle,
  Select,
  Skeleton,
  Tabs,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { useCurrentProject } from "@/features/projects/current-project";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import type { ProjectListItem } from "@/features/projects/types";
import {
  CLIENTS,
  type ClientKind,
  generateSnippet,
  getMcpUrl,
  McpTestError,
  TOKEN_PLACEHOLDER,
  testConnection,
  type TestConnectionResult,
} from "../mcp";

const TOKENS_TAB_HREF = "/settings?tab=tokens";

export function McpTab() {
  const projectsQ = useProjects();
  // Resolved after mount: where core shares the browser's origin, the URL reads `window`.
  const [endpoint, setEndpoint] = useState("/mcp");
  useEffect(() => setEndpoint(getMcpUrl()), []);
  const projects = projectsQ.data ?? [];
  const currentProject = useCurrentProject();
  const [projectId, setProjectId] = useState<string | null>(null);
  const t = useCopy();
  // A pick, else the project the person is working in — never the list's first
  // entry: the snippet is pasted unread, so a guessed project is a wrong config.
  const selectedProject =
    projects.find((p) => p.id === projectId) ??
    projects.find((p) => p.id === currentProject?.id) ??
    null;

  if (projectsQ.isLoading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  if (projectsQ.isError)
    return (
      <ErrorState title={t("settings.mcp.loadFailed")} message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
    );
  if (projects.length === 0)
    return (
      <EmptyState
        title={t("settings.orgs.noProjectsTitle")}
        message={t("settings.mcp.noProjects")}
      />
    );

  return (
    <div className="space-y-6">
      <Banner tone="info">
        {t("settings.mcp.authLead")}{" "}
        <Link href={TOKENS_TAB_HREF} className="font-semibold text-fg underline underline-offset-2">
          {t("shell.settings.tab.tokens")}
        </Link>{" "}
        {t("settings.mcp.authTail")}
      </Banner>

      <PageSection>
        <PageSectionBody>
          <SectionTitle className="fg-h3 mb-4">{t("settings.mcp.connectClient")}</SectionTitle>
          <div className="space-y-4">
            <div>
              <p className="fg-label mb-1.5">{t("settings.mcp.endpoint")}</p>
              <MonoTag>{endpoint}</MonoTag>
            </div>
            <Field label={t("common.nav.project")} hint={t("settings.mcp.projectHint")}>
              <Select
                options={projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.slug}` }))}
                value={selectedProject?.id ?? ""}
                onChange={setProjectId}
                placeholder={t("settings.mcp.chooseProjectPlaceholder")}
              />
            </Field>
          </div>
        </PageSectionBody>
      </PageSection>

      {selectedProject ? (
        <>
          <SnippetPanel project={selectedProject} currentProject={currentProject} endpoint={endpoint} />
          <TestConnectionPanel mcpUrl={endpoint} projectSlug={selectedProject.slug} />
        </>
      ) : (
        <EmptyState
          title={t("settings.mcp.chooseProject")}
          message={t("settings.mcp.chooseProjectBody")}
        />
      )}
    </div>
  );
}

function SnippetPanel({
  project,
  currentProject,
  endpoint,
}: {
  project: ProjectListItem;
  currentProject: ProjectListItem | null;
  endpoint: string;
}) {
  const { toast } = useToast();
  const [client, setClient] = useState<ClientKind>("claude-cli");
  const snippet = generateSnippet(client, { projectSlug: project.slug, mcpUrl: endpoint });

  const [copied, setCopied] = useState(false);
  const t = useCopy();
  const clients = CLIENTS.map((c) => (c.value === "generic" ? { ...c, label: t("settings.mcp.generic") } : c));
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet.content);
      setCopied(true);
    } catch {
      toast({ title: t("settings.agents.copyFailed"), description: t("settings.agents.copyByHand"), tone: "error" });
    }
  }

  return (
      <PageSection>
        <PageSectionBody>
          <div className="mb-2 flex items-center justify-between gap-3">
            <SectionTitle className="fg-h3">{t("settings.mcp.snippet")}</SectionTitle>
            <Button
              variant="secondary"
              size="sm"
              onClick={copySnippet}
              className="min-h-11"
              aria-live="polite"
            >
              {copied ? t("settings.mcp.copied") : t("settings.agents.copy")}
            </Button>
          </div>
          <p className="fg-body-sm mb-4 text-fg" data-testid="mcp-snippet-target">
            {t("settings.mcp.configures")} <strong>{project.name}</strong> <MonoTag>{project.slug}</MonoTag>
            {currentProject && currentProject.id !== project.id
              ? t("settings.mcp.notCurrent", { name: currentProject.name })
              : currentProject
                ? t("settings.mcp.isCurrent")
                : "."}
          </p>

          <div className="mb-3 overflow-x-auto">
            <Tabs tabs={clients} value={client} onChange={(v) => setClient(v as ClientKind)} />
          </div>

          <p className="fg-caption mb-2" data-testid="mcp-snippet-how">
            {snippet.howTo === "command" ? (
              <>
                {t("settings.mcp.replace")} <MonoTag hue="flame">{TOKEN_PLACEHOLDER}</MonoTag>{" "}
                {t("settings.mcp.replaceRun")}
              </>
            ) : (
              <>
                {t("settings.mcp.addTo")} <MonoTag>{snippet.filePath}</MonoTag> {t("settings.mcp.andReplace")}{" "}
                <MonoTag hue="flame">{TOKEN_PLACEHOLDER}</MonoTag> {t("settings.mcp.withToken")}
              </>
            )}
          </p>
          <pre className="overflow-x-auto rounded-md border border-line bg-sunken p-3 text-12-5 leading-relaxed text-fg">
            <code>
              <SnippetCode content={snippet.content} />
            </code>
          </pre>
        </PageSectionBody>
      </PageSection>
  );
}

/** Snippet body with the token placeholder highlighted — it's the one part of
 *  the config the user must edit, so it shouldn't blend into the JSON. */
function SnippetCode({ content }: { content: string }) {
  const parts = content.split(TOKEN_PLACEHOLDER);
  return (
    <>
      {parts.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts derive solely from `content` and re-render together.
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <mark
              className="rounded-sm font-semibold"
              style={{
                background: "var(--flame-50)",
                color: "var(--flame-700)",
                padding: "1px 3px",
              }}
            >
              {TOKEN_PLACEHOLDER}
            </mark>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** Map a failed test to a recovery hint so the error is actionable, not just a
 *  status code. Returns null when there's nothing better than the raw message. */
function recoveryHint(err: unknown, t: Copy): ReactNode | null {
  if (err instanceof McpTestError) {
    if (err.status === 401)
      return (
        <>
          {t("settings.mcp.hint401")}{" "}
          <Link href={TOKENS_TAB_HREF} className="font-semibold underline underline-offset-2">
            {t("shell.settings.tab.tokens")}
          </Link>
          .
        </>
      );
    if (err.status === 403) return t("settings.mcp.hint403");
    if (err.status === 429) return t("settings.mcp.hint429");
    return null;
  }
  // fetch() network failure (CORS, DNS, server down) surfaces as a TypeError.
  return t("settings.mcp.hintUnreachable");
}

type TestState =
  | { status: "idle" | "testing" }
  | { status: "ok"; result: TestConnectionResult }
  | { status: "error"; error: string; hint: ReactNode | null };

function TestOutcome({ test }: { test: TestState }) {
  const t = useCopy();
  if (test.status === "ok")
    return (
      <div className="mt-4" role="status">
        <Badge tone="accent">{t("settings.mcp.connectedTools", { n: test.result.toolsCount })}</Badge>
        {test.result.sampleNames.length > 0 && (
          <div className="fg-caption mt-2 flex flex-wrap items-center gap-1.5">
            <span>{t("settings.mcp.eg")}</span>
            {test.result.sampleNames.map((n) => (
              <MonoTag key={n}>{n}</MonoTag>
            ))}
          </div>
        )}
      </div>
    );
  if (test.status === "error" && test.error)
    return (
      <div className="mt-4">
        <Banner tone="danger">
          <span className="font-mono text-12-5">{test.error}</span>
          {test.hint && <p className="mt-1">{test.hint}</p>}
        </Banner>
      </div>
    );
  return null;
}

/** Live connection test. The token is typed by the user per-test and is never
 *  stored or rendered back — it only rides the one request to `/mcp`. */
function TestConnectionPanel({ mcpUrl, projectSlug }: { mcpUrl: string; projectSlug: string }) {
  const [token, setToken] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const t = useCopy();

  async function run() {
    if (!token.trim()) return;
    setTest({ status: "testing" });
    try {
      const result = await testConnection({ url: mcpUrl, token: token.trim(), projectSlug });
      setTest({ status: "ok", result });
    } catch (err) {
      const error =
        err instanceof McpTestError
          ? `${err.status}${err.code ? ` ${err.code}` : ""} — ${err.message}`
          : err instanceof Error
            ? err.message
            : t("integrations.provider.connectionFailed");
      setTest({ status: "error", error, hint: recoveryHint(err, t) });
    }
  }

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-1">{t("integrations.edit.test")}</SectionTitle>
        <p className="fg-caption mb-4">{t("settings.mcp.testIntro")}</p>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="flex-1">
            <Field label={t("settings.mcp.pat")}>
              <Input
                type="password"
                autoComplete="off"
                placeholder="forge_pat_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={!token.trim() || test.status === "testing"}
            loading={test.status === "testing"}
            className="min-h-11"
          >
            {t("integrations.provider.test")}
          </Button>
        </form>

        <TestOutcome test={test} />
      </PageSectionBody>
    </PageSection>
  );
}
