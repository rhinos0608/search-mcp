import type { Page } from 'playwright-core';
import type { DialogHandlerConfig, DialogResult } from './types.js';

/** Dialog history per page. Automatically GC'd when pages are disposed. */
const dialogHistoryByPage = new WeakMap<Page, DialogResult[]>();

/** Active dialog handler cleanup per page. */
const activeHandlersByPage = new WeakMap<Page, () => void>();

/**
 * Start auto-handling browser dialogs (alert, confirm, prompt).
 * Once started, dialogs are handled automatically according to config.
 */
export function startDialogHandler(
  page: Page,
  config: DialogHandlerConfig,
): void {
  // Remove any existing handler first
  stopDialogHandler(page);

  let handledCount = 0;
  const max = config.maxDialogs ?? 50;

  const handler = (dialog: import('playwright-core').Dialog) => {
    if (handledCount >= max) {
      dialog.dismiss().catch(() => { /* intentionally empty */ });
      return;
    }

    handledCount++;
    const result: DialogResult = {
      type: dialog.type() as 'alert' | 'confirm' | 'prompt',
      message: dialog.message(),
      accepted: config.accept,
    };

    if (dialog.type() === 'prompt' && config.accept) {
      const promptText = config.promptText ?? '';
      result.promptText = promptText;
      dialog.accept(promptText).catch(() => { /* intentionally empty */ });
    } else if (config.accept) {
      dialog.accept().catch(() => { /* intentionally empty */ });
    } else {
      dialog.dismiss().catch(() => { /* intentionally empty */ });
    }

    const history = dialogHistoryByPage.get(page) ?? [];
    history.push(result);
    dialogHistoryByPage.set(page, history);
  };

  page.on('dialog', handler);
  activeHandlersByPage.set(page, () => {
    page.off('dialog', handler);
  });
}

/** Stop auto-handling dialogs. */
export function stopDialogHandler(page: Page): void {
  const handler = activeHandlersByPage.get(page);
  if (handler) {
    handler();
    activeHandlersByPage.delete(page);
  }
}

/** Get the history of dialogs handled so far. */
export function getDialogHistory(page: Page): DialogResult[] {
  return [...(dialogHistoryByPage.get(page) ?? [])];
}

/** Clear dialog history. */
export function clearDialogHistory(page: Page): void {
  dialogHistoryByPage.delete(page);
}

/**
 * Check if a dialog is currently open and handle it explicitly.
 * Returns null if no dialog is open.
 */
export async function handleCurrentDialog(
  page: Page,
  accept: boolean,
  promptText?: string,
): Promise<DialogResult | null> {
  try {
    // Playwright auto-dismisses dialogs by default, so we need a race
    let dialogResult: DialogResult | null = null;

    const dialogPromise = new Promise<DialogResult>((resolve) => {
      const handler = async (dialog: import('playwright-core').Dialog) => {
        const result: DialogResult = {
          type: dialog.type() as 'alert' | 'confirm' | 'prompt',
          message: dialog.message(),
          accepted: accept,
        };

        if (dialog.type() === 'prompt' && accept) {
          result.promptText = promptText ?? '';
          await dialog.accept(promptText ?? '');
        } else if (accept) {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }

        const history = dialogHistoryByPage.get(page) ?? [];
        history.push(result);
        dialogHistoryByPage.set(page, history);
        resolve(result);
      };

      page.once('dialog', handler);
    });

    // Race: either a dialog appears within 500ms, or we assume none
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => { resolve(null); }, 500);
    });

    dialogResult = await Promise.race([dialogPromise, timeout]);
    return dialogResult;
  } catch {
    return null;
  }
}
