import type { MemoryEntry } from "@forge/contracts/memory";
import { MemoryEntryRow } from "@/features/memory/components/memory-entry";
import type { ChromeScreen } from "./vi-chrome-screens";

// The Memory page's rows for the vi walking test: one that names gone records and a release flag and
// was corrected, one a person retired, one decay archived, and an issue mirror. Fixture text is not chrome.

const AT = "2026-10-05T08:00:00.000Z";
const LAN = { id: "u1", name: "Lan", agent: false };
const BASE: MemoryEntry = {
  id: "m1",
  source: "note",
  sourceRef: "gotcha/bang-phang",
  text: "Chu du an chon bang phang (ISS-1, REQ-9).",
  writtenAt: AT,
  updatedAt: AT,
  writtenBy: { id: "a1", name: "runner", agent: true },
  verifiedAt: null,
  cites: ["ISS-1", "REQ-9"],
  staleRefs: [
    { ref: "ISS-1", kind: "issue", why: "dropped" },
    { ref: "REQ-9", kind: "requirement", why: "missing" },
  ],
  flagged: { since: AT, by: "ISS-126" },
  corrections: [{ by: LAN, at: AT, reason: "da doi chieu" }],
  retired: null,
  archivedAt: null,
  archivedBy: null,
};
const noop = () => {};
const row = (e: MemoryEntry) => <MemoryEntryRow entry={e} slug="hop" timeZone="UTC" busy={false} onCorrect={noop} onRetire={noop} />;

export const MEMORY_SCREENS: ChromeScreen[] = [
  { name: "Memory row", render: () => <ul>{row(BASE)}</ul> },
  {
    name: "Memory row, retired",
    render: () => (
      <ul>
        {row({ ...BASE, archivedAt: AT, retired: { by: LAN, at: AT, reason: "khong con dung" } })}
        {row({ ...BASE, id: "m2", archivedAt: AT, archivedBy: null, verifiedAt: AT, staleRefs: [], flagged: null })}
        {row({ ...BASE, id: "m3", source: "issue" })}
      </ul>
    ),
  },
  {
    name: "Memory row, correcting",
    render: () => <ul>{row(BASE)}</ul>,
    act: () => (document.querySelector('[data-testid="memory-entry"] button') as HTMLButtonElement | null)?.click(),
  },
];
