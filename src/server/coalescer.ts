/**
 * Runs `fire` at most once per `gapMs`. A request fires on the next turn of the event loop
 * (so a synchronous burst folds into one), or — inside the gap — a full gap after the
 * previous fire.
 *
 * Node timers can wake a few ms before their delay by `now()`'s clock (libuv measures from a
 * loop time cached at the start of the iteration, which lags under load), so a woken timer
 * re-checks and sleeps the remainder rather than firing early. Rate limits in the protocol
 * (≤ 10 patches/s, ≤ 1 session list/s, ≤ 20 run events/s) hold exactly.
 */
export class Coalescer {
  private last = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gapMs: number,
    private readonly fire: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  request(): void {
    if (this.timer) return;
    this.arm(Math.max(0, this.last + this.gapMs - this.now()));
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      const wait = this.last + this.gapMs - this.now();
      if (wait > 0) this.arm(wait);
      else this.run();
    }, ms);
  }

  private run(): void {
    this.last = this.now();
    this.fire();
  }
}
