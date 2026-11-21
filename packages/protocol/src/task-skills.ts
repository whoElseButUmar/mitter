import { z } from 'zod';
import { APP_DESIGN_GUIDANCE, APP_FOUNDATION_CSS } from './task-skills/app-design.js';
import { APP_COMPONENTS_JS } from './task-skills/app-components.js';
import { ENGINEERING_GUIDANCE, PONYTAIL_GUIDANCE } from './task-skills/engineering.js';
import { CAVEMAN_GUIDANCE, NO_AI_SLOP_GUIDANCE } from './task-skills/writing.js';
import {
  bundledTaskSkillIdSchema,
  bundledTaskSkillResourceSchema,
  type BundledTaskSkillId,
  type BundledTaskSkillResource,
  type BundledTaskAsset,
} from './schemas/task-skills.js';

export { bundledTaskSkillIdSchema } from './schemas/task-skills.js';

export const bundledTaskSkillSchema = z
  .strictObject({
    id: bundledTaskSkillIdSchema,
    name: z.string().min(1).describe('Readable name shown in the task instructions.'),
    version: z.literal(1).describe('Revision of the Miter task adaptation.'),
    enabledByDefault: z.literal(true).describe('This built-in is included without a separate installation.'),
    scope: z
      .enum(['writing', 'web-ui', 'engineering'])
      .describe('The kind of work these instructions apply to; they do not add work to a task.'),
    instructions: z
      .string()
      .min(1)
      .describe('Packaged instructions that preserve the task response contract.'),
    promptInstructions: z
      .string()
      .min(1)
      .describe('Always-enabled task rules; detailed references are available through the skill action.'),
  })
  .readonly()
  .describe('One offline built-in skill applied to fresh Miter AI prompts.');

export type BundledTaskSkill = z.infer<typeof bundledTaskSkillSchema>;

export const bundledTaskSkills = z
  .array(bundledTaskSkillSchema)
  .readonly()
  .parse([
    {
      id: 'caveman',
      name: 'Caveman',
      version: 1,
      enabledByDefault: true,
      scope: 'writing',
      instructions: CAVEMAN_GUIDANCE,
      promptInstructions: CAVEMAN_GUIDANCE,
    },
    {
      id: 'no-ai-slop',
      name: 'No AI Slop',
      version: 1,
      enabledByDefault: true,
      scope: 'writing',
      instructions: NO_AI_SLOP_GUIDANCE,
      promptInstructions: NO_AI_SLOP_GUIDANCE,
    },
    {
      id: 'ponytail',
      name: 'Ponytail',
      version: 1,
      enabledByDefault: true,
      scope: 'engineering',
      instructions: PONYTAIL_GUIDANCE,
      promptInstructions: PONYTAIL_GUIDANCE,
    },
    {
      id: 'app-design',
      name: 'App design and components',
      version: 1,
      enabledByDefault: true,
      scope: 'web-ui',
      instructions: APP_DESIGN_GUIDANCE,
      promptInstructions:
        'For UI work, read the bundled app-design skill before implementing controls. Use one shared, ' +
        'app-specific theme and reusable styled components, including their open menus, calendars and ' +
        'scroll areas. Preserve semantic behavior, accessible labels, keyboard navigation and focus return. ' +
        'Use CSS :focus-visible, not JavaScript modality tracking. Inset select indicators. Remove fake ' +
        'status dots, decorative arrows, generic card layouts and idle local-storage labels. ' +
        'Choose hierarchy and density from the actual user task, not a generic theme. Date ranges and presets ' +
        'belong only where needed. Completion requires linked styled components, isolated tests, Chrome ' +
        'journeys, automated accessibility checks and Lighthouse 100 in every scored desktop/mobile category. ' +
        'Repair reported failures without hiding content, weakening tests or disabling audits. ' +
        'Read engineering-quality for the required miter.quality.json manifest. Keep the existing stack; ' +
        'do not add UI work to backend tasks.',
    },
    {
      id: 'engineering-quality',
      name: 'Engineering quality',
      version: 1,
      enabledByDefault: true,
      scope: 'engineering',
      instructions: ENGINEERING_GUIDANCE,
      promptInstructions:
        'Use readable feature-focused modules, shared domain rules, strict types and validation at data ' +
        'boundaries. Preserve authorization, exact values, user edits and async ownership. Backend work ' +
        'requires server-side validation, parameterized queries, deliberate duplicate handling and ' +
        'atomic related writes. Implement errors and recovery, clean up resources, run meaningful checks ' +
        'and report actual evidence. For dependency-free Node projects, Miter runs task-written *.test.mjs ' +
        'suites in isolation. See engineering-quality for pnpm framework previews, production audits and Node APIs.',
    },
  ]);

function renderSkills(skills: readonly BundledTaskSkill[]): string {
  return [
    'MITER BUILT-IN SKILLS (enabled by default; offline, version 1)',
    'Apply the relevant rules below to this task. The explicit user request, existing project constraints, ' +
      'permissions, checks and required JSON response format take precedence. These skills grant no tools ' +
      'or permissions and do not add features. Keep code and wire values literal. Return only the required ' +
      'JSON; place brief prose inside its allowed fields.',
    ...skills.map((skill) => `SKILL ${skill.id}: ${skill.name}\n${skill.promptInstructions}`),
  ].join('\n\n');
}

export function writingSkillsText(): string {
  return renderSkills(bundledTaskSkills.filter((skill) => skill.scope === 'writing'));
}

export function taskSkillsText(): string {
  return [
    renderSkills(bundledTaskSkills),
    'Read detailed built-in instructions with {"type":"skill","name":"app-design"} or another skill ' +
      'name above. This read-only action returns packaged text and reference assets; it never installs ' +
      'anything or writes project files. Reuse an already-read reference in this conversation.',
    'END MITER BUILT-IN SKILLS',
  ].join('\n\n');
}

export function readBundledTaskSkill(
  name: BundledTaskSkillId,
  asset?: BundledTaskAsset,
): BundledTaskSkillResource {
  const skill = bundledTaskSkills.find((candidate) => candidate.id === name);
  if (!skill) {
    throw new Error('The requested built-in skill is unavailable.');
  }
  const assets: BundledTaskSkillResource['assets'] = [];
  let instructions = skill.instructions;
  if (name === 'app-design') {
    if (asset === 'components.mjs') {
      assets.push({ path: 'components.mjs', content: APP_COMPONENTS_JS });
      instructions =
        'Reusable browser ES module. Use with the app-design foundation CSS. Read app-design without ' +
        'an asset for the markup, accessibility and quality-check contract. To copy the exact module use ' +
        '{"type":"write","path":"components.mjs","asset":"components.mjs","base":"missing"} for a new file, ' +
        'then import the functions your app uses.';
    } else {
      assets.push({ path: 'foundation.css', content: APP_FOUNDATION_CSS });
    }
  } else if (asset !== undefined) {
    throw new Error('Reference assets belong to the app-design skill.');
  }
  return bundledTaskSkillResourceSchema.parse({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    instructions,
    assets,
  });
}
