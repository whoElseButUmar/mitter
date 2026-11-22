import { z } from 'zod';

const selector = z.string().min(1).max(300).describe('A literal CSS selector identifying rendered controls.');
export const browserStepSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('click'), selector }),
    z.strictObject({ type: z.literal('fill'), selector, value: z.string().max(2000) }),
    z.strictObject({
      type: z.literal('press'),
      key: z.enum([
        'Tab',
        'Shift+Tab',
        'Enter',
        'Escape',
        'Space',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
      ]),
    }),
    z.strictObject({ type: z.literal('reload') }),
    z
      .strictObject({
        type: z.literal('expect'),
        selector,
        visible: z.boolean().optional(),
        text: z.string().max(2000).optional(),
        value: z.string().max(2000).optional(),
        count: z.number().int().min(0).max(1000).optional(),
        focused: z.boolean().optional(),
        checked: z.boolean().optional(),
      })
      .refine(
        (value) => Object.keys(value).some((key) => key !== 'type' && key !== 'selector'),
        'Specify an observable expectation.',
      )
      .refine(
        (value) =>
          value.count !== 0 ||
          (value.text === undefined &&
            value.value === undefined &&
            value.focused === undefined &&
            value.checked === undefined &&
            value.visible !== true),
        'An absent element cannot have text, value, focus or visible:true expectations.',
      ),
  ])
  .describe('A browser-owned interaction or observable assertion, never executable project code.');

export const browserJourneySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100).describe('The user outcome or failure recovery exercised.'),
    steps: z
      .array(browserStepSchema)
      .min(2)
      .max(32)
      .describe('Ordered actions and assertions; repeated at desktop and mobile sizes.'),
  })
  .refine(
    ({ steps }) =>
      steps.some((value) => value.type !== 'expect') && steps.some((value) => value.type === 'expect'),
    'Every journey needs an action and an observable assertion.',
  )
  .describe(
    'An isolated journey starting with fresh browser storage. Reload preserves that journey’s storage.',
  );

export const browserJourneysSchema = z
  .array(browserJourneySchema)
  .min(1)
  .max(6)
  .refine(
    (values) => new Set(values.map((value) => value.name)).size === values.length,
    'Use distinct journey names.',
  )
  .describe(
    'Required product journeys. Cover the main task, invalid input, persistence and keyboard dialog behavior when present.',
  );

export type BrowserJourney = z.infer<typeof browserJourneySchema>;

export const backendJourneyEvidenceSchema = z
  .array(
    z.strictObject({
      device: z.enum(['desktop', 'mobile']),
      journey: z.string().min(1).max(100),
    }),
  )
  .max(12)
  .describe('Journeys that read back a newly submitted value from the real API after clearing browser data.');

export type BrowserQualityResult = {
  ok: boolean;
  browserOk: boolean;
  lighthouseOk: boolean;
  findings: string[];
  scores: { device: 'desktop' | 'mobile'; categories: Record<string, number | null> }[];
  reports: string[];
  lighthouseRetries?: { device: 'desktop' | 'mobile'; reason: 'NO_NAVSTART' }[];
  backend?: z.infer<typeof backendJourneyEvidenceSchema>;
};
