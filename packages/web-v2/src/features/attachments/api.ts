// The attachments feature's reads of core. An attachment's `url` is the core path core hands out
// (`/api/.../download`); it is read through the shared client so the session cookie and core's
// refusal envelope apply.
import { queryOptions } from "@tanstack/react-query";
import { apiFile } from "@/lib/api/client";

const API_PREFIX = "/api";

/** The bytes of an html attachment, as text. A url outside `/api` is refused by name. */
export async function attachmentText(url: string): Promise<string> {
  if (!url.startsWith(`${API_PREFIX}/`)) throw new Error(`attachment url is not a core path: ${url}`);
  const { blob } = await apiFile(url.slice(API_PREFIX.length));
  return await blob.text();
}

export const attachmentKeys = {
  all: ["attachments"] as const,
  html: (url: string) => [...attachmentKeys.all, "html", url] as const,
};

export const attachmentQueries = {
  html: (url: string, enabled: boolean) =>
    queryOptions({
      queryKey: attachmentKeys.html(url),
      queryFn: () => attachmentText(url),
      enabled,
      staleTime: 5 * 60 * 1000,
    }),
};
