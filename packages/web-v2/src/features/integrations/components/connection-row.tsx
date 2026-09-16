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

import { useId, useState } from "react";
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

/**
 * What assistive technology and voice control call the control that opens a
 * row's drawer. `aria-label` overrides every descendant, so a bare "Manage
 * connection <title>" announces the four unnamed Coolify credentials of one
 * org identically — the very wall this issue set out to remove, rebuilt in the
 * accessibility tree where nobody looks at it.
 *
 * What goes in is the row's IDENTITY, in the order the row shows it: the name
 * its owner gave it, the app it belongs to on the same condition the visible
 * pill uses, the target its config points at, and the projects using it — each
 * binding carried with the environment and the off marker its chip shows,
 * because two tokens for one project in two environments are told apart on
 * screen by that word alone. Each clause is independent of the others: a name
 * carries every discriminator the row shows, never the first one it finds.
 *
 * What stays out is the row's STATE — the health line and the status pill.
 * Those move under the credential rather than distinguishing it, they are read
 * from the row's own text and its pill, and putting them in the name would make
 * a control rename itself when a health check landed. `aria-describedby`
 * carries them, and the owner badge with them, so the name and the description
 * between them hold every token the row renders.
 *
 * Where the row shows nothing that tells two apart, neither does this:
 * suffixing an id would name the rows by something no one can see, and two rows
 * that read the same are then honestly the same.
 */
export function connectionRowLabel(
  connection: ConnectionDirectoryItem,
  projectName: (id: string) => string,
): string {
  const title = connectionTitle(connection);
  const parts = [`Manage connection ${title}`];
  // The same condition the visible provider pill renders under: two credentials
  // an operator called "Production", one Coolify and one GitHub, are told apart
  // on screen by that pill and by nothing else.
  const providerLabel = PROVIDER_LABEL[connection.provider] ?? connection.provider;
  if (title !== providerLabel) parts.push(providerLabel);
  const target = connectionTarget(connection);
  if (target) parts.push(target);
  // Independent of the target rather than a fallback for it: two deploy tokens
  // against ONE endpoint, told apart on screen by the projects bound to them,
  // would otherwise reach the same name through the branch that already found
  // a target.
  if (connection.usage.bindings.length > 0) {
    const used = connection.usage.bindings.map((b) => {
      const env = ENV_LABEL[b.environment] ?? b.environment;
      return `${projectName(b.projectId)} ${env}${b.active ? "" : " (off)"}`;
    });
    parts.push(`used by ${used.join(", ")}`);
  }
  return parts.join(" — ");
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
  // `aria-label` REPLACES the button's descendants as its name, so the second
  // line and the status pill reach a screen reader only by being pointed at.
  // Without this the row stops answering "who uses it" and "is it healthy" for
  // exactly the people who cannot see the answer beside the control.
  const ownerId = useId();
  const detailId = useId();
  const statusId = useId();
  const checked = formatRelativeTime(connection.lastHealthAt);
  const title = connectionTitle(connection);
  const target = connectionTarget(connection);
  const providerLabel = PROVIDER_LABEL[connection.provider] ?? connection.provider;

  return (
    // cm:guard the element that opens the drawer is a REAL <button> holding only what it describes, and the Disable/Enable/Remove buttons are its SIBLINGS — the card this row replaced wrapped them all in a role="button" div (ISS-429), which exposes one control containing four others: a nested-interactive structure that flattens the inner controls' semantics for assistive technology. What it costs is that the gap between the text and the status pill no longer opens the drawer; what it buys is a native keyboard path and no hand-written Enter/Space handler.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle px-3 py-2">
      <button
        type="button"
        aria-label={connectionRowLabel(connection, projectName)}
        aria-describedby={`${ownerId} ${detailId} ${statusId}`}
        onClick={onOpen}
        className="-mx-1 flex min-w-[220px] flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-1 py-0.5 text-left hover:bg-sunken focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
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
          <span id={ownerId}>
            <Badge tone={connection.ownerType === "org" ? "accent" : "neutral"}>{ownerLabel}</Badge>
          </span>
        </span>
        <span id={detailId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
      </button>

      <span id={statusId}>
        <DirectoryStatusPill status={deriveConnectionStatus(connection)} />
      </span>

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
