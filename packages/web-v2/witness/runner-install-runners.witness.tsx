// The one-command runner install on the Runners page (REQ-73 BC-5): runner-install.fixture.tsx.
//
//   VITE_API_URL=https://forge.example/api pnpm --filter web-v2 witness witness/runner-install-runners.witness.tsx --out <dir>

import "./entry";
import { witnessInstallCommand } from "./runner-install.fixture";

witnessInstallCommand("runners");
