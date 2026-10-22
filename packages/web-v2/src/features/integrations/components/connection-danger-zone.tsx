"use client";

import { useState } from "react";
import { Button, CardTitle } from "@/design";
import { useRemoveConnection, useUpdateConnection } from "../hooks";
import { providerModule } from "../providers/registry";
import type { ConnectionSummary } from "../types";

/** A connection a remove left behind: switched off, with no key on it. */
export function isRemovedConnection(connection: ConnectionSummary): boolean {
  return !connection.active && !connection.hasSecrets;
}

/** Names as a sentence says them: "or" where any one of them does, "and" where it is each of them. */
function listed(names: string[], joined: "or" | "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${joined} ${names[names.length - 1]}`;
}

/**
 * What turns a removed connection back on, said only where it is true (ISS-1421 r21): a key saved
 * above for a provider that takes one; for GitHub, a fresh App install from a project still bound to
 * it, which core turns into this connection again; otherwise nothing, and the line says so.
 */
export function turnsBackOn(connection: ConnectionSummary, boundProjects: string[] | null): string {
  if (providerModule(connection.provider)?.secretField !== null)
    return "This connection holds no key. Saving a new key above turns it back on.";
  // Unread is not none: which projects are bound decides what turns it on, so nothing is claimed yet.
  if (boundProjects === null)
    return "This connection holds no key. What turns it back on is said once its projects are read.";
  if (boundProjects.length > 0)
    return `This connection holds no key. Installing the GitHub App again from the Integrations tab of ${listed(boundProjects, "or")} turns it back on.`;
  return "This connection holds no key and no project is bound to it, so nothing can turn it back on. Clear it from the list.";
}

/** Disable/Enable + Remove with an inline confirm listing affected projects (AC5); Clear once removed. */
export function DangerZone({
  connection,
  affectedProjects,
  boundProjects,
  onRemoved,
}: {
  connection: ConnectionSummary;
  affectedProjects: string[];
  /** Every project bound to this connection, by name, its binding on or off; null until they are read. */
  boundProjects: string[] | null;
  onRemoved: () => void;
}) {
  const update = useUpdateConnection();
  const remove = useRemoveConnection();
  const [confirming, setConfirming] = useState(false);
  const removed = isRemovedConnection(connection);

  return (
    <section className="flex flex-col gap-3">
      <CardTitle>Danger zone</CardTitle>
      <div className="flex flex-wrap items-center gap-2">
        {connection.active ? (
          <Button
            variant="ghost"
            size="sm"
            loading={update.isPending}
            onClick={() => update.mutate({ id: connection.id, body: { active: false } })}
          >
            Disable
          </Button>
        ) : connection.hasSecrets ? (
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            onClick={() => update.mutate({ id: connection.id, body: { active: true } })}
          >
            Enable
          </Button>
        ) : (
          // Core refuses to turn a keyless connection back on (CONNECTION_HAS_NO_KEY).
          <span className="fg-body-sm text-muted">{turnsBackOn(connection, boundProjects)}</span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={removed && boundProjects === null}
          onClick={() => setConfirming((v) => !v)}
        >
          {removed ? "Clear from list…" : "Remove…"}
        </Button>
      </div>
      {confirming && (
        <div className="flex flex-col gap-2 border-y border-line py-2.5">
          <p className="fg-body-sm text-fg">
            {removed
              ? `Clearing this connection deletes it for good${boundProjects?.length ? `, with its ${boundProjects.length > 1 ? "bindings" : "binding"} to ${listed(boundProjects, "and")}` : ""}.`
              : `${
                  affectedProjects.length > 0
                    ? `Removing this connection stops credential resolution for ${affectedProjects.length} project${affectedProjects.length === 1 ? "" : "s"}: ${affectedProjects.join(", ")}. Their integrations stop working on the next dispatch.`
                    : "No projects are actively using this connection."
                } Removing it deletes its stored keys, and the connection stays listed as Turned off until it is cleared.`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate(connection.id, { onSuccess: onRemoved })}
            >
              {removed ? "Clear connection" : "Remove connection"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
