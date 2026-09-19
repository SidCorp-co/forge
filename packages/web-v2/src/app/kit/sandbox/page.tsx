import Link from "next/link";
import {
  Button,
  Kicker,
  PageTitle,
} from "@/design";

async function slowData() {
  await new Promise((r) => setTimeout(r, 1100));
  return { ok: true };
}

export default async function Sandbox() {
  await slowData();
  return (
    <div className="mx-auto max-w-[900px] px-6 py-10">
      <Kicker>Page load</Kicker>
      <PageTitle className="mt-1">Sandbox route</PageTitle>
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
