/** requestAnimationFrame loop; passes clamped frame dt (seconds) and total time. */
export class GameLoop {
  private last = 0;
  private running = false;
  time = 0;

  constructor(private readonly onFrame: (dt: number, time: number) => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
  }

  private tick = (now: number) => {
    if (!this.running) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += dt;
    this.onFrame(dt, this.time);
    requestAnimationFrame(this.tick);
  };
}
