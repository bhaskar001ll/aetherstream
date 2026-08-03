/**
 * When to show, and re-show, the receiver's "nothing is decoding" hint.
 *
 * Pure timing policy with no DOM in it: the rules are the part that can be
 * wrong, and the panel itself is a handful of createElement calls.
 *
 * The rules:
 * - The countdown starts when the camera does.
 * - Dismissing the hint only restarts the countdown. Tapping a button does not
 *   make frames start arriving, so if the transfer is still dead a moment later
 *   the advice is still the advice.
 * - The first frame that parses ends it for good, dismissed or not. That is the
 *   only event that actually means the link is working.
 */
export class NoSignalHintTimer {
  // `armed` is a separate flag rather than `armedAt === 0` meaning "not
  // started": zero is a perfectly legal timestamp, and overloading it makes the
  // timer silently dead for any clock that happens to start there.
  private armed = false;
  private armedAt = 0;
  private visible = false;
  private sawFrame = false;

  constructor(private readonly delayMs: number) {}

  get isVisible(): boolean {
    return this.visible;
  }

  /** The camera is live. Starts the first countdown. */
  cameraStarted(now: number): void {
    if (this.sawFrame) return;
    this.armed = true;
    this.armedAt = now;
    this.visible = false;
  }

  /**
   * Advance the clock. True exactly once per countdown, at the moment the hint
   * should go on screen — the caller renders it and is not told again until the
   * user dismisses it and another delay passes.
   */
  tick(now: number): boolean {
    if (!this.armed || this.visible || this.sawFrame) return false;
    if (now - this.armedAt <= this.delayMs) return false;
    this.visible = true;
    return true;
  }

  /** The user dismissed it. Off screen, but the countdown restarts. */
  dismiss(now: number): void {
    this.visible = false;
    this.armedAt = now;
  }

  /** A frame parsed. Returns whether the hint was on screen and needs removing. */
  frameDecoded(): boolean {
    const wasVisible = this.visible;
    this.sawFrame = true;
    this.armed = false;
    this.visible = false;
    return wasVisible;
  }
}
