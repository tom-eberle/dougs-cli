# README diagrams

The images in `docs/images/` are rendered from these [archify](https://github.com/tt-a1i/archify)
sources. Labels are generic: never put real company data in them. The first three are for
non-technical readers: plain words, command names at most as small secondary text.

| Source | archify type | Images |
|---|---|---|
| `jobs.json` | `architecture` (a grid) | `jobs-{light,dark}.png` |
| `before-after.json` | `workflow` | `before-after-{light,dark}.png` |
| `monthly-routine.json` | `workflow` | `monthly-routine-{light,dark}.png` |
| `architecture.json` | `architecture` | `architecture-{light,dark}.png` |
| `safety-loop.json` | `workflow` | `safety-loop-{light,dark}.png` |
| `write-sequence.json` | `sequence` | `write-sequence-{light,dark}.png` |

To change one, edit its source and re-render:

```sh
git clone https://github.com/tt-a1i/archify /tmp/archify     # anywhere outside this repo; nothing to install
npm install --no-save playwright-core
ARCHIFY_DIR=/tmp/archify/archify CHROME=<chromium binary> npm run diagrams -- safety-loop
pngquant --quality 85-98 --ext .png --force docs/images/*.png
```

`build.mjs` runs archify's `finalize` (schema, layout and browser checks, failing on any warning),
then exports a light and a dark PNG through archify's own exporter, trimmed to the drawn content
and at 2x. Without `CHROME` it uses Playwright's Chromium (`npx playwright-core install chromium`).

The README links the images by absolute `raw.githubusercontent.com` URLs so they also show on
npmjs.com, which may ignore `<picture>`: the light PNG is the fallback and has an opaque
background, so it reads on dark pages too.
