"use client";

import { useState } from "react";
import { Button, Field, Input } from "@/design";
import { useUpdateConnection } from "../../hooks";
import type { ConnectionSection } from "../registry";

/** The connection tier of a Coolify credential: the server it points at, and nothing else. */
export const CoolifyConnectionConfig: ConnectionSection = ({ connection, canManage }) => {
  const update = useUpdateConnection();
  const [baseUrl, setBaseUrl] = useState(
    typeof connection.config?.baseUrl === "string" ? connection.config.baseUrl : "",
  );

  return (
    <section className="flex flex-col gap-3">
      <h3 className="fg-h4">Configuration</h3>
      <Field label="Base URL">
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <p className="fg-body-sm text-muted">
        This is the shared credential (server URL + API token only). Deploy targets — the Coolify
        application(s) each project deploys, including a split backend/frontend — are configured per
        project under project settings → Integrations.
      </p>
      {canManage && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            onClick={() =>
              update.mutate({ id: connection.id, body: { config: { baseUrl: baseUrl.trim() } } })
            }
          >
            Save configuration
          </Button>
        </div>
      )}
    </section>
  );
};
