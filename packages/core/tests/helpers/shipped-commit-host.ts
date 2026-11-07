/**
 * The commits the shipped-commit witnesses (ISS-1079) plant, and the source host's compare over them,
 * kept apart from the world so a test's `vi.mock` factory can import them without the database.
 */

/** ISS-11's landing on `release/stg`, and the commit release 0.16.0 shipped and production serves. */
export const LANDING = '7b42608aa1d4e5f60718293a4b5c6d7e8f90a1b0';
export const SHIPPED = '62a4ac7cb007502d7285874fe8e6e13337b74f94';
/** "release 0.16.0: admin-ui/VERSION": the commit the finish named, which SHIPPED descends from. */
export const NAMED = '6118831f8ddde29e764e536dcc3779cba0b5bcad';
/** A commit on another line, which holds no landing. */
export const ELSEWHERE = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
export const PRODUCTION_PROBE = 'https://mail.example.test/api/version';

/** The source host's compare: SHIPPED holds LANDING and NAMED; nothing else holds anything. */
export const hostCompare = async (base: string, head: string) =>
  [LANDING, NAMED].includes(base.toLowerCase()) && head.toLowerCase() === SHIPPED
    ? 'ahead'
    : 'diverged';
