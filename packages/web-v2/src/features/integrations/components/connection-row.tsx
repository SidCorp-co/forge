"use client";


import { useId, useState } from "react";
import { Badge, Button, Icon } from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { formatRelativeTime } from "@/lib/utils/format";
import { readOnlyNote } from "../connection-space";
import { useCanManageConnection, useRemoveConnection, useUpdateConnection } from "../hooks";
import { connectionName, connectionTarget, connectionTitle } from "../connection-identity";
import { deriveConnectionStatus } from "../derive";
import { providerIcon, providerLabel as labelFor } from "../providers/registry";
import { isRemovedConnection } from "./connection-danger-zone";
import { DirectoryStatusPill, scopeLabel } from "./status-pill";
import { healthLine } from "@forge/contracts/health-words";

/** Projects a connection is bound to, named — the line that tells two credentials apart. */
function UsageLine({
  connection,
  projectName,
  emptyId,
}: {
  connection: ConnectionDirectoryItem;
  projectName: (id: string) => string;
  /** Named by the row button's description: the chips are in its NAME, this is not. */
  emptyId: string;
}) {
  const bindings = connection.usage.bindings;
  if (bindings.length === 0) {
    // A removed connection cannot be shared (ISS-1421 r22), so the row does not suggest it.
    return (
      <span id={emptyId} className="fg-body-sm text-subtle">
        {isRemovedConnection(connection)
          ? "Not used by any project."
          : "Not used by any project — share it from a project's settings → Integrations."}
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
          <span className="text-subtle">{scopeLabel(b.role, b.stages)}</span>
          {!b.active && <span className="text-subtle">· off</span>}
        </span>
      ))}
    </>
  );
}

export function connectionRowLabel(
  connection: ConnectionDirectoryItem,
  projectName: (id: string) => string,
  title: string = connectionTitle(connection),
): string {
  const parts = [`Manage connection ${title}`];
  // The same condition the visible provider pill renders under: two credentials
  // an operator called "Production", one Coolify and one GitHub, are told apart
  // on screen by that pill and by nothing else.
  const providerLabel = labelFor(connection.provider);
  if (title !== providerLabel) parts.push(providerLabel);
  const target = connectionTarget(connection);
  if (target && !title.startsWith(target)) parts.push(target);
  // Independent of the target rather than a fallback for it: two deploy tokens
  // against ONE endpoint, told apart on screen by the projects bound to them,
  // would otherwise reach the same name through the branch that already found
  // a target.
  if (connection.usage.bindings.length > 0) {
    const used = connection.usage.bindings.map((b) => {
      const scope = scopeLabel(b.role, b.stages);
      return `${projectName(b.projectId)} ${scope}${b.active ? "" : " (off)"}`;
    });
    parts.push(`used by ${used.join(", ")}`);
  }
  return parts.join(" — ");
}

function RemoveButton({ connection }: { connection: ConnectionDirectoryItem }) {
  const remove = useRemoveConnection();
  const count = connection.usage.bindings.length;
  // A removed connection holds no key; a second delete clears it from the list (ISS-1421 r21).
  const removed = isRemovedConnection(connection);
  // The question is armed for the state it was asked about: a Delete accepted under it turned the
  // row into a removed one with the Clear question already open, one click from deleting it for good
  // (ISS-1421 r26).
  const [armedFor, setArmedFor] = useState<boolean | null>(null);
  const armed = armedFor === removed;
  const setArmed = (on: boolean) => setArmedFor(on ? removed : null);

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
        {removed ? "Clear" : "Remove"}
      </Button>
    );
  }
  // Wraps inside the row: unwrapped, Cancel ran past a 390 screen (ISS-1421 r22).
  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <span className="fg-body-sm min-w-0 text-muted">
        {removed
          ? count > 0
            ? `Delete it for good, with its ${count} project binding${count > 1 ? "s" : ""}?`
            : "Delete it for good?"
          : count > 0
            ? `Disconnects ${count} project${count > 1 ? "s" : ""}.`
            : "Delete it?"}
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
        {removed ? "Clear" : "Delete"}
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

export function ConnectionRow({
  connection,
  title = connectionTitle(connection),
  ownerLabel,
  projectName,
  onOpen,
}: {
  connection: ConnectionDirectoryItem;
  /** The name its section gives it by the share picker's rule (`connectionLabels`), so two
   *  connections to one host never read alike (ISS-1421 r8, criterion 129). */
  title?: string;
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
  const usageEmptyId = useId();
  const healthId = useId();
  const statusId = useId();
  const checked = formatRelativeTime(connection.lastHealthAt);
  // A title that already names what the connection points at is not repeated on the line below.
  const named = connectionName(connection) ? connectionTarget(connection) : null;
  const target = named && !title.startsWith(named) ? named : null;
  const providerLabel = labelFor(connection.provider);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-subtle px-3 py-2">
      <button
        type="button"
        aria-label={connectionRowLabel(connection, projectName, title)}
        aria-describedby={[
          ownerId,
          // Only when it renders: an id naming no element is ignored by the
          // spec, but the header beside this one refuses a dangling reference
          // and two rules in one file is one rule nobody can state.
          connection.usage.bindings.length === 0 ? usageEmptyId : null,
          healthId,
          statusId,
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={onOpen}
        className="-mx-1 flex min-w-[220px] flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-1 py-0.5 text-left hover:bg-sunken focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Icon
            name={providerIcon(connection.provider)}
            size={16}
            className="shrink-0 text-muted"
          />
          {/* Wrapped, never cut: the end of a title is what tells two alike connections apart. */}
          <span className="fg-label min-w-0 break-words" data-testid="connection-title">
            {title}
          </span>
          {!title.startsWith(providerLabel) && (
            <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
              {providerLabel}
            </span>
          )}
          <span id={ownerId}>
            <Badge tone={connection.ownerType === "org" ? "accent" : "neutral"}>{ownerLabel}</Badge>
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {target && (
            <span className="fg-body-sm truncate font-mono text-muted" title={target}>
              {target}
            </span>
          )}
          <UsageLine connection={connection} projectName={projectName} emptyId={usageEmptyId} />
          <span id={healthId} className="fg-body-sm text-subtle">
            {healthLine(connection.lastHealthStatus, checked)}
            {!connection.hasSecrets && " No credential is stored."}
          </span>
        </span>
      </button>

      <span id={statusId}>
        <DirectoryStatusPill status={deriveConnectionStatus(connection)} />
      </span>

      <span className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-1">
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
            ) : connection.hasSecrets ? (
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
            ) : null}
            <RemoveButton connection={connection} />
          </>
        ) : (
          <span className="fg-body-sm text-subtle">{readOnlyNote(connection, ownerLabel)}</span>
        )}
      </span>
    </div>
  );
}
