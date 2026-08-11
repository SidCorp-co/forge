import { cookies } from "next/headers";
import type { OperatorWhoamiResult } from "../types";
import { AUTH_COOKIE_NAME, fetchOperatorWhoami } from "./whoami-fetch";

// cm:guard never re-export this from features/operator/index.ts — next/headers is RSC-only and would leak into the client bundle graph
export async function getOperatorWhoami(): Promise<OperatorWhoamiResult> {
  const jar = await cookies();
  return fetchOperatorWhoami(jar.get(AUTH_COOKIE_NAME)?.value);
}
