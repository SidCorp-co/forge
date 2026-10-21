// The steward notes domain's ports, filled once at boot by the process entry: a note is vetted
// against the standing read model, which a domain may not import (ADR 0008), so it is handed in here
// from its own face.

import { standingOfSubject, unknownCitesIn } from './standing/index.js';
import { provideStewardNotesPorts } from './steward-notes/index.js';

export function provideStandingPorts(): void {
  provideStewardNotesPorts({ standingOf: standingOfSubject, unknownCites: unknownCitesIn });
}
