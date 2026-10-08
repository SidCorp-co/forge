import { headers } from "next/headers";
import type { OperatorWhoamiResult } from "../types";
import { fetchOperatorWhoami } from "./whoami-fetch";

export async function getOperatorWhoami(): Promise<OperatorWhoamiResult> {
  return fetchOperatorWhoami((await headers()).get("cookie"));
}
