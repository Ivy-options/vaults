# Documentation assets

`ivy-logo.png` is the original Ivy emblem from [ivy.market](https://ivy.market/v2-static/assets/ivy-logo.png), retrieved on September 5, 2026. The file is used unchanged in the header and as the favicon.

The palette follows [Ivy's website](https://ivy.market/): warm paper `#faf8f4`, ink `#1a1a1a`, dark backgrounds `#0c0e13` and `#12141b`, and orange accents at OKLCH hue 38. Text accents are darker in light mode and brighter in dark mode for readability. Thin rules and a small orange heading marker carry the same style into the documentation layout.

Typography remains Manrope, Inter, and JetBrains Mono. All fonts and the logo are local assets; the guide makes no external asset requests.

`map.js`/`map.css` and `labs.js`/`labs.css` are the lifecycle map's engine, widgets, and styling; `docs.css` and `roman.css` are shared base styles. `reference.css` and `reference.js` remain for `license.html`'s `.doc-page` styling and theme toggle. `guide.js`, `guide.css`, `atlas.js`, `atlas.css`, `vault-diagrams.js`, and `docs.js` were retired when the old guide and its sub-pages were replaced by the map; their surviving logic lives in `labs.js`/`labs.css`.
