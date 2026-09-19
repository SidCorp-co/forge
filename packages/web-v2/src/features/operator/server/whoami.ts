import { cookies } from "next/headers";
import type { OperatorWhoamiResult } from "../types";
import { AUTH_COOKIE_NAME, fetchOperatorWhoami } from "./whoami-fetch";

export async function getOperatorWhoami(): Promise<OperatorWhoamiResult> {
  const jar = await cookies();
  return fetchOperatorWhoami(jar.get(AUTH_COOKIE_NAME)?.value);
}
