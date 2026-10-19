/** Why a test credential row may not be stored. Core's write door and the settings form refuse alike. */
export type CredentialRule = 'password-required' | 'duplicate-label' | 'duplicate-login';

export interface CredentialFinding {
  index: number;
  field: 'label' | 'username' | 'password';
  rule: CredentialRule;
  sameAs?: number;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A login carries a password, no two share a label, and one username and password is listed once. */
export function findCredentialFaults(rows: readonly unknown[]): CredentialFinding[] {
  const found: CredentialFinding[] = [];
  const labels = new Map<string, number>();
  const logins = new Map<string, number>();
  rows.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const row = raw as Record<string, unknown>;
    const label = text(row.label).trim().toLowerCase();
    if (label === '') return;
    const password = text(row.password);
    const labelled = labels.get(label);
    if (labelled === undefined) labels.set(label, index);
    else found.push({ index, field: 'label', rule: 'duplicate-label', sameAs: labelled });
    if (password.trim() === '') {
      found.push({ index, field: 'password', rule: 'password-required' });
      return;
    }
    const login = `${text(row.username).trim().toLowerCase()}\0${password}`;
    const listed = logins.get(login);
    if (listed === undefined) logins.set(login, index);
    else found.push({ index, field: 'username', rule: 'duplicate-login', sameAs: listed });
  });
  return found;
}
