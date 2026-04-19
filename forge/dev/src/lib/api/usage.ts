import type { UsageSummary, UsageRecordInput } from "../types";
import { request } from "./client";

export async function getUsageSummary(days = 7): Promise<UsageSummary> {
  return request(`/usage-records/summary?days=${days}`);
}

export async function createUsageRecord(data: UsageRecordInput): Promise<unknown> {
  return request("/usage-records", {
    method: "POST",
    body: JSON.stringify({ data }),
  });
}

export async function ingestCliUsage(): Promise<{ ingested: number; scanned: number }> {
  return request("/usage-records/ingest-cli", { method: "POST" });
}
