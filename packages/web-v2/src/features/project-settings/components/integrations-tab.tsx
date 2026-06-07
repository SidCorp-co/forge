"use client";

// Project settings → Integrations. The full per-project integration config
// (Epodsystem storefront, Coolify deploy, Postman) lives at the workspace
// `/integrations` hub — this tab deep-links there rather than duplicating the
// forms (ISS-395 AC4). No secrets are rendered here.
import { useRouter } from "next/navigation";
import { Button, Card, CardContent } from "@/design";

export function IntegrationsTab() {
  const router = useRouter();
  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Integrations</h2>
        <p className="fg-body-sm mb-4 text-muted">
          Configure this project&apos;s integrations — Epodsystem storefront, Coolify deploy
          (staging/prod, webhook secret, production gate), and Postman — on the workspace
          Integrations page. Connection testing and secret rotation happen there.
        </p>
        <Button variant="secondary" icon="link" onClick={() => router.push("/integrations")}>
          Open Integrations
        </Button>
      </CardContent>
    </Card>
  );
}
