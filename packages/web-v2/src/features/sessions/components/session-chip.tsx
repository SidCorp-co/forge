import { StatusChip, type StatusChipProps, WORKING_WORD } from "@/design";

/** A session's status chip on every screen: a running one is called Working, as on the Pipeline page. */
export function SessionChip(props: Omit<StatusChipProps, "domain" | "label">) {
  return (
    <StatusChip
      {...props}
      domain="session"
      {...(props.status === "running" ? { label: WORKING_WORD } : {})}
    />
  );
}
