#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'extension', 'store');
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const [name, width, height] of [
    ['small-promotional-tile', 440, 280],
    ['large-promotional-tile', 1400, 560],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`file://${join(dir, `${name}.svg`)}`);
    await page.screenshot({ path: join(dir, `${name}.png`) });
    await page.close();
    console.log(`已生成 ${name}.png (${width}x${height})`);
  }
} finally {
  await browser.close();
}
