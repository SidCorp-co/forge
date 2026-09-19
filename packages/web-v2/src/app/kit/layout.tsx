import { notFound } from "next/navigation";

export default function KitLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return <>{children}</>;
}
