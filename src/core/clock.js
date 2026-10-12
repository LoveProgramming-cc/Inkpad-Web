// @ts-check
// The only two clocks in the project (PORTING.md R8).
//   now():  wall-clock time in SECONDS, as a float. Every `mt`, `ts`, `order_mt`, `last` and
//           `checked` in files and in the cloud index is in seconds.
//   mono(): monotonic time in MILLISECONDS, for intervals and delays. B's thresholds are in
//           microseconds (GLib), so convert when translating.

/** @type {(() => number) | null} */
let override = null;

/** Replace the wall clock (tests). Pass null to restore. @param {(() => number) | null} fn seconds */
export function setNow(fn) { override = fn; }

let last = 0;

/** Never returns the same time twice: Date has millisecond resolution, Python's time.time() (which
 * B's "newer one wins" comparisons were written for) has microseconds. */
export function now() {
  if (override) return override();
  last = Math.max(Date.now() / 1000, last + 1e-6);
  return last;
}

export function mono() { return performance.now(); }
