import { apiClient } from "@/lib/api/client";
import type { OperatorWhoami } from "./types";

export const operatorApi = {
  whoami: () => apiClient<OperatorWhoami>("/admin/whoami"),
};
