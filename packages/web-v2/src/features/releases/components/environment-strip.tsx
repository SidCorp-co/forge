"use client";

import { Tooltip } from "@/design";
import type { ReleaseVersionList } from "../versions-types";

export function EnvironmentStrip({ list }: { list: ReleaseVersionList }) {
  if (!list.environmentsRead.ok) {
    return (
      <p className="px-4 pb-3 text-12 text-amber sm:px-7" data-testid="env-unread">
        Environments cannot be read from the project document: {list.environmentsRead.reason}
      </p>
    );
  }
  if (list.environments.length === 0) {
    return (
      <p className="px-4 pb-3 text-12 text-subtle sm:px-7" data-testid="env-none">
        The project document declares no environment.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2 px-4 pb-3 sm:px-7" data-testid="env-strip">
      {list.environments.map((env) => {
        const production = env.tier === "production";
        const tip = production
          ? env.version
            ? `The last release to ship cut ${env.version}${env.url ? ` · ${env.url}` : ""}`
            : "No release has shipped to production yet"
          : `${env.tier} · the issue path deploys here per issue; no version is recorded for it`;
        return (
          <Tooltip key={env.name} label={tip} side="bottom">
            <span className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface px-3 py-1.5 text-13">
              <span
                className="size-2 flex-none rounded-full"
                style={{ background: production && env.version ? "var(--green-600, #23794a)" : "var(--border-strong)" }}
                aria-hidden
              />
              <b className="font-semibold">{env.name}</b>
              <span className="font-mono text-12 text-muted">
                {production ? (env.version ?? "nothing shipped") : env.tier}
              </span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
