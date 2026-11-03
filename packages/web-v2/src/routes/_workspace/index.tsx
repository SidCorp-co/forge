import { createFileRoute } from "@tanstack/react-router";
import { HomeScreen } from "@/features/overview";

function HomePage() {
  return <HomeScreen />;
}

export const Route = createFileRoute("/_workspace/")({ component: HomePage });
