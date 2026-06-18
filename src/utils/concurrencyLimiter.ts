/**
 * In-process semaphore-based concurrency limiter with FIFO queue and AbortSignal support.
 */

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  abortMessage?: string;
  cleanup?: () => void;
}

export class ConcurrencyLimiter {
  private _maxConcurrency: number;
  private _active = 0;
  private _queue: Waiter[] = [];

  constructor(maxConcurrency: number) {
    this._maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
  }

  get active(): number {
    return this._active;
  }

  get pending(): number {
    return this._queue.length;
  }

  async acquire(signal?: AbortSignal, abortMessage = 'Aborted'): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error(abortMessage));
    }

    if (this._active < this._maxConcurrency) {
      this._active++;
      return this.makeRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, abortMessage };

      if (signal) {
        waiter.signal = signal;
        const onAbort = () => {
          this._queue = this._queue.filter((w) => w !== waiter);
          reject(new Error(abortMessage));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      this._queue.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      this._active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this._active < this._maxConcurrency && this._queue.length > 0) {
      const waiter = this._queue.shift();
      if (!waiter) continue;

      if (waiter.signal?.aborted) {
        waiter.reject(new Error(waiter.abortMessage ?? 'Aborted'));
        continue;
      }

      const release = this.makeRelease();
      waiter.cleanup?.();
      this._active++;
      waiter.resolve(release);
    }
  }
}
