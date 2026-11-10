#!/usr/bin/env node
/** Generate a 300x300 Edge Add-ons store icon from the extension icon. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const iconPath = join(root, 'extension', 'icons', 'icon.svg');
const outPath = join(root, 'extension', 'store', 'icon-300.png');
mkdirSync(join(root, 'extension', 'store'), { recursive: true });

const svg = await import('node:fs/promises').then(({ readFile }) => readFile(iconPath, 'utf8'));
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:300px;height:300px}</style>${svg}`);
  await page.screenshot({ path: outPath, omitBackground: true });
  console.log(`已生成 ${outPath}`);
} finally {
  await browser.close();
}
