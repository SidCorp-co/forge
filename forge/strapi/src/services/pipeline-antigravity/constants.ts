import { sleep } from '../pipeline-utils';

export const RUNNER_UID = 'api::antigravity-runner.antigravity-runner' as any;

/** Max time to wait for Antigravity before giving up (ms). Matches timeoutSeconds=1800. */
export const POLL_TIMEOUT = 30 * 60 * 1000;
/** Max consecutive poll failures before aborting. Tolerates transient network errors. */
export const MAX_POLL_ERRORS = 5;
/** Backoff multiplier for consecutive poll errors (ms). */
export const POLL_ERROR_BACKOFF_BASE = 2000;
/**
 * Detect quota/rate-limit exhaustion in error messages (NOT agent response text).
 * Used for status.error, HTTP error bodies, and thrown exceptions.
 */
export const QUOTA_ERROR_PATTERN = /quota.*exhaust|token limit.*reached|credit.*exhaust|out of.*quota|billing.*limit|exceeded.*quota|quota.*exceeded|model quota reached/i;

/**
 * Detect quota exhaustion in agent response text (streamed output).
 * Must be strict — agent output may discuss quota/rate-limit concepts in code or comments.
 * Only matches the exact Antigravity system message, not code discussion.
 */
export const QUOTA_RESPONSE_PATTERN = /^Model quota reached$/m;

/** Adaptive poll interval tiers (ms). Escalates when status is unchanged, resets on state change. */
export const POLL_BACKOFF_TIERS = [3000, 5000, 10000, 30000];

/** Detect transient server overload (429 / 529 / high traffic). Retryable, NOT a quota error. */
export const HIGH_TRAFFIC_PATTERN = /high traffic|try again in a minute|429|529|overloaded/i;
/** Max retries for transient high-traffic errors before giving up. */
export const HIGH_TRAFFIC_MAX_RETRIES = 3;
/** Base delay between high-traffic retries (ms). Doubles each attempt. */
export const HIGH_TRAFFIC_RETRY_DELAY = 15_000;
/** Duration to disable the runner after high-traffic retries are exhausted (ms). */
export const HIGH_TRAFFIC_DISABLE_MS = 5 * 60 * 1000;
/** Duration to disable the runner when a "Completed" response contains high-traffic text (ms). */
export const HIGH_TRAFFIC_COMPLETED_DISABLE_MS = 5 * 60 * 1000;

/** Minimum gap between requests to the same runner (ms). Prevents 429 bursts after quota reset. */
export const RUNNER_REQUEST_GAP = 10_000;
/** Tracks last request timestamp per runner. */
export const lastRunnerRequest = new Map<string, number>();

/** Wait if needed to maintain RUNNER_REQUEST_GAP between requests to the same runner. */
export async function throttleRunner(runnerId: string): Promise<void> {
    const last = lastRunnerRequest.get(runnerId) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < RUNNER_REQUEST_GAP) {
        const wait = RUNNER_REQUEST_GAP - elapsed;
        strapi.log.debug(`[pipeline] Throttling runner ${runnerId}: waiting ${wait}ms`);
        await sleep(wait);
    }
    lastRunnerRequest.set(runnerId, Date.now());
}
