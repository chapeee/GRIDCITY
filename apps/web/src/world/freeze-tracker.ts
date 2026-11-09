/**
 * Remembers the shader time at which each host's motion froze, so towers and
 * particles hold exactly the frame they froze on (no motion at all while
 * stale or offline) and resume smoothly when data returns.
 *
 * Shared by several components; calls with the same arguments are idempotent.
 */
export class FreezeTracker {
  private readonly frozenAt = new Map<string, number>();

  /** Returns the freeze time for a frozen host, or -1 when it is live. */
  update(hostId: string, frozen: boolean, shaderTime: number): number {
    if (!frozen) {
      this.frozenAt.delete(hostId);
      return -1;
    }
    let time = this.frozenAt.get(hostId);
    if (time === undefined) {
      time = shaderTime;
      this.frozenAt.set(hostId, time);
    }
    return time;
  }
}
