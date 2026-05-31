"use client";

// Settings → MCP. There is no backend "MCP config" to persist (the `/mcp`
// endpoint is the protocol surface; access is by PAT). So this tab does the two
// real things v1's /settings/mcp does, both against the live endpoint:
//   1. Generate per-client config snippets (token rendered as a placeholder —
//      secrets are never echoed here; the plaintext shows once, on Tokens).
//   2. Test the connection live via JSON-RPC `tools/list`.
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
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

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet.content);
      toast({ title: "Snippet copied", tone: "success" });
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
        <span className="font-semibold text-fg">API Tokens</span> tab, then paste it into the
        snippet below in place of the placeholder.
      </Banner>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-4">Connect a client</h2>
          <div className="space-y-4">
            <div>
              <p className="fg-label mb-1.5">Endpoint</p>
              <MonoTag>{endpoint}</MonoTag>
            </div>
            <div>
              <p className="fg-label mb-1.5">Project</p>
              <Select
                options={projectOptions}
                value={selectedProject?.id ?? ""}
                onChange={(v) => setProjectId(v)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="fg-h3">Config snippet</h2>
            <Button variant="secondary" size="sm" onClick={copySnippet} className="min-h-11">
              Copy
            </Button>
          </div>

          <div className="mb-3 overflow-x-auto">
            <Tabs tabs={CLIENT_TABS} value={client} onChange={(v) => setClient(v as ClientKind)} />
          </div>

          <p className="fg-caption mb-2">
            Add to <MonoTag>{snippet.filePath}</MonoTag> and replace{" "}
            <MonoTag>{TOKEN_PLACEHOLDER}</MonoTag> with your token.
          </p>
          <pre className="overflow-x-auto rounded-md border border-line bg-sunken p-3 text-[12.5px] leading-relaxed text-fg">
            <code>{snippet.content}</code>
          </pre>
        </CardContent>
      </Card>

      <TestConnectionPanel mcpUrl={endpoint} projectSlug={projectSlug} />
    </div>
  );
}

/** Live connection test. The token is typed by the user per-test and is never
 *  stored or rendered back — it only rides the one request to `/mcp`. */
function TestConnectionPanel({ mcpUrl, projectSlug }: { mcpUrl: string; projectSlug: string }) {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [result, setResult] = useState<TestConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!token.trim()) return;
    setStatus("testing");
    setResult(null);
    setError(null);
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
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="password"
            placeholder="forge_pat_live_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="flex-1"
          />
          <Button
            variant="primary"
            onClick={run}
            disabled={!token.trim() || status === "testing"}
            loading={status === "testing"}
            className="min-h-11"
          >
            Test
          </Button>
        </div>

        {status === "ok" && result && (
          <div className="mt-4">
            <Badge tone="accent">Connected · {result.toolsCount} tools</Badge>
            {result.sampleNames.length > 0 && (
              <p className="fg-caption mt-2">
                e.g. {result.sampleNames.map((n) => (
                  <MonoTag key={n}>{n}</MonoTag>
                ))}
              </p>
            )}
          </div>
        )}

        {status === "error" && error && (
          <div className="mt-4">
            <Banner tone="danger">{error}</Banner>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
