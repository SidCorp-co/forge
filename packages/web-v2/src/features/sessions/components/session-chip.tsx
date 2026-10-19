import { BLOCKED_WORD, StatusChip, type StatusChipProps, WORKING_WORD } from "@/design";
import { type SessionWordInput, sessionWord } from "../session-word";

const SESSION_WORD: Partial<Record<StatusChipProps["status"], string>> = {
  running: WORKING_WORD,
  blocked: BLOCKED_WORD,
};

export interface SessionChipProps extends Omit<StatusChipProps, "domain" | "label"> {
  session?: SessionWordInput;
  now?: number;
}

/** A session's chip on every screen: `sessionWord`'s word while it is heard from, else Quiet. */
export function SessionChip({ session, now, ...props }: SessionChipProps) {
  const word = session ? sessionWord(session, now ?? Date.now()) : null;
  const heard = word && !word.quiet ? word : null;
  const label = heard ? heard.label : SESSION_WORD[props.status];
  return (
    <StatusChip
      {...props}
      domain="session"
      {...(label ? { label } : {})}
      {...(heard ? { icon: heard.icon } : {})}
    />
  );
}
