# Bundled assets

| File | What | Licence |
|---|---|---|
| `fonts/anton-latin-400.woff2` | Anton, latin subset: Wrapped's poster display face (big numbers and words). Taken from the `@fontsource/anton` 5.3.0 package. Loaded by `src/styles/poster.css` with `font-display: block`; never fetched from a network. | SIL Open Font License 1.1, full text in `fonts/OFL-Anton.txt`. Copyright 2020 The Anton Project Authors. |
| `grain.png` | 96 x 96 grey noise tile for the poster grain (drawn at about 6% opacity). Generated for this repo from a fixed seed; no third-party source. | Same as the app. |
| `spark.svg`, `atlas-icon-64.png` | The app's own marks. | Same as the app. |

The OFL allows bundling and embedding the font in an app; the font is not sold on its own and keeps its name. Recursive (the app's other display face) comes from the `@fontsource-variable/recursive` package, also OFL.
