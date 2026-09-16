"use client";

import { useState } from "react";
import { Button, Field, Input, SegmentedControl } from "@/design";
import { useUpdateConnection } from "../../hooks";
import type { PostmanMode, PostmanRegion } from "../../types";
import type { ConnectionSection } from "../registry";

function region(value: unknown): PostmanRegion {
  return value === "eu" ? "eu" : "us";
}
function mode(value: unknown): PostmanMode {
  return value === "full" ? "full" : "minimal";
}

/** The connection tier of a Postman credential: which workspace it writes into, and how much. */
export const PostmanConnectionConfig: ConnectionSection = ({ connection, canManage }) => {
  const update = useUpdateConnection();
  const config = connection.config ?? {};
  const [workspaceName, setWorkspaceName] = useState(
    typeof config.workspaceName === "string" ? config.workspaceName : "",
  );
  const [form, setForm] = useState({ region: region(config.region), mode: mode(config.mode) });

  return (
    <section className="flex flex-col gap-3">
      <h3 className="fg-h4">Configuration</h3>
      <Field label="Workspace name" hint="The Postman workspace this connection writes into.">
        <Input
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          disabled={!canManage}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="fg-label">Region</span>
          {canManage ? (
            <SegmentedControl<PostmanRegion>
              value={form.region}
              onChange={(v) => setForm((p) => ({ ...p, region: v }))}
              options={[
                { value: "us", label: "US" },
                { value: "eu", label: "EU" },
              ]}
            />
          ) : (
            <span className="fg-body-sm text-muted">{form.region.toUpperCase()}</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="fg-label">Mode</span>
          {canManage ? (
            <SegmentedControl<PostmanMode>
              value={form.mode}
              onChange={(v) => setForm((p) => ({ ...p, mode: v }))}
              options={[
                { value: "minimal", label: "Minimal" },
                { value: "full", label: "Full" },
              ]}
            />
          ) : (
            <span className="fg-body-sm text-muted">{form.mode}</span>
          )}
        </div>
      </div>
      {canManage && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            onClick={() =>
              update.mutate({
                id: connection.id,
                body: {
                  config: {
                    workspaceName: workspaceName.trim(),
                    region: form.region,
                    mode: form.mode,
                  },
                },
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
