# Bundled task skills

- [Caveman](https://github.com/juliusbrussee/caveman), Apache-2.0. The original instructions and license are in `caveman/`.
- [No AI Slop](https://github.com/petergyang/no-ai-slop), copyright 2026 Peter Yang, MIT. The instructions, evaluation checklist and license are in `no-ai-slop/`.
- [Ponytail](https://github.com/DietrichGebert/ponytail/tree/96608e078b2d5ea607c5c3b8b5a54d1c1fba6846), copyright 2026 DietrichGebert, MIT. The original instructions and license are in `ponytail/`.

The Caveman and No AI Slop snapshots were copied from the local installation on 10 November 2026. Ponytail was copied from upstream revision `96608e078b2d5ea607c5c3b8b5a54d1c1fba6846`.

Miter adapts Caveman and No AI Slop in `packages/protocol/src/task-skills/writing.ts` for task summaries, prose and draft rewrites. Its adaptation of Ponytail’s default coding guidance lives in `packages/protocol/src/task-skills/engineering.ts`. The adapted instructions use Miter’s JSON response format and respect project requirements and permissions. The bundled documents are offline references.
