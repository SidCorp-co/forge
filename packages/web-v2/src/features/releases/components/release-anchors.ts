// Where each group of a release page sits (its anchor), what it is called, and what a reader of the
// page can reach from a row: shared by the reader and the groups it draws.

import type { ReleaseChangeGroup } from "@forge/contracts/release-digest";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export const ANCHOR = {
  highlights: "release-highlights",
  new: "release-new",
  improved: "release-improved",
  fixed: "release-fixed",
  security: "release-security",
  requirements: "release-requirements",
  open: "release-open",
  other: "release-other",
  admin: "release-admin",
  technical: "release-technical",
} as const;
export type Anchor = keyof typeof ANCHOR;

export const GROUP_TITLE: Record<ReleaseChangeGroup | "requirements" | "open" | "other" | "admin" | "technical", ProductCopyKey> = {
  new: "releases.page.group.new",
  improved: "releases.page.group.improved",
  fixed: "releases.page.group.fixed",
  security: "releases.page.group.security",
  requirements: "releases.page.group.requirements",
  open: "releases.page.group.open",
  other: "releases.page.group.other",
  admin: "releases.page.group.admin",
  technical: "releases.page.group.technical",
};

/** What the reader can reach from a row: the project's pages in the app, nothing on a share. */
export interface Reach {
  slug?: string | undefined;
  authed: boolean;
}
