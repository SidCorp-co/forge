import { ProjectGate } from "@/features/projects/components/project-gate";
import { Seeded } from "./vi-chrome-requirements";

// The gate every project page stands behind, while the projects load and when the slug names none.
export const SCREENS = [
  { name: "Project gate · loading", render: () => <Seeded data={[]}><ProjectGate label="Hop">{() => null}</ProjectGate></Seeded> },
  { name: "Project gate · not found", render: () => <Seeded data={[[["projects"], []]]}><ProjectGate label="Hop">{() => null}</ProjectGate></Seeded> },
];
