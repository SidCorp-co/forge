import { ForgeMascot } from "@/design/patterns/forge-mascot";

export interface ComingSoonProps {
  /** What this surface will be, e.g. "Activity". */
  title: string;
  /** One calm line describing what's coming. */
  message?: string;
}

/** On-brand placeholder for nav targets whose feature hasn't shipped yet — so
 *  a nav row leads somewhere intentional instead of a hard 404. */
export function ComingSoon({ title, message }: ComingSoonProps) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <ForgeMascot size={104} mode="blink" ring={false} progress={0.5} />
      <span className="fg-overline rounded-pill bg-accent-tint px-2.5 py-1 text-accent-text">
        Coming soon
      </span>
      <div>
        <p className="fg-h2">{title}</p>
        {message && <p className="fg-body-sm mx-auto mt-1.5 max-w-[340px]">{message}</p>}
      </div>
    </div>
  );
}
