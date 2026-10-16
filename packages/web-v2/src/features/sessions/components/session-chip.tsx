import { BLOCKED_WORD, StatusChip, type StatusChipProps, WORKING_WORD } from "@/design";

const SESSION_WORD: Partial<Record<StatusChipProps["status"], string>> = {
  running: WORKING_WORD,
  blocked: BLOCKED_WORD,
};

/** A session's status chip on every screen, in the Pipeline page's words. */
export function SessionChip(props: Omit<StatusChipProps, "domain" | "label">) {
  const word = SESSION_WORD[props.status];
  return <StatusChip {...props} domain="session" {...(word ? { label: word } : {})} />;
}
