"use client";

// One credential, as one row of its app's group (ISS-1035).
//
// This was a 148px card in a three-column grid (ISS-429) until an org holding
// several credentials of one app made that wall unreadable. The row answers the
// same three questions the card did — what is this, what does it point at, who
// uses it — in two dense lines, so several credentials of one app are on the
// screen at once. BINDING-scoped management (environment, webhook rotate,
// delivery log, disconnect) is still project settings → Integrations' and
// deliberately absent here; the row names the bindings and manages none of
// them. Opening it hands the rest to the edit drawer (ISS-435).

import { useState } from "react";
import { Badge, Button, Icon } from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { formatRelativeTime } from "@/lib/utils/format";
import { useCanManageConnection, useRemoveConnection, useUpdateConnection } from "../hooks";
import { connectionTarget, connectionTitle } from "../connection-identity";
import { deriveConnectionStatus } from "../derive";
import { DirectoryStatusPill, ENV_LABEL, PROVIDER_ICON, PROVIDER_LABEL } from "./status-pill";

/** Projects a connection is bound to, named — the line that tells two credentials apart. */
function UsageLine({
  connection,
  projectName,
}: {
  connection: ConnectionDirectoryItem;
  projectName: (id: string) => string;
}) {
  const bindings = connection.usage.bindings;
  if (bindings.length === 0) {
    return (
      <span className="fg-body-sm text-subtle">
        Not used by any project — share it from a project&apos;s settings → Integrations.
      </span>
    );
  }
  return (
    <>
      {bindings.map((b) => (
        <span
          key={b.id}
          className="fg-body-sm inline-flex items-center gap-1 rounded-pill border border-line bg-surface px-2 py-0.5"
          title={b.active ? undefined : "this project has the integration switched off"}
        >
          <span className="max-w-[14ch] truncate">{projectName(b.projectId)}</span>
          <span className="text-subtle">{ENV_LABEL[b.environment] ?? b.environment}</span>
          {!b.active && <span className="text-subtle">· off</span>}
        </span>
      ))}
    </>
  );
}

function RemoveButton({ connection }: { connection: ConnectionDirectoryItem }) {
  const remove = useRemoveConnection();
  const [armed, setArmed] = useState(false);
  const count = connection.usage.bindings.length;

  if (!armed) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(true);
        }}
      >
        Remove
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="fg-body-sm text-muted">
        {count > 0 ? `Disconnects ${count} project${count > 1 ? "s" : ""}.` : "Delete it?"}
      </span>
      <Button
        variant="danger"
        size="sm"
        loading={remove.isPending}
        onClick={(e) => {
          e.stopPropagation();
          remove.mutate(connection.id);
        }}
      >
        Delete
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}

// cm:guard show the provider pill only when the TITLE is not already the provider label — `displayName` falls back to that label, so printing both rendered "Coolify deploy Coolify deploy" on every one of the 17 unnamed rows on forge-beta 2026-09-06
export function ConnectionRow({
  connection,
  ownerLabel,
  projectName,
  onOpen,
}: {
  connection: ConnectionDirectoryItem;
  /** ISS-477 — which principal owns this credential ("Personal" or an org name). */
  ownerLabel: string;
  projectName: (id: string) => string;
  onOpen: () => void;
}) {
  const update = useUpdateConnection();
  const canManage = useCanManageConnection(connection);
  const checked = formatRelativeTime(connection.lastHealthAt);
  const title = connectionTitle(connection);
  const target = connectionTarget(connection);
  const providerLabel = PROVIDER_LABEL[connection.provider] ?? connection.provider;

  return (
    // The row body opens the edit drawer (ISS-435); inner buttons keep their
    // own actions via stopPropagation.
    // biome-ignore lint/a11y/useSemanticElements: a <button> cannot contain the Disable/Enable/Remove buttons this row carries, and HTML forbids nesting them — the div takes role, tabIndex, an aria-label and its own Enter/Space handler so the keyboard path is the semantic element's
    <div
      role="button"
      tabIndex={0}
      aria-label={`Manage connection ${title}`}
      className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle px-3 py-2 hover:bg-sunken focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only when the row ITSELF is focused — Enter/Space on the inner
        // buttons/links must keep their native activation.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <span className="inline-flex min-w-0 items-center gap-2">
          <Icon
            name={PROVIDER_ICON[connection.provider] ?? "link"}
            size={16}
            className="shrink-0 text-muted"
          />
          <span className="fg-label truncate">{title}</span>
          {title !== providerLabel && (
            <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
              {providerLabel}
            </span>
          )}
          <Badge tone={connection.ownerType === "org" ? "accent" : "neutral"}>{ownerLabel}</Badge>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {target && (
            <span className="fg-body-sm truncate font-mono text-muted" title={target}>
              {target}
            </span>
          )}
          <UsageLine connection={connection} projectName={projectName} />
          <span className="fg-body-sm text-subtle">
            {connection.lastHealthStatus
              ? `last health: ${connection.lastHealthStatus}${checked ? ` · ${checked}` : ""}`
              : "never health-checked"}
            {!connection.hasSecrets && " · no credential stored"}
          </span>
        </span>
      </span>

      <DirectoryStatusPill status={deriveConnectionStatus(connection)} />

      <span className="flex shrink-0 items-center gap-1">
        {canManage ? (
          <>
            {connection.active ? (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  update.mutate({ id: connection.id, body: { active: false } });
                }}
              >
                Disable
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={update.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  update.mutate({ id: connection.id, body: { active: true } });
                }}
              >
                Enable
              </Button>
            )}
            <RemoveButton connection={connection} />
          </>
        ) : (
          // cm:guard say WHY the actions are absent rather than rendering buttons that 403 — a plain org member can see this credential and cannot change it, and a disabled button with no reason reads as a bug
          <span className="fg-body-sm text-subtle">
            Read-only — only an admin of {ownerLabel} can change this credential.
          </span>
        )}
      </span>
    </div>
  );
}
