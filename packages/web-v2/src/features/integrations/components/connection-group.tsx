"use client";

// One app's section of the connections directory (ISS-1035).
//
// The header is what an operator decides on while the section is shut, so it
// carries the app's name and the three numbers that settle "do I need to open
// this": how many credentials, how many want attention, how many are off.

import { Card, Icon } from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { type ConnectionGroup, groupSummary } from "../connection-groups";
import { PROVIDER_ICON } from "./status-pill";
import { ConnectionRow } from "./connection-row";

export function ConnectionGroupSection({
  group,
  open,
  onToggle,
  ownerLabel,
  projectName,
  onOpenConnection,
}: {
  group: ConnectionGroup;
  open: boolean;
  onToggle: () => void;
  ownerLabel: (connection: ConnectionDirectoryItem) => string;
  projectName: (id: string) => string;
  onOpenConnection: (id: string) => void;
}) {
  const rowsId = `connections-${group.provider}`;
  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={rowsId}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <Icon
          name="chevronRight"
          size={16}
          className="shrink-0 text-subtle transition-transform duration-[150ms]"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <Icon
          name={PROVIDER_ICON[group.provider] ?? "link"}
          size={18}
          className="shrink-0 text-muted"
        />
        <span className="fg-h3">{group.label}</span>
        <span className="fg-body-sm text-muted">{groupSummary(group)}</span>
      </button>
      {open && (
        <div id={rowsId} className="forge-fade">
          {group.connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              ownerLabel={ownerLabel(c)}
              projectName={projectName}
              onOpen={() => onOpenConnection(c.id)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
