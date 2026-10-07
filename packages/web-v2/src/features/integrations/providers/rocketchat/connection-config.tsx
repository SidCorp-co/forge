"use client";

import { useState } from "react";
import {
  Button,
  PageSectionTitle,
  Field,
  Input,
} from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useUpdateConnection } from "../../hooks";
import type { ConnectionSection } from "../registry";

/** The connection tier of a Rocket.Chat bot: the chat server. Rooms are binding-tier. */
export const RocketchatConnectionConfig: ConnectionSection = ({ connection, canManage }) => {
  const update = useUpdateConnection();
  const t = useCopy();
  const [serverUrl, setServerUrl] = useState(
    typeof connection.config?.serverUrl === "string" ? connection.config.serverUrl : "",
  );

  return (
    <section className="flex flex-col gap-3">
      <PageSectionTitle>{t("integrations.detail.config")}</PageSectionTitle>
      <Field label={t("integrations.rocket.server")} hint={t("integrations.rocket.serverHint")}>
        <Input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <p className="fg-body-sm text-muted">
        {t("integrations.rocket.connectionNote")}
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
            {t("integrations.rocket.saveConfig")}
          </Button>
        </div>
      )}
    </section>
  );
};
