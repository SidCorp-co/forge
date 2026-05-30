import { redirect } from "next/navigation";

export default function Home() {
  // Base scaffold only — the component gallery lives at /kit for now.
  redirect("/kit");
}
