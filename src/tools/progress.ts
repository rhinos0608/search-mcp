/**
 * MCP-native progress notification helpers.
 *
 * Tools use `createProgressReporter` when the client provides a `progressToken`
 * in `_meta`.  If no token is present, `update()` and `done()` are no-ops.
 */
export interface ProgressReporter {
  /** Report incremental progress.  `progress` must be monotonically increasing. */
  update(progress: number, message?: string): Promise<void>;
  /** Signal completion. */
  done(message?: string): Promise<void>;
}

export function createProgressReporter(
  notify: (params: {
    method: string;
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>,
  progressToken: string | number,
  total?: number,
): ProgressReporter {
  let lastReported = 0;

  async function send(progress: number, message?: string): Promise<void> {
    if (progress <= lastReported) {
      console.debug('ProgressReporter: stale/out-of-order update suppressed', { progress, lastReported });
      return;
    }
    lastReported = progress;
    const params: Record<string, unknown> = { progressToken, progress };
    if (total !== undefined) params.total = total;
    if (message) params.message = message;
    await notify({
      method: 'notifications/progress',
      params: params as {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      },
    });
  }

  return {
    async update(progress: number, message?: string) {
      return send(progress, message);
    },
    async done(message?: string) {
      const final = Math.max(total ?? lastReported + 1, lastReported + 1);
      return send(final, message ?? 'Done.');
    },
  };
}