import { WHATS_NEW_SEEN_KEY } from "@forge/contracts/product-state";
import { apiClient } from "@/lib/api/client";
import type { ProductStateView, WhatsNewFeed } from "./types";

export const whatsNewApi = {
  /** `GET /api/me/whats-new` — Forge's own released changes, grouped by day in `tz`. */
  feed: (tz: string) => apiClient<WhatsNewFeed>(`/me/whats-new?tz=${encodeURIComponent(tz)}`),

  /** Move the reader's seen mark to `at`: entries released before it stop being unread. */
  markSeen: (at: Date) =>
    apiClient<ProductStateView>(`/me/product-state/${WHATS_NEW_SEEN_KEY}`, {
      method: "PUT",
      body: JSON.stringify({ value: { at: at.toISOString() } }),
    }),
};
