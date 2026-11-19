import path from 'node:path';

// Screenshots are only written when BIDPARK_CAPTURE_DIR is set; CI just runs the presenter path.
export async function capture(page, name) {
  const dir = process.env.BIDPARK_CAPTURE_DIR;
  // Toasts never auto-dismiss under the frozen test clock; hide them so they don't cover the page.
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), style: '.toast-container { display: none !important; }' });
}

export const PROJECTOR = { width: 1280, height: 720 };
export const N1 = 'N1 · Quad Edge Commuter Spot [Fictional Class Demo]';
