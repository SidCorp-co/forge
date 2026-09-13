import Link from "next/link";
import { Button, Kicker } from "@/design";

// cm:guard the delay is the point — without it neither this route's loading.tsx (Suspense) nor the top RouteProgress bar is demonstrable when navigating here from /kit
async function slowData() {
  await new Promise((r) => setTimeout(r, 1100));
  return { ok: true };
}

export default async function Sandbox() {
  await slowData();
  return (
    <div className="mx-auto max-w-[900px] px-6 py-10">
      <Kicker>Page load</Kicker>
      <h1 className="fg-h1 mt-1">Sandbox route</h1>
      <p className="fg-body-sm mt-1">
        This is a real async route. Getting here showed the top progress bar, the Suspense
        skeleton (loading.tsx), and the page enter transition.
      </p>
      <div className="mt-6">
        <Link href="/kit">
          <Button variant="secondary" icon="arrowRight">Back to kit</Button>
        </Link>
      </div>
    </div>
  );
}
