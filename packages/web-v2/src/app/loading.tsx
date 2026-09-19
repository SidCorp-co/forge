import { ColdBoot } from "@/design/patterns/mascot-loaders";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app">
      <ColdBoot />
    </div>
  );
}
