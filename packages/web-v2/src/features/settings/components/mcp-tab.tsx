"use client";

// Settings → MCP. There is no backend "MCP config" to persist (the `/mcp`
// endpoint is the protocol surface; access is by PAT). So this tab does the two
// real things v1's /settings/mcp does, both against the live endpoint:
//   1. Generate per-client config snippets (token rendered as a placeholder —
//      secrets are never echoed here; the plaintext shows once, on Tokens).
//   2. Test the connection live via JSON-RPC `tools/list`.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  Select,
  type SelectOption,
  Skeleton,
  Tabs,
  type TabItem,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
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

const CLIENT_TABS: TabItem[] = CLIENTS.map((c) => ({ value: c.kind, label: c.label }));

const TOKENS_TAB_HREF = "/settings?tab=tokens";

export function McpTab() {
  const projectsQ = useProjects();
  const { toast } = useToast();

  // The MCP endpoint is same-origin with core; resolve client-side.
  const [endpoint, setEndpoint] = useState("/mcp");
  useEffect(() => setEndpoint(getMcpUrl()), []);

  const projects = projectsQ.data ?? [];
  const [projectId, setProjectId] = useState<string | null>(null);
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? projects[0] ?? null,
    [projects, projectId],
  );
  const projectSlug = selectedProject?.slug ?? "";

  const projectOptions: SelectOption[] = projects.map((p) => ({
    value: p.id,
    label: `${p.name} · ${p.slug}`,
  }));

  const [client, setClient] = useState<ClientKind>("claude-cli");
  const snippet = useMemo(
    () => generateSnippet(client, { projectSlug, mcpUrl: endpoint }),
    [client, projectSlug, endpoint],
  );

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet.content);
      setCopied(true);
    } catch {
      toast({ title: "Copy failed", description: "Select and copy it manually.", tone: "error" });
    }
  }

  if (projectsQ.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (projectsQ.isError) {
    return (
      <ErrorState
        title="Couldn't load projects"
        message={formatApiError(projectsQ.error)}
        onRetry={() => projectsQ.refetch()}
      />
    );
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        message="MCP clients connect to a specific project. Create or join a project, then come back for a config snippet."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Banner tone="info">
        MCP clients authenticate with a personal access token. Create one on the{" "}
        <Link href={TOKENS_TAB_HREF} className="font-semibold text-fg underline underline-offset-2">
          API Tokens
        </Link>{" "}
        tab, then paste it into the snippet below in place of the placeholder.
      </Banner>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-4">Connect a client</h2>
          <div className="space-y-4">
            <div>
              <p className="fg-label mb-1.5">Endpoint</p>
              <MonoTag>{endpoint}</MonoTag>
            </div>
            <Field label="Project" hint="Sets the X-Forge-Project-Slug header — the project this client's tool calls are scoped to.">
              <Select
                options={projectOptions}
                value={selectedProject?.id ?? ""}
                onChange={(v) => setProjectId(v)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="fg-h3">Config snippet</h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={copySnippet}
              className="min-h-11"
              aria-live="polite"
            >
              {copied ? "Copied ✓" : "Copy"}
            </Button>
          </div>

          <div className="mb-3 overflow-x-auto">
            <Tabs tabs={CLIENT_TABS} value={client} onChange={(v) => setClient(v as ClientKind)} />
          </div>

          <p className="fg-caption mb-2">
            Add to <MonoTag>{snippet.filePath}</MonoTag> and replace{" "}
            <MonoTag hue="flame">{TOKEN_PLACEHOLDER}</MonoTag> with your token.
          </p>
          <pre className="overflow-x-auto rounded-md border border-line bg-sunken p-3 text-[12.5px] leading-relaxed text-fg">
            <code>
              <SnippetCode content={snippet.content} />
            </code>
          </pre>
        </CardContent>
      </Card>

      <TestConnectionPanel mcpUrl={endpoint} projectSlug={projectSlug} />
    </div>
  );
}

/** Snippet body with the token placeholder highlighted — it's the one part of
 *  the config the user must edit, so it shouldn't blend into the JSON. */
function SnippetCode({ content }: { content: string }) {
  const parts = content.split(TOKEN_PLACEHOLDER);
  return (
    <>
      {parts.map((part, i) => (
        // Index keys are safe: parts derive solely from `content` and re-render together.
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
function recoveryHint(err: unknown): ReactNode | null {
  if (err instanceof McpTestError) {
    if (err.status === 401)
      return (
        <>
          The token is invalid, expired, or revoked. Create a new one on the{" "}
          <Link href={TOKENS_TAB_HREF} className="font-semibold underline underline-offset-2">
            API Tokens
          </Link>{" "}
          tab.
        </>
      );
    if (err.status === 403)
      return "The token works, but its owner isn't a member of the selected project. Pick another project or ask an owner for access.";
    if (err.status === 429) return "Rate limit hit for this token. Wait a moment and try again.";
    return null;
  }
  // fetch() network failure (CORS, DNS, server down) surfaces as a TypeError.
  return "The endpoint couldn't be reached from this browser. Check that the server is up and the URL is correct.";
}

/** Live connection test. The token is typed by the user per-test and is never
 *  stored or rendered back — it only rides the one request to `/mcp`. */
function TestConnectionPanel({ mcpUrl, projectSlug }: { mcpUrl: string; projectSlug: string }) {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<ReactNode | null>(null);

  async function run() {
    if (!token.trim()) return;
    setStatus("testing");
    setResult(null);
    setError(null);
    setHint(null);
    try {
      const res = await testConnection({ url: mcpUrl, token: token.trim(), projectSlug });
      setResult(res);
      setStatus("ok");
    } catch (err) {
      const msg =
        err instanceof McpTestError
          ? `${err.status}${err.code ? ` ${err.code}` : ""} — ${err.message}`
          : err instanceof Error
            ? err.message
            : "Connection failed";
      setError(msg);
      setHint(recoveryHint(err));
      setStatus("error");
    }
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Test connection</h2>
        <p className="fg-caption mb-4">
          Paste a token to verify it can reach this project over MCP. The token isn&apos;t saved.
        </p>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="flex-1">
            <Field label="Personal access token">
              <Input
                type="password"
                autoComplete="off"
                placeholder="forge_pat_live_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Field>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={!token.trim() || status === "testing"}
            loading={status === "testing"}
            className="min-h-11"
          >
            Test
          </Button>
        </form>

        {status === "ok" && result && (
          <div className="mt-4" role="status">
            <Badge tone="accent">Connected · {result.toolsCount} tools</Badge>
            {result.sampleNames.length > 0 && (
              <div className="fg-caption mt-2 flex flex-wrap items-center gap-1.5">
                <span>e.g.</span>
                {result.sampleNames.map((n) => (
                  <MonoTag key={n}>{n}</MonoTag>
                ))}
              </div>
            )}
          </div>
        )}

        {status === "error" && error && (
          <div className="mt-4">
            <Banner tone="danger">
              <span className="font-mono text-[12.5px]">{error}</span>
              {hint && <p className="mt-1">{hint}</p>}
            </Banner>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
