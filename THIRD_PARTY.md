# Third-party software

Miter's MIT license does not relicense its dependencies, fonts, or model weights. Installed packages retain their upstream notices. Retain the notices for the exact packages and their transitive dependencies when redistributing a build.

## Bridge

The bridge validates data with `zod@4.6.5` and packages its page script with `rolldown@1.2.13`. Both are licensed under MIT. See [Zod](https://github.com/colinhacks/zod) and [Rolldown](https://github.com/rolldown/rolldown).

## Icons

Miter uses [Lucide](https://lucide.dev) 1.73.0 through `lucide` and `lucide-solid`. Lucide is licensed under ISC; its Feather-derived icons retain their MIT notice. The complete upstream notices ship in the extension at `licenses/lucide.txt`. Miter's own logo remains separate.

## Terminal

The terminal uses `node-pty@1.1.0`, `@xterm/xterm@6.0.0`, and `@xterm/addon-fit@0.11.0`, licensed under MIT. See [node-pty](https://github.com/microsoft/node-pty) and [xterm.js](https://github.com/xtermjs/xterm.js).

The production build downloads `FiraCodeNerdFontMono-Regular.ttf` from Nerd Fonts v3.4.0, based on Fira Code 6.2. It retains the SIL Open Font License 1.1 notice in the built extension's `fonts/OFL.txt` and records font identity and SHA-256 in `fonts/FONT-SOURCE.json`.

- [Patched font](https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/FiraCode/Regular/FiraCodeNerdFontMono-Regular.ttf)
- [Fira Code license](https://raw.githubusercontent.com/tonsky/FiraCode/6.2/LICENSE)

Imported fonts keep their own licenses. Fonts are not installed into the operating system.

## Framework previews

Miter ships pnpm 12.11.2 and the matching macOS executable for installing project dependencies. The installer retains pnpm's MIT license and third-party notices. [pnpm](https://github.com/pnpm/pnpm)

## Bundled skills

[Caveman](https://github.com/juliusbrussee/caveman) is licensed under Apache-2.0. [No AI Slop](https://github.com/petergyang/no-ai-slop), copyright 2026 Peter Yang, is licensed under MIT. Installed skill snapshots, the No AI Slop evaluation checklist, and both licenses are included in `apps/extension/public/skills/` and copied into the built extension.

Miter adapts their writing rules in `packages/protocol/src/task-skills/writing.ts` for its JSON task and rewrite formats. This adaptation changes workflow instructions: it reviews task prose directly, keeps code readable, and emits no additional prose outside the required response. The original reference snapshots remain available. No hooks or optional Caveman sibling modes are included.

[Ponytail](https://github.com/DietrichGebert/ponytail/tree/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846), copyright 2026 DietrichGebert, is licensed under MIT. Miter bundles the upstream `SKILL.md` and `LICENSE` in `apps/extension/public/skills/ponytail/`. Its coding prompts use a condensed adaptation of the default rules in `packages/protocol/src/task-skills/engineering.ts`.

## Local models

No GGUF weights are included. Review each model's model card, license, and redistribution conditions separately.

## Browser quality checks

The native host bundles [Lighthouse](https://github.com/GoogleChrome/lighthouse) 13.6.0 and [Puppeteer Core](https://github.com/puppeteer/puppeteer) 25.17.0 under Apache-2.0, plus [axe-core](https://github.com/dequelabs/axe-core) 4.14.0 under MPL-2.0. Their source and license files remain in the runtime dependency bundle. Chrome itself is not redistributed; checks use an installed copy with an isolated temporary profile.
