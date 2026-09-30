const POSITIVE_WHOLE = /^[1-9][0-9]*$/;

/** VITEST_MAX_WORKERS as a count, or refused by name: vitest would `parseInt` it unsaid. */
export function workerOverride(env, config) {
  const value = env.VITEST_MAX_WORKERS;
  if (value === undefined || value === '') return undefined;
  if (!POSITIVE_WHOLE.test(value)) {
    throw new Error(
      `VITEST_MAX_WORKERS="${value}" is not a worker count for ${config}. It takes a positive ` +
        'whole number such as 4, or is left unset so the machine this run is on decides.',
    );
  }
  return Number(value);
}
