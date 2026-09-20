/**
 * How long a session may go silent before core stops believing it.
 *
 * There used to be two numbers. `MASTER_HOLD_TIMEOUT_MS` was three minutes and
 * returned a master's job holds; `RUN_SESSION_TIMEOUT_MS` was ten and returned
 * a run's issue leases. Neither reaper could name a child, so between the two a
 * master was gone while the runs it started still held work for another seven
 * minutes — and nothing in either query could see that.
 *
 * One number, and it is the LONGER one. A hold returned late costs a delay; a
 * lease returned early costs two boxes on one issue, and only the second makes
 * the state lie. The price of the merge is that a dead master's holds now sit
 * in the pool for up to ten minutes rather than three — paid back by the
 * daemon's own socket-drop path, which releases them the moment it notices and
 * does not wait for this clock at all.
 *
 * ISS-1136. Changing this changes when work is reclaimed on both axes at once,
 * which is the point; the condition that would end the merge is a measurement
 * of how long a healthy master's heartbeat actually goes quiet under load,
 * which nobody has taken.
 */
export const SESSION_SILENCE_TIMEOUT_MS = 10 * 60 * 1000;

/** The same window in whole seconds, which is what `make_interval` takes. */
export const SESSION_SILENCE_TIMEOUT_S = Math.floor(SESSION_SILENCE_TIMEOUT_MS / 1000);
