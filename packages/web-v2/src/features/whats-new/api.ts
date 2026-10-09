import { WHATS_NEW_SEEN_KEY } from "@forge/contracts/product-state";
import { apiClient } from "@/lib/api/client";
import type { ProductStateView, WhatsNewFeed, WhatsNewSummary } from "./types";

/** The release a person closed What's new on, and the environment that served it. */
export interface SeenRelease {
  environment: string;
  version: string;
}

export const whatsNewApi = {
  /** `GET /api/me/whats-new/summary` — whether the serving release is owed, read on every page load. */
  summary: () => apiClient<WhatsNewSummary>("/me/whats-new/summary"),

  /** `GET /api/me/whats-new` — the release this instance serves, read when the panel opens. */
  feed: () => apiClient<WhatsNewFeed>("/me/whats-new"),

  /** Close What's new on `release`: the seen mark names it, so core stops owing it to this person. */
  markSeen: (release: SeenRelease, at: Date) =>
    apiClient<ProductStateView>(`/me/product-state/${WHATS_NEW_SEEN_KEY}`, {
      method: "PUT",
      body: JSON.stringify({ value: { at: at.toISOString(), release: { ...release, at: at.toISOString() } } }),
    }),
};
