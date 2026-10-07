# README diagrams

The images in `docs/images/` are rendered from these [archify](https://github.com/tt-a1i/archify)
sources. Labels are generic: never put real company data in them.

| Source | archify type | Images |
|---|---|---|
| `architecture.json` | `architecture` | `architecture-{light,dark}.png` |
| `monthly-routine.json` | `workflow` | `monthly-routine-{light,dark}.png` |
| `safety-loop.json` | `workflow` | `safety-loop-{light,dark}.png` |
| `write-sequence.json` | `sequence` | `write-sequence-{light,dark}.png` |

To change one:

1. Clone archify anywhere outside this repo (nothing to install; it needs Node and a Chrome-based
   browser for its checks, overridable with `ARCHIFY_CHROME=<path>`).
2. Edit the source, then render and check it:

   ```sh
   node <archify>/bin/archify.mjs finalize <type> docs/diagrams/<name>.json /tmp/<name>.html --quality showcase
   ```

3. Open `/tmp/<name>.html?theme=light` and `?theme=dark`, export each as PNG from the viewer's
   Export menu, and save them as `docs/images/<name>-light.png` and `<name>-dark.png`, resized to
   half the exported width (archify exports at 4x; the README uses 2x).

The README links the images by absolute `raw.githubusercontent.com` URLs so they also show on
npmjs.com, which may ignore `<picture>`: the light PNG is the fallback and has an opaque
background, so it reads on dark pages too.
