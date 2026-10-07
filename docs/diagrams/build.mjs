// Renders the README diagrams: docs/diagrams/<name>.json -> docs/images/<name>-{light,dark}.png
//
//   ARCHIFY_DIR=<archify checkout>/archify npm run diagrams [-- <name>...]
//
// Needs playwright-core (`npm install --no-save playwright-core`) and a Chromium: set CHROME to
// its binary, or install Playwright's with `npx playwright-core install chromium`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const here = import.meta.dirname;
const images = resolve(here, '../images');
const archify = process.env.ARCHIFY_DIR;
if (!archify) throw new Error('Set ARCHIFY_DIR to the archify/ folder of an archify checkout');

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(here)
      .filter((f) => f.endsWith('.json'))
      .map((f) => basename(f, '.json'));
const env = { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1' };
if (process.env.CHROME) env.ARCHIFY_CHROME = process.env.CHROME;
const work = mkdtempSync(join(tmpdir(), 'dougs-diagrams-'));
const browser = await chromium.launch(
  process.env.CHROME ? { executablePath: process.env.CHROME } : {},
);

for (const name of names) {
  const source = join(here, `${name}.json`);
  const { diagram_type: type } = JSON.parse(readFileSync(source, 'utf8'));
  const html = join(work, `${name}.html`);
  // finalize = validate + render + artifact and browser checks; it fails on any warning.
  const run = spawnSync(
    process.execPath,
    [join(archify, 'bin/archify.mjs'), 'finalize', type, source, html, '--quality', 'showcase'],
    { env, encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error(`archify finalize ${name} failed:\n${run.stdout}${run.stderr}`);
  }

  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ acceptDownloads: true, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(`${pathToFileURL(html).href}?theme=${theme}`);
    await page.waitForFunction(() => window.Archify?.exportMenu);
    await page.evaluate(fitViewBoxToContent);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => window.Archify.exportMenu.run('png')),
    ]);
    // archify exports at 4x; the README wants 2x.
    const png4x = readFileSync(await download.path()).toString('base64');
    const png2x = await page.evaluate(halve, `data:image/png;base64,${png4x}`);
    const out = join(images, `${name}-${theme}.png`);
    writeFileSync(out, Buffer.from(png2x.split(',')[1], 'base64'));
    console.log(out);
    await context.close();
  }
}
await browser.close();
console.log(
  'Compress before committing, e.g. pngquant --quality 85-98 --ext .png --force docs/images/*.png',
);

// Fixed canvases leave empty margins; shrink the viewBox to the drawn content plus 20 px.
function fitViewBoxToContent() {
  const svg = document.querySelector('.diagram-container svg');
  const vb = svg.viewBox.baseVal;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const el of svg.children) {
    if (['title', 'desc', 'defs', 'style'].includes(el.tagName)) continue;
    const r = el.getBBox();
    if ((!r.width && !r.height) || (r.width >= vb.width && r.height >= vb.height)) continue;
    box.x0 = Math.min(box.x0, r.x);
    box.y0 = Math.min(box.y0, r.y);
    box.x1 = Math.max(box.x1, r.x + r.width);
    box.y1 = Math.max(box.y1, r.y + r.height);
  }
  const x = Math.max(vb.x, box.x0 - 20);
  const y = Math.max(vb.y, box.y0 - 20);
  const w = Math.min(vb.x + vb.width, box.x1 + 20) - x;
  const h = Math.min(vb.y + vb.height, box.y1 + 20) - y;
  svg.setAttribute('viewBox', [x, y, w, h].map(Math.round).join(' '));
}

async function halve(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width / 2);
  canvas.height = Math.round(img.height / 2);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}
