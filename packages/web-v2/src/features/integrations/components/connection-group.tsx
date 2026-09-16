"use client";

// One app's section of the connections directory (ISS-1035).
//
// The header is what an operator decides on while the section is shut, so it
// carries the app's name and the three numbers that settle "do I need to open
// this": how many credentials, how many want attention, how many are off.

import { Card, Icon } from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { type ConnectionGroup, groupSummary } from "../connection-groups";
import { providerIcon } from "../providers/registry";
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
      {/* The button sits INSIDE the heading rather than beside it: the apps are
          this page's grouping, so they have to be reachable by heading
          navigation, and a disclosure whose control is the heading's only child
          keeps one control per section rather than a label and a button. `h2`
          because the page's own title is the `h1`. */}
      <h2 className="fg-h3">
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
            name={providerIcon(group.provider)}
            size={18}
            className="shrink-0 text-muted"
          />
          <span>{group.label}</span>
          <span className="fg-body-sm font-normal text-muted">{groupSummary(group)}</span>
        </button>
      </h2>
      {/* The container the header's aria-controls names exists while the
          section is shut too — a disclosure pointing at nothing is a dangling
          reference assistive technology cannot follow — and `hidden` is what
          keeps an empty one out of the tree rather than exposing a region with
          nothing in it. */}
      <div id={rowsId} hidden={!open} className={open ? "forge-fade" : undefined}>
        {open &&
          group.connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              ownerLabel={ownerLabel(c)}
              projectName={projectName}
              onOpen={() => onOpenConnection(c.id)}
            />
          ))}
      </div>
    </Card>
  );
}
