// The one-command runner install on the pairing page opened with no code (REQ-73 BC-5): runner-install.fixture.tsx.
//
//   VITE_API_URL=https://forge.example/api pnpm --filter web-v2 witness witness/runner-install-pair.witness.tsx --out <dir>

import "./entry";
import { witnessInstallCommand } from "./runner-install.fixture";

witnessInstallCommand("pair");
