"use client";

// Settings → MCP. There is no user-facing MCP-server CRUD API (MCP config is
// per-pipeline-state / admin; `/mcp` is the protocol endpoint), so this tab is
// informational — it documents the endpoint + how to connect with a PAT rather
// than faking a save.
import { useEffect, useState } from "react";
import { Banner, Card, CardContent, MonoTag } from "@/design";

export function McpTab() {
  // The MCP endpoint is same-origin with core. Resolve it client-side; fall
  // back to the relative path during SSR.
  const [endpoint, setEndpoint] = useState("/mcp");
  useEffect(() => {
    setEndpoint(`${window.location.origin}/mcp`);
  }, []);

  return (
    <div className="space-y-6">
      <Banner tone="info">
        MCP access is configured with a personal access token — there is nothing to save here.
      </Banner>

      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-4">Connect over MCP</h2>
          <div className="space-y-4">
            <div>
              <p className="fg-label mb-1.5">Endpoint</p>
              <MonoTag>{endpoint}</MonoTag>
            </div>
            <div>
              <p className="fg-label mb-1.5">Authentication</p>
              <p className="fg-body-sm text-muted">
                Authenticate with a personal access token as a Bearer credential. Create one on the{" "}
                <span className="font-semibold text-fg">API Tokens</span> tab and give it the scopes
                your client needs (<MonoTag>read</MonoTag> for queries, <MonoTag>write</MonoTag> to
                mutate).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
