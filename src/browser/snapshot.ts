/* eslint-disable @typescript-eslint/restrict-template-expressions */
import type { Page, Locator } from 'playwright-core';
import type { SnapshotNode, SnapshotResult } from './types.js';
import { BrowserError } from './types.js';

function assignRefs(node: SnapshotNode, counter: { value: number }): SnapshotNode {
  node.ref = `e${counter.value++}`;
  for (const child of node.children) {
    assignRefs(child, counter);
  }
  return node;
}

function countElements(node: SnapshotNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countElements(child);
  }
  return count;
}

/**
 * DOM-to-Accessibility-Tree converter.
 *
 * Since Playwright 1.59 removed the client-side Accessibility API,
 * we walk the DOM via page.evaluate() and build a tree using ARIA
 * attributes and semantic HTML element roles.
 */

/** Serializable DOM-node representation returned by the injected script. */
interface RawDomNode {
  role: string;
  name: string;
  value?: string | undefined;
  children: RawDomNode[];
}

/**
 * Capture the accessibility tree of the current page via DOM walk.
 */
export async function captureSnapshot(
  page: Page,
  options?: { selector?: string; depth?: number; includeHidden?: boolean },
): Promise<SnapshotResult> {
  try {
    const depth = options?.depth ?? 20;
    const includeHidden = options?.includeHidden ?? false;
    const selector = options?.selector ?? null;

    const rawRoot = await page.evaluate(
      ({ incHidden, d, s }) => {
        /* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
        const seen = new WeakSet();

        function computeRole(el: Element): string {
          const ariaRole = el.getAttribute('role');
          if (ariaRole) return ariaRole;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (tag === 'input') {
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'submit' || type === 'button') return 'button';
            return 'textbox';
          }
          const m: Record<string, string> = {
            a: 'link',
            button: 'button',
            select: 'combobox',
            textarea: 'textbox',
            img: 'img',
            h1: 'heading',
            h2: 'heading',
            h3: 'heading',
            h4: 'heading',
            h5: 'heading',
            h6: 'heading',
            nav: 'navigation',
            main: 'main',
            header: 'banner',
            footer: 'contentinfo',
            aside: 'complementary',
            form: 'form',
            table: 'table',
            ul: 'list',
            ol: 'list',
            li: 'listitem',
            dialog: 'dialog',
            iframe: 'iframe',
          };
          return m[tag] || ((el as HTMLElement).isContentEditable ? 'textbox' : 'generic');
        }

        function computeName(el: Element): string {
          const al = el.getAttribute('aria-label');
          if (al) return al;
          const alb = el.getAttribute('aria-labelledby');
          if (alb) {
            const le = document.getElementById(alb);
            if (le) return (le.textContent || '').trim();
          }
          const ti = el.getAttribute('title');
          if (ti) return ti;
          if (el.tagName === 'IMG') {
            const a = el.getAttribute('alt');
            if (a) return a;
          }
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const p = el.getAttribute('placeholder');
            if (p) return p;
          }
          if (el.tagName === 'A' || el.tagName === 'BUTTON') {
            const t = (el.textContent || '').trim();
            if (t) return t;
          }
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
            const id = el.id;
            if (id) {
              const lb = document.querySelector('label[for="' + CSS.escape(id) + '"]');
              if (lb) return (lb.textContent || '').trim();
            }
            const pl = el.closest('label');
            if (pl) return (pl.textContent || '').trim();
          }
          const adb = el.getAttribute('aria-describedby');
          if (adb) {
            const de = document.getElementById(adb);
            if (de) return (de.textContent || '').trim();
          }
          const a2 = el.getAttribute('alt');
          if (a2) return a2;
          return '';
        }

        function computeValue(el: Element): string | undefined {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
            return (el as HTMLInputElement).value || '';
          if (el.tagName === 'SELECT') {
            const o = (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex];
            return o ? o.text : '';
          }
          const av =
            el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || undefined;
          return av;
        }

        function walk(el: Element, ih: boolean, depth: number): RawDomNode | null {
          if (seen.has(el)) return null;
          seen.add(el);
          if (depth <= 0 || el.nodeType !== 1) return null;
          if (!ih) {
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse')
              return null;
            if (s.opacity === '0') return null;
            if (el.hasAttribute('hidden')) return null;
            if (el.getAttribute('aria-hidden') === 'true') return null;
          }
          const role = computeRole(el);
          if (
            role === 'generic' &&
            !(el.textContent || '').trim() &&
            el.children.length <= 1 &&
            !el.hasAttribute('aria-label') &&
            !el.hasAttribute('aria-labelledby') &&
            !el.hasAttribute('role')
          )
            return null;
          const name = computeName(el);
          const value = computeValue(el);
          const node: RawDomNode = { role, name, value, children: [] };
          for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
            const cn = walk(c, ih, depth - 1);
            if (cn) node.children.push(cn);
          }
          if (!node.name && node.children.length === 0) return null;
          return node;
        }

        const rootEl = (s ? document.querySelector(s) : document.body) || document.documentElement;
        return walk(rootEl, incHidden, d);
      },
      { incHidden: includeHidden, d: depth, s: selector },
    );

    if (!rawRoot) {
      throw new BrowserError(
        'Failed to capture DOM snapshot — no interactive elements found',
        'ACTION_FAILED',
      );
    }

    // Convert RawDomNode to SnapshotNode
    function toSnapshotNode(raw: RawDomNode): SnapshotNode {
      const node: SnapshotNode = {
        ref: '',
        role: raw.role,
        name: raw.name,
        children: raw.children.map(toSnapshotNode),
      };
      if (raw.value !== undefined) {
        node.value = raw.value;
      }
      return node;
    }

    const root = toSnapshotNode(rawRoot);
    const refCounter = { value: 1 };
    assignRefs(root, refCounter);

    return {
      url: page.url(),
      title: await page.title(),
      root,
      elementCount: countElements(root),
    };
  } catch (err) {
    if (err instanceof BrowserError) throw err;
    throw new BrowserError(
      'Snapshot failed: ' + (err instanceof Error ? err.message : String(err)),
      'ACTION_FAILED',
    );
  }
}

/** Walk the tree to find a node by its ref ID. */
export function findElementByRef(node: SnapshotNode, ref: string): SnapshotNode | null {
  if (node.ref === ref) return node;
  for (const child of node.children) {
    const found = findElementByRef(child, ref);
    if (found) return found;
  }
  return null;
}

/** Convert a snapshot node to a Playwright Locator. */
export function refToLocator(page: Page, node: SnapshotNode): Locator {
  if (node.name && node.role) {
    const escaped = node.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const locator = page.locator('[aria-label="' + escaped + '"]');
    try {
      const role = node.role;
      return locator.or(page.getByRole(role as never, { name: node.name }));
    } catch {
      return locator;
    }
  }
  if (node.name) {
    return page.getByText(node.name, { exact: true });
  }
  throw new BrowserError(
    'Cannot build locator for node ref=' + node.ref + ': no name or role',
    'ACTION_FAILED',
  );
}
