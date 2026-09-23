# Documentation assets

`ivy-logo.png` is the original Ivy emblem from [ivy.market](https://ivy.market/v2-static/assets/ivy-logo.png), retrieved on September 5, 2026. The file is used unchanged in the header and as the favicon.

The palette follows [Ivy's website](https://ivy.market/): warm paper `#faf8f4`, ink `#1a1a1a`, dark backgrounds `#0c0e13` and `#12141b`, and orange accents at OKLCH hue 38. Text accents are darker in light mode and brighter in dark mode for readability. Thin rules and a small orange heading marker carry the same style into the documentation layout.

Typography remains Manrope, Inter, and JetBrains Mono. All fonts and the logo are local assets; the guide makes no external asset requests.

`map.js`/`map.css` are the lifecycle map's engine and styling, and `shell.js`/`shell.css` switch `index.html` between the map and the guide. `labs.js`/`labs.css` hold the interactive examples (fees, payoff calculator, cash amounts, consent, releases) shared by the map cards and `guide.html`; each page marks a widget with `data-lab` and mounts it through `IvyLabs.mountAll`. `guide.html` also loads `docs.js` (theme toggle, section marker), `guide.js` and `vault-diagrams.js`, styled by `guide.css`, `atlas.css` and `roman.css`. The reference pages use `reference.css` and `reference.js`, and `embed.js` keeps every framed page in step with the shell. `docs.css` is the shared base style.
