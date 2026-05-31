"use client";

// Project settings → Integrations. The full integrations surface (Coolify,
// webhooks, channels, …) lives at the workspace `/integrations` route — this
// tab is a deliberate link-through rather than a duplicate, per the issue's
// "integrations link-through" scope. No secrets are rendered here.
import { useRouter } from "next/navigation";
import { Button, Card, CardContent } from "@/design";

export function IntegrationsTab() {
  const router = useRouter();
  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Integrations</h2>
        <p className="fg-body-sm mb-4 text-muted">
          Deploy hooks, webhooks, and notification channels are configured on the workspace
          Integrations page.
        </p>
        <Button variant="secondary" icon="link" onClick={() => router.push("/integrations")}>
          Open Integrations
        </Button>
      </CardContent>
    </Card>
  );
}
