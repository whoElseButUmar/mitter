import { z } from 'zod';

export const readinessParamsSchema = z
  .strictObject({})
  .describe('Read host prerequisites without accepting paths, programs or execution options.');

export const readinessCheckSchema = z
  .strictObject({
    status: z
      .enum(['ready', 'unavailable'])
      .describe('Whether the prerequisites are available; ready does not mean a check has passed.'),
    detail: z.string().min(1).max(1000).describe('What is available or why this capability cannot run.'),
    hint: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('A concrete next step when a prerequisite is missing or verification needs another route.'),
  })
  .describe('Read-only prerequisite availability, not execution or test evidence.');

export const readinessSchema = z
  .strictObject({
    version: z.literal(1).describe('Readiness report format version.'),
    node: z.string().min(1).max(120).describe('The version of Node running the native host.'),
    platform: z.string().min(1).max(120).describe('The host operating-system platform reported by Node.'),
    architecture: z.string().min(1).max(120).describe('The host process architecture reported by Node.'),
    webChecks: readinessCheckSchema.describe('Availability of all mandatory automatic web-app checks.'),
    checks: z
      .strictObject({
        source: readinessCheckSchema.describe('Availability of bounded source and JavaScript syntax checks.'),
        domain: readinessCheckSchema.describe('Availability of isolated execution of declared domain tests.'),
        browser: readinessCheckSchema.describe(
          'Installed Chrome availability for isolated browser journeys and Lighthouse audits.',
        ),
      })
      .describe('Separate source, domain-test and rendered-browser capabilities.'),
    notice: z.string().min(1).max(1000).describe('The scope and limits of this prerequisite inspection.'),
  })
  .describe('Read-only host readiness; no supplied code, isolation probe, browser or network request runs.');

export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
