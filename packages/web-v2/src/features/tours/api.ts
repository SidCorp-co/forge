import type { ProductStateListResponse, ProductStateView, TourStateValue } from "@forge/contracts/product-state";
import type { TourEventRequest } from "@forge/contracts/tours";
import { apiClient } from "@/lib/api/client";
import { tourKey } from "./state";

export const toursApi = {
  /** `GET /api/me/product-state` — every key the person holds, tours among them. */
  states: () => apiClient<ProductStateListResponse>("/me/product-state"),

  save: (id: string, value: TourStateValue) =>
    apiClient<ProductStateView>(`/me/product-state/${tourKey(id)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),

  record: (event: TourEventRequest) =>
    apiClient<{ act: string; id: string }>("/me/tour-events", { method: "POST", body: JSON.stringify(event) }),
};
