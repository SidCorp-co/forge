/**
 * Client-side pre-submit validation. web-v2 carries no `zod` dependency (the
 * cold auth payload stays lean), so these are hand-rolled checks that mirror
 * the server contract just closely enough to catch obvious mistakes before the
 * round-trip. The server (`@forge/contracts` zod schemas + `core/src/auth`) is
 * always the authority — a tampered client still gets rejected there.
 */

// Pragmatic email shape — one `@`, a dot in the domain, no whitespace. Matches
// the v1 behaviour (zod `.email()`) for the cases real users hit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LoginFieldKey = 'email' | 'password';
export type LoginFieldErrors = Partial<Record<LoginFieldKey, string>>;

export function validateLogin(input: { email: string; password: string }): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  const email = input.email.trim();
  if (!email) errors.email = 'Email is required';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email';
  if (!input.password) errors.password = 'Password is required';
  return errors;
}

export type RegisterFieldKey = 'email' | 'password' | 'confirmPassword';
export type RegisterFieldErrors = Partial<Record<RegisterFieldKey, string>>;

export function validateRegister(input: {
  email: string;
  password: string;
  confirmPassword: string;
}): RegisterFieldErrors {
  const errors: RegisterFieldErrors = {};
  const email = input.email.trim();
  if (!email) errors.email = 'Email is required';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email';
  // Server enforces min 8 + a zxcvbn strength gate; mirror the length floor.
  if (input.password.length < 8) errors.password = 'At least 8 characters';
  if (!input.confirmPassword) errors.confirmPassword = 'Confirm your password';
  else if (input.password !== input.confirmPassword)
    errors.confirmPassword = 'Passwords do not match';
  return errors;
}
