import type { Page, Frame } from 'playwright-core';
import type { FrameInfo, FrameSwitchResult } from './types.js';

/**
 * Active iframe context per page — set by switchToFrame, cleared on switch back to main.
 * Consumed by browser.ts handler for context-aware operations.
 */
export const activeFrameByPage = new WeakMap<Page, Frame>();

/** Get active iframe for a page (null = main frame). */
export function getActiveFrame(page: Page): Frame | null {
  return activeFrameByPage.get(page) ?? null;
}

/**
 * List all frames in the current page, including nested ones.
 * Returns flattened list with depth information.
 */
export function listFrames(page: Page): FrameInfo[] {
  const frames: FrameInfo[] = [];

  function walk(frame: Frame, depth: number): void {
    const childFrames = frame.childFrames();
    childFrames.forEach((child, index) => {
      frames.push({
        name: child.name() || `(unnamed-${String(index)})`,
        url: child.url(),
        depth: depth + 1,
        index,
      });
      walk(child, depth + 1);
    });
  }

  // Add top-level (main) frame
  frames.push({
    name: '(main)',
    url: page.mainFrame().url(),
    depth: 0,
    index: 0,
  });

  walk(page.mainFrame(), 0);
  return frames;
}

/**
 * Find a frame by name, URL pattern, or index.
 * Returns the Frame object or null if not found.
 */
export function findFrame(
  page: Page,
  target: { by: 'name' | 'url' | 'index' | 'selector'; value: string | number },
): Frame | null {
  const allFrames = collectAllFrames(page);

  for (const frame of allFrames) {
    switch (target.by) {
      case 'name':
        if (frame.name() === target.value) return frame;
        break;
      case 'url':
        if (frame.url().includes(String(target.value))) return frame;
        break;
      case 'index': {
        const frames = listFrames(page);
        const frameInfo = frames[target.value as number];
        if (frameInfo) {
          if (frameInfo.depth === 0) return page.mainFrame();
          return findFrameByTraversal(page, frameInfo.depth, frameInfo.index);
        }
        break;
      }
      default:
        break;
    }
  }

  return null;
}

/** Collect all frames recursively. */
function collectAllFrames(page: Page): Frame[] {
  const result: Frame[] = [];
  function walk(frame: Frame): void {
    result.push(frame);
    for (const child of frame.childFrames()) {
      walk(child);
    }
  }
  walk(page.mainFrame());
  return result;
}

/** Find a frame by depth and index matching listFrames ordering. */
function findFrameByTraversal(page: Page, targetDepth: number, targetIndex: number): Frame | null {
  let currentIndex = 0;

  function walk(frame: Frame, depth: number): Frame | null {
    if (depth === targetDepth) {
      if (currentIndex === targetIndex) return frame;
      currentIndex++;
    }
    for (const child of frame.childFrames()) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  return walk(page.mainFrame(), 0);
}

/**
 * Switch page context to operate within a specific iframe.
 * Subsequent page actions (click, type, evaluate) will run inside the frame.
 * Returns the frame object so the caller can use frame.locator() etc.
 */
export async function switchToFrame(
  page: Page,
  target: { by: 'name' | 'url' | 'index' | 'selector'; value: string | number },
): Promise<FrameSwitchResult> {
  const availableFrames = listFrames(page);

  let frame: Frame | null = null;

  if (target.by === 'selector') {
    // Locate the iframe element by CSS selector, then get its content frame
    try {
      const iframeElement = page.locator(String(target.value));
      const elementHandle = await iframeElement.elementHandle();
      const contentFrame = elementHandle ? await elementHandle.contentFrame() : null;
      if (contentFrame) {
        frame = contentFrame;
      }
    } catch {
      // selector not found
    }
  } else {
    frame = findFrame(page, target);
  }

  if (!frame) {
    return { success: false, availableFrames };
  }

  // Track active frame for subsequent context-aware operations
  if (frame === page.mainFrame()) {
    activeFrameByPage.delete(page);
  } else {
    activeFrameByPage.set(page, frame);
  }

  // Store frame reference for context-aware operations
  // The caller should use this frame for subsequent operations
  const frameInfo = availableFrames.find((f) => {
    if (f.depth === 0 && frame === page.mainFrame()) return true;
    return compareFrames(frame, f, page);
  });

  return {
    success: true,
    frame: frameInfo ?? {
      name: frame.name() || '(selected)',
      url: frame.url(),
      depth: 0,
      index: 0,
    },
    availableFrames,
  };
}

/** Compare a Frame object against FrameInfo metadata. */
function compareFrames(frame: Frame, info: FrameInfo, page: Page): boolean {
  if (info.depth === 0) return frame === page.mainFrame();
  const nameMatch = info.name ? frame.name() === info.name : false;
  const urlMatch = info.url ? frame.url() === info.url : false;
  if (info.name && info.url) return nameMatch && urlMatch;
  return nameMatch || urlMatch;
}
