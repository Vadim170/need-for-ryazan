/** Fixed-timestep accumulator (Glenn Fiedler "Fix Your Timestep"). */
export class FixedTimestep {
  private acc = 0;
  /** Alpha in [0,1): how far we are between the previous and current physics states. */
  alpha = 0;

  constructor(
    public readonly step = 1 / 60,
    private readonly maxSteps = 5,
  ) {}

  /** Calls `tick(step)` zero or more times for the elapsed frame time. */
  advance(frameDt: number, tick: (dt: number) => void): void {
    this.acc += Math.min(frameDt, 0.25);
    let n = 0;
    while (this.acc >= this.step && n < this.maxSteps) {
      tick(this.step);
      this.acc -= this.step;
      n++;
    }
    if (n === this.maxSteps) this.acc = 0; // spiral of death guard
    this.alpha = this.acc / this.step;
  }
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
