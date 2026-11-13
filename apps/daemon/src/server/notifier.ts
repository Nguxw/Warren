/** Wakes waiting event streams when the store commits. */
export class Notifier {
  private waiters = new Set<() => void>();

  notify(): void {
    const waiting = this.waiters;
    this.waiters = new Set();
    for (const wake of waiting) wake();
  }

  /** Resolves on the next notify, or after `timeoutMs`; returns whether it was notified. */
  wait(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.waiters.add(wake);
    });
  }
}
