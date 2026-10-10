
import { useQuery } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { intakeApi } from "./api";

/** The outbox's first retries land 10 to 60 s apart, so a retrying draft is read about that often. */
const RETRY_POLL_MS = 15_000;

/** The draft the intake assistant made when the item was created, read again while a retry is owed. */
export function useIntakeDraft(projectId: string | undefined, ref: string | undefined) {
  return useQuery({
    ...readOf(["intake-draft", projectId, ref], () => intakeApi.draft(projectId as string, ref as string), 10_000),
    refetchInterval: (query) => (query.state.data?.draft?.retrying ? RETRY_POLL_MS : false),
  });
}
