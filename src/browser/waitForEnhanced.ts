import type { Page } from 'playwright-core';
import type { WaitCondition, WaitResult } from './types.js';

/**
 * Wait for a condition-based element state.
 * Supports: visible (element appears), gone (element disappears),
 * has-text (element contains specific text), count (N elements match selector).
 */
export async function waitForCondition(
  page: Page,
  condition: WaitCondition,
): Promise<WaitResult> {
  const startTime = Date.now();
  const timeout = condition.timeout ?? 30000;

  try {
    switch (condition.condition) {
      case 'visible': {
        await page.locator(condition.selector).waitFor({
          state: 'visible',
          timeout,
        });
        break;
      }
      case 'gone': {
        await page.locator(condition.selector).waitFor({
          state: 'hidden',
          timeout,
        });
        break;
      }
      case 'has-text': {
        const text = condition.text ?? '';
        if (!text) {
          return {
            satisfied: false,
            condition,
            elapsedMs: Date.now() - startTime,
            actualText: '',
          };
        }
        await page.locator(condition.selector, { hasText: text }).waitFor({
          state: 'visible',
          timeout,
        });
        break;
      }
      case 'count': {
        const expected = condition.count ?? 1;
        const operator = condition.countOperator ?? '>=';
        await page.waitForFunction(
          ({ sel, exp, op }: { sel: string; exp: number; op: string }) => {
            const count = document.querySelectorAll(sel).length;
            switch (op) {
              case '>=': return count >= exp;
              case '<=': return count <= exp;
              case '==': return count === exp;
              case '>': return count > exp;
              case '<': return count < exp;
              default: return count >= exp;
            }
          },
          { sel: condition.selector, exp: expected, op: operator },
          { timeout },
        );
        break;
      }
      default: {
        return {
          satisfied: false,
          condition,
          elapsedMs: Date.now() - startTime,
        };
      }
    }

    const elapsedMs = Date.now() - startTime;
    const result: WaitResult = {
      satisfied: true,
      condition,
      elapsedMs,
    };

    // Populate actual counts/text for verification
    try {
      if (condition.condition === 'count') {
        result.actualCount = await page.locator(condition.selector).count();
      } else if (condition.condition === 'has-text') {
        const textContent = await page.locator(condition.selector).first().textContent();
        if (textContent) {
          result.actualText = textContent;
        } else {
          delete result.actualText;
        }
      }
    } catch {
      // Best-effort: don't fail the overall result
    }

    return result;
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('Timeout'));

    const result: WaitResult = {
      satisfied: false,
      condition,
      elapsedMs,
    };

    if (condition.condition === 'count') {
      try {
        result.actualCount = await page.locator(condition.selector).count();
      } catch {
        result.actualCount = 0;
      }
    } else if (condition.condition === 'has-text' && isTimeout) {
      try {
        const textContent = await page.locator(condition.selector).first().textContent();
        if (textContent) {
          result.actualText = textContent;
        } else {
          delete result.actualText;
        }
      } catch {
        // Best-effort
      }
    }

    return result;
  }
}

/**
 * Wait for multiple conditions in sequence.
 * Each condition must be satisfied before moving to the next.
 */
export async function waitForConditions(
  page: Page,
  conditions: WaitCondition[],
): Promise<WaitResult[]> {
  const results: WaitResult[] = [];
  for (const condition of conditions) {
    const result = await waitForCondition(page, condition);
    results.push(result);
    if (!result.satisfied) {
      break; // Stop on first failure
    }
  }
  return results;
}
