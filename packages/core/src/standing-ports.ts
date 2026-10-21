// The standing read model's consumers, filled once at boot by the process entry: a note is vetted
// against the standing, and the steward's sweep reads every open standing (REQ-48 BC-8), and neither
// domain may import the read model (ADR 0008), so it is handed in here from its own face.

import { openStandings, standingOfSubject, unknownCitesIn } from './standing/index.js';
import { provideStewardStandings } from './steward/index.js';
import { provideStewardNotesPorts } from './steward-notes/index.js';

export function provideStandingPorts(): void {
  provideStewardNotesPorts({ standingOf: standingOfSubject, unknownCites: unknownCitesIn });
  provideStewardStandings(openStandings);
}
