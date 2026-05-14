import type { Page } from 'playwright-core';
import type { DiffResult, DomChange } from './types.js';

/**
 * Take a DOM snapshot, perform an action, then return a structural diff.
 * Useful for verifying that an action actually changed something.
 */
export async function diffAfterAction(
  page: Page,
  action: () => Promise<void>,
  options?: {
    /** CSS selector to scope the diff to (default: body). */
    selector?: string;
    /** Maximum changes to report (default: 100). */
    maxChanges?: number;
  },
): Promise<DiffResult> {
  const selector = options?.selector ?? 'body';
  const maxChanges = options?.maxChanges ?? 100;

  // Capture before state
  const before = await captureDomState(page, selector);

  // Perform the action
  await action();

  // Wait for any DOM updates
  await page.waitForTimeout(500);

  // Capture after state
  const after = await captureDomState(page, selector);

  // Compute diff
  return computeDiff(before, after, maxChanges);
}

/** Serialized DOM state for diffing. */
interface DomState {
  count: number;
  elements: DomElement[];
}

interface DomElement {
  path: string;
  tag: string;
  text: string;
  attrs: Record<string, string>;
  childCount: number;
}

/** Walk the DOM and serialize element information. */
async function captureDomState(page: Page, selector: string): Promise<DomState> {
  return page.evaluate((sel: string) => {
    const root = document.querySelector(sel) ?? document.body;
    const elements: {
      path: string;
      tag: string;
      text: string;
      attrs: Record<string, string>;
      childCount: number;
    }[] = [];

    function getPath(el: Element): string {
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.body) {
        let selectorPart = current.tagName.toLowerCase();
        if (current.id) {
          selectorPart += `#${current.id}`;
          parts.unshift(selectorPart);
          break;
        }
        const parent: Element | null = current.parentElement;
        if (parent) {
        const cur = current;
          const siblings = Array.from(parent.children).filter(
            (c: Element) => c.tagName === cur.tagName,
          );
          if (siblings.length > 1) {
            const idx = siblings.indexOf(current) + 1;
            selectorPart += `:nth-of-type(${String(idx)})`;
          }
        }
        parts.unshift(selectorPart);
        current = parent;
      }
      return parts.join(' > ');
    }

    function walk(el: Element, depth: number): void {
      if (depth > 15) return; // Limit depth

      const path = getPath(el);
      const attrs: Record<string, string> = {};

      // Collect significant attributes
      for (const attr of ['id', 'class', 'href', 'src', 'type', 'name', 'value', 'disabled', 'checked', 'selected', 'aria-expanded', 'aria-hidden', 'data-*', 'style', 'hidden', 'title', 'placeholder']) {
        const val = el.getAttribute(attr);
        if (val !== null && val !== '') {
          attrs[attr] = val.slice(0, 200);
        }
      }

      elements.push({
        path,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 200),
        attrs,
        childCount: el.children.length,
      });

      for (const child of el.children) {
        walk(child, depth + 1);
      }
    }

    walk(root, 0);

    return { count: elements.length, elements };
  }, selector);
}

/** Compute the structural diff between two DOM states. */
function computeDiff(
  before: DomState,
  after: DomState,
  maxChanges: number,
): DiffResult {
  const changes: DomChange[] = [];
  let additions = 0;
  let removals = 0;
  let modifications = 0;

  const beforeMap = new Map<string, DomElement>();
  for (const el of before.elements) {
    beforeMap.set(el.path, el);
  }

  const afterMap = new Map<string, DomElement>();
  for (const el of after.elements) {
    afterMap.set(el.path, el);
  }

  // Find additions (in after but not in before)
  for (const [path, el] of afterMap) {
    if (changes.length >= maxChanges) break;
    if (!beforeMap.has(path)) {
      changes.push({
        type: 'added',
        path,
        tag: el.tag,
        text: el.text.slice(0, 200),
      });
      additions++;
    }
  }

  // Find removals (in before but not in after)
  for (const [path, el] of beforeMap) {
    if (changes.length >= maxChanges) break;
    if (!afterMap.has(path)) {
      changes.push({
        type: 'removed',
        path,
        tag: el.tag,
        text: el.text.slice(0, 200),
      });
      removals++;
    }
  }

  // Find modifications (same path, different content)
  for (const [path, afterEl] of afterMap) {
    if (changes.length >= maxChanges) break;
    const beforeEl = beforeMap.get(path);
    if (!beforeEl) continue;

    // Check text changes
    if (beforeEl.text !== afterEl.text) {
      changes.push({
        type: 'text-changed',
        path,
        tag: afterEl.tag,
        oldText: beforeEl.text.slice(0, 200),
        newText: afterEl.text.slice(0, 200),
      });
      modifications++;
      continue;
    }

    // Check attribute changes
    const allAttrKeys = new Set([
      ...Object.keys(beforeEl.attrs),
      ...Object.keys(afterEl.attrs),
    ]);
    for (const attrKey of allAttrKeys) {
      if (changes.length >= maxChanges) break;
      const beforeVal = beforeEl.attrs[attrKey] ?? '';
      const afterVal = afterEl.attrs[attrKey] ?? '';
      if (beforeVal !== afterVal) {
        changes.push({
          type: 'attribute-changed',
          path,
          tag: afterEl.tag,
          attributeName: attrKey,
          oldValue: beforeVal,
          newValue: afterVal,
        });
        modifications++;
      }
    }
  }

  return {
    additions,
    removals,
    modifications,
    changes,
    hasChanges: changes.length > 0,
    beforeCount: before.count,
    afterCount: after.count,
  };
}
