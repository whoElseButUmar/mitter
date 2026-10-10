# Third-party software

Miter's MIT license does not relicense its dependencies, fonts, or model weights. Installed packages retain their upstream notices. Retain the notices for the exact packages and their transitive dependencies when redistributing a build.

## Terminal

The terminal uses `node-pty@1.1.0`, `@xterm/xterm@5.5.0`, and `@xterm/addon-fit@0.10.0`, licensed under MIT. See [node-pty](https://github.com/microsoft/node-pty) and [xterm.js](https://github.com/xtermjs/xterm.js).

The production build downloads `FiraCodeNerdFontMono-Regular.ttf` from Nerd Fonts v3.4.0, based on Fira Code 6.2. It retains the SIL Open Font License 1.1 notice in the built extension's `fonts/OFL.txt` and records font identity and SHA-256 in `fonts/FONT-SOURCE.json`.

- [Patched font](https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/FiraCode/Regular/FiraCodeNerdFontMono-Regular.ttf)
- [Fira Code license](https://raw.githubusercontent.com/tonsky/FiraCode/6.2/LICENSE)

Imported fonts keep their own licenses. Fonts are not installed into the operating system.

## Local models

No GGUF weights are included. Review each model's model card, license, and redistribution conditions separately.
