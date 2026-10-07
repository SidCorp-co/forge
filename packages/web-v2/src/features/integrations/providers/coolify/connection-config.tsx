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

/** The connection tier of a Coolify credential: the server it points at, and nothing else. */
export const CoolifyConnectionConfig: ConnectionSection = ({ connection, canManage }) => {
  const update = useUpdateConnection();
  const t = useCopy();
  const [baseUrl, setBaseUrl] = useState(
    typeof connection.config?.baseUrl === "string" ? connection.config.baseUrl : "",
  );

  return (
    <section className="flex flex-col gap-3">
      <PageSectionTitle>{t("integrations.detail.config")}</PageSectionTitle>
      <Field label={t("integrations.gitlab.baseUrl")}>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <p className="fg-body-sm text-muted">
        {t("integrations.coolify.connectionNote")}
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
            {t("integrations.rocket.saveConfig")}
          </Button>
        </div>
      )}
    </section>
  );
};
