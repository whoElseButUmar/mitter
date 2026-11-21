import { z } from 'zod';
import { APP_DESIGN_GUIDANCE, APP_FOUNDATION_CSS } from './task-skills/app-design.js';
import { APP_COMPONENTS_JS } from './task-skills/app-components.js';
import { ENGINEERING_GUIDANCE, PONYTAIL_GUIDANCE } from './task-skills/engineering.js';
import { VITE_API_JS } from './task-skills/vite-api.js';
import { CAVEMAN_GUIDANCE, NO_AI_SLOP_GUIDANCE } from './task-skills/writing.js';
import {
  bundledAssetOwner,
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
        'For UI work, read app-design before implementing controls. Keep the existing stack. Use shared ' +
        'theme tokens and styled controls, including menus, calendars and scroll areas. Keep native semantics, ' +
        'keyboard navigation, focus return, CSS :focus-visible and inset select indicators. ' +
        'Use the visible button text as its accessible name. Append row context after the full label when needed. ' +
        'Name icon-only buttons by action. Include a working favicon in the first page; engineering-quality ' +
        'supplies a ready-to-use icon. Preserve existing branding. Set hierarchy and density by task. ' +
        'Omit fake status dots, decorative arrows, generic card layouts and idle storage labels. ' +
        'Keep main and h1 visible during navigation and startup. During refresh keep records at full opacity ' +
        'and announce progress with a separate status. ' +
        'Add date ranges or presets only when needed. Read engineering-quality for miter.quality.json. ' +
        'Verify linked controls, isolated tests, Chrome journeys, accessibility and Lighthouse 100 in every ' +
        'scored desktop/mobile category. Fix failures without hiding content or weakening checks. ' +
        'Keep backend-only tasks scoped to the backend.',
    },
    {
      id: 'engineering-quality',
      name: 'Engineering quality',
      version: 1,
      enabledByDefault: true,
      scope: 'engineering',
      instructions: ENGINEERING_GUIDANCE,
      promptInstructions:
        'Share domain rules, validate on the server, parameterize queries and use atomic writes. Preserve ' +
        'inputs on failure. In new Vite TypeScript apps use ES2022, DOM and DOM.Iterable libs. With ' +
        'existing DOM-only libs use Array.from for NodeList array operations. For a new Vite ' +
        'backend, copy the vite-api.mjs write asset, register viteApi(handle, isPage) in vite.config.mjs and ' +
        'declare miter.backend.json. Store SQLite under the supplied dataDir. Use unique CSS selectors for ' +
        'journeys on both layouts. Read engineering-quality for exact wiring and isolated tests.',
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
    'Read a built-in skill with {"type":"skill","name":"app-design"} or another name above. ' +
      'Reuse references already read. Skill reads do not install or write files.',
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
  if (asset !== undefined && bundledAssetOwner[asset] !== name) {
    throw new Error('Read ' + asset + ' from ' + bundledAssetOwner[asset] + '.');
  }
  if (asset === 'vite-api.mjs') {
    assets.push({ path: asset, content: VITE_API_JS });
    instructions =
      'Vite development/preview plugin and Node HTTP API adapter. See engineering-quality for the route and storage contracts.';
  } else if (name === 'app-design') {
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
  }
  return bundledTaskSkillResourceSchema.parse({
    id: skill.id,
    name: skill.name,
    version: skill.version,
    instructions,
    assets,
  });
}
