import cronParser from 'cron-parser';

export interface CronValidationResult {
  ok: boolean;
  error?: string;
  nextRunAt?: Date;
}

const MIN_INTERVAL_MS = 60 * 60 * 1000;

function nextDate(interval: ReturnType<typeof cronParser.parseExpression>): Date {
  const result = interval.next() as unknown as { toDate(): Date };
  return result.toDate();
}

export function validateCron(cron: string): CronValidationResult {
  let interval: ReturnType<typeof cronParser.parseExpression>;
  try {
    interval = cronParser.parseExpression(cron);
  } catch {
    return { ok: false, error: 'Invalid cron expression' };
  }
  const t1 = nextDate(interval).getTime();
  const t2 = nextDate(interval).getTime();
  const diffMs = t2 - t1;
  if (diffMs < MIN_INTERVAL_MS) {
    return {
      ok: false,
      error: `Minimum schedule interval is 1 hour. This cron runs every ${Math.round(
        diffMs / 60_000,
      )} minutes.`,
    };
  }
  return { ok: true };
}

export function nextRunFor(cron: string, fromDate: Date = new Date()): Date | null {
  try {
    const interval = cronParser.parseExpression(cron, { currentDate: fromDate });
    return nextDate(interval);
  } catch {
    return null;
  }
}
