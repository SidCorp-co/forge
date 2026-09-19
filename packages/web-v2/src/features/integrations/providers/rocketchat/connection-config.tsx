"use client";

import { useState } from "react";
import {
  Button,
  CardTitle,
  Field,
  Input,
} from "@/design";
import { useUpdateConnection } from "../../hooks";
import type { ConnectionSection } from "../registry";

/** The connection tier of a Rocket.Chat bot: the chat server. Rooms are binding-tier. */
export const RocketchatConnectionConfig: ConnectionSection = ({ connection, canManage }) => {
  const update = useUpdateConnection();
  const [serverUrl, setServerUrl] = useState(
    typeof connection.config?.serverUrl === "string" ? connection.config.serverUrl : "",
  );

  return (
    <section className="flex flex-col gap-3">
      <CardTitle>Configuration</CardTitle>
      <Field label="Server URL" hint="e.g. https://chat.example.com">
        <Input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <p className="fg-body-sm text-muted">
        This is the shared bot credential (server URL + bot token). The room each project listens on
        is configured per project under project settings → Integrations.
      </p>
      {canManage && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            onClick={() =>
              update.mutate({
                id: connection.id,
                body: { config: { serverUrl: serverUrl.trim() } },
              })
            }
          >
            Save configuration
          </Button>
        </div>
      )}
    </section>
  );
};
