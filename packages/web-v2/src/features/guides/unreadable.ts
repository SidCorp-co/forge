import { GuideFetchError } from "./api";

/** `read`'s answer, or `null` where core's answer could not be read, said on the server log. */
export async function orUnreadable<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (cause) {
    if (!(cause instanceof GuideFetchError)) throw cause;
    console.error(`public docs: ${cause.message}`);
    return null;
  }
}
