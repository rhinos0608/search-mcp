import type { Download, Page } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadConfig, DownloadResult } from './types.js';

/**
 * Intercept file downloads and return the file data.
 * Sets up a download listener, performs the trigger action,
 * then returns the downloaded file content.
 */
export async function interceptDownload(
  page: Page,
  trigger: () => Promise<void>,
  config: DownloadConfig = {},
): Promise<DownloadResult | null> {
  const autoAccept = config.autoAccept ?? true;
  const maxSize = config.maxSize ?? 50 * 1024 * 1024; // 50MB default

  // Set up download listener before triggering
  let resolveDownload!: (result: DownloadResult) => void;
  let rejectDownload!: (error: Error) => void;
  const downloadPromise = new Promise<DownloadResult>((resolve, reject) => {
    resolveDownload = resolve;
    rejectDownload = reject;
  });

  const timeout = setTimeout(() => {
    rejectDownload(new Error('Download timeout: no download event within 30s'));
  }, 30000);

  const onDownload = async (download: Download) => {
    clearTimeout(timeout);

    try {
      const filename = download.suggestedFilename();
      const url = download.url();

      if (!autoAccept) {
        await download.cancel();
        resolveDownload({ filename, mimeType: '', size: 0, url });
        return;
      }

      // Stream the download
      const stream = await download.createReadStream();

      const chunks: Buffer[] = [];
      let totalSize = 0;

      let truncated = false;
      for await (const chunk of stream) {
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        totalSize += buf.length;
        if (totalSize > maxSize) {
          stream.destroy();
          truncated = true;
          break;
        }
        chunks.push(buf);
      }

      const buffer = Buffer.concat(chunks);
      const result: DownloadResult = {
        filename,
        mimeType: '', // Playwright doesn't expose MIME type directly for downloads
        size: buffer.length,
        url,
      };
      if (truncated) {
        result.truncated = true;
      }

      // Save to file if path specified
      if (config.savePath) {
        await mkdir(config.savePath, { recursive: true });
        const filePath = join(config.savePath, filename);
        await writeFile(filePath, buffer);
        result.savedPath = filePath;
      } else {
        // Return data inline if within reasonable size (10MB)
        if (buffer.length <= 10 * 1024 * 1024) {
          result.data = buffer.toString('base64');
        }
      }

      resolveDownload(result);
    } catch (err) {
      rejectDownload(err instanceof Error ? err : new Error(String(err)));
    }
  };

  page.once('download', onDownload);

  // Trigger the download with listener cleanup
  try {
    await trigger();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    page.off('download', onDownload);
  }

  return await downloadPromise;
}

/**
 * Set up a download path for all future downloads in this page context.
 * Downloads will be saved automatically to the specified directory.
 * Returns a function that, when called, returns the list of completed downloads.
 */
export function startDownloadCollection(
  page: Page,
  savePath?: string,
  maxSize = 50 * 1024 * 1024,
): { cleanup: () => void; waitForDownloads: () => Promise<DownloadResult[]> } {
  const downloads: DownloadResult[] = [];

  const handler = async (download: import('playwright-core').Download) => {
    try {
      const stream = await download.createReadStream();

      const chunks: Buffer[] = [];
      let totalSize = 0;

      let truncated = false;
      for await (const chunk of stream) {
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        totalSize += buf.length;
        if (totalSize > maxSize) {
          stream.destroy();
          truncated = true;
          break;
        }
        chunks.push(buf);
      }

      const buffer = Buffer.concat(chunks);
      const filename = download.suggestedFilename();
      const result: DownloadResult = {
        filename,
        mimeType: '',
        size: buffer.length,
        url: download.url(),
      };
      if (truncated) {
        result.truncated = true;
      }

      if (savePath) {
        await mkdir(savePath, { recursive: true });
        const filePath = join(savePath, filename);
        await writeFile(filePath, buffer);
        result.savedPath = filePath;
      } else if (buffer.length <= 10 * 1024 * 1024) {
        result.data = buffer.toString('base64');
      }

      downloads.push(result);
    } catch {
      // Skip failed downloads
    }
  };

  page.on('download', handler);

  const cleanup = (): void => {
    page.off('download', handler);
  };

  return {
    cleanup,
    waitForDownloads: async (): Promise<DownloadResult[]> => {
      // Wait a bit for any in-flight downloads
      await page.waitForTimeout(1000);
      return [...downloads];
    },
  };
}
