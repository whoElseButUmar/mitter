import { z } from 'zod';
import { extensionIdentitySchema, installedPackageSchema } from '../installation/contracts.mjs';

const identifierSchema = z.string().min(1).describe('Chrome’s identifier for a page, session, or extension.');
const countSchema = z.number().int().nonnegative().describe('A count reported by Chrome.');
const responseIdSchema = z.number().int().positive().describe('The request number this reply answers.');
const dataSchema = z
  .record(z.string().describe('A DevTools protocol field name.'), z.json())
  .describe('JSON protocol fields; method-specific fields are validated by the caller.');
const absentFieldSchema = z.never().optional().describe('This field cannot occur in this envelope variant.');
const sessionSchema = identifierSchema.optional().describe('The page session, absent for browser commands.');

export const protocolMessageSchema = z
  .union([
    z
      .object({
        id: responseIdSchema,
        result: dataSchema,
        error: absentFieldSchema,
        method: absentFieldSchema,
        params: absentFieldSchema,
        sessionId: sessionSchema,
      })
      .describe('A successful DevTools command reply, never an error or event.'),
    z
      .object({
        id: responseIdSchema,
        error: z
          .object({
            code: z.number().int().describe('Chrome’s error code.'),
            message: z.string().min(1).describe('Why Chrome rejected the command.'),
          })
          .describe('A failed DevTools command.'),
        result: absentFieldSchema,
        method: absentFieldSchema,
        params: absentFieldSchema,
        sessionId: sessionSchema,
      })
      .describe('A failed DevTools command reply, never a result or event.'),
    z
      .object({
        method: z.string().min(1).describe('The event Chrome emitted.'),
        params: dataSchema.optional().describe('Event details, absent for events without fields.'),
        id: absentFieldSchema,
        result: absentFieldSchema,
        error: absentFieldSchema,
        sessionId: sessionSchema,
      })
      .describe('A DevTools event, never a command reply.'),
  ])
  .describe('A DevTools reply or event received over the private debugging pipe.');

export const chromeDiagnosticsSchema = z
  .array(protocolMessageSchema)
  .max(100)
  .describe('Bounded, validated DevTools diagnostic events retained before Chrome cleanup clears them.');

/** @typedef {z.infer<typeof chromeDiagnosticsSchema>} ChromeDiagnostics */

export const chromeLogNameSchema = z
  .string()
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.log$/)
  .describe('An optional release-log basename confined to .cache/release-checks; no directory paths.');

export const protocolRequestSchema = z
  .strictObject({
    id: responseIdSchema,
    method: z.string().min(1).describe('The DevTools command sent to Chrome.'),
    params: dataSchema.describe('JSON parameters for this DevTools command.'),
    sessionId: sessionSchema,
  })
  .describe('A numbered JSON command sent over the private Chrome debugging pipe.');

export const waitConditionSchema = z
  .boolean()
  .describe('Whether a browser readiness condition has completed; no truthy coercion is allowed.');

export const browserVersionSchema = z
  .object({ product: z.string().min(1).describe('The actual browser name and version.') })
  .describe('The browser version used for this live check.');

export const extensionIdSchema = z
  .object({ id: extensionIdentitySchema.shape.extensionId })
  .describe('The extension loaded into the temporary Chrome profile.');

export const targetIdSchema = z
  .object({ targetId: identifierSchema })
  .describe('The page created for a browser check.');

export const sessionIdSchema = z
  .object({ sessionId: identifierSchema })
  .describe('The debugging session attached to that page.');

export const pageNavigationSchema = z
  .object({
    frameId: identifierSchema.describe('The main frame selected by the navigation command.'),
    errorText: z.string().min(1).optional().describe('Why the navigation failed, absent on success.'),
  })
  .describe('Chrome navigation acknowledgement; an error must not be mistaken for page load.');

export const targetCloseSchema = z
  .object({ success: z.literal(true).describe('Chrome actually closed the requested page target.') })
  .describe('Successful closure of the owned Chrome page target.');

export const evaluationSchema = z
  .object({
    result: z
      .object({
        type: z
          .enum(['object', 'function', 'undefined', 'string', 'number', 'boolean', 'symbol', 'bigint'])
          .describe('The JavaScript value kind returned by Chrome.'),
        value: z
          .json()
          .optional()
          .describe(
            'The returned JSON value, absent for undefined or non-JSON results; checked by the caller.',
          ),
      })
      .describe('The value returned by the browser expression.'),
    exceptionDetails: dataSchema.optional().describe('Details present when the expression failed.'),
  })
  .describe('The result of executing a test expression in Chrome.');

const frameIdentitySchema = z
  .object({
    id: identifierSchema.describe('The frame selected for the preview sandbox probe.'),
    url: z.string().describe('The frame’s complete URL, including its release-fixture query.'),
  })
  .describe('Frame identity reported by DevTools; unrelated frame metadata is ignored.');

export const previewFrameTreeSchema = z
  .object({
    frameTree: z
      .object({
        frame: frameIdentitySchema,
        childFrames: z
          .array(z.object({ frame: frameIdentitySchema }).describe('One direct child frame.'))
          .optional()
          .describe('Direct children of this target, absent when it has none.'),
      })
      .describe('The target root and direct children needed to locate the outer preview sandbox.'),
  })
  .describe('The bounded portion of a DevTools frame tree used by the preview check.');

export const browserTargetsSchema = z
  .object({
    targetInfos: z
      .array(
        z
          .object({
            targetId: identifierSchema.describe(
              'The target ID for the matching extension view or preview frame.',
            ),
            type: z
              .string()
              .min(1)
              .describe('The target kind used to distinguish extension pages and sandbox frames.'),
            url: z.string().describe('The complete URL used for exact target selection.'),
          })
          .describe('One available DevTools target; unrelated target metadata is ignored.'),
      )
      .describe('Targets available through this private Chrome debugging pipe.'),
  })
  .describe('Page and frame targets in the isolated release-check browser.');

export const previewWorldSchema = z
  .object({
    executionContextId: z.number().int().positive().describe('The isolated inspection world’s context ID.'),
  })
  .describe('An inspection world created without universal cross-origin access.');

export const previewFixtureSchema = z
  .strictObject({
    html: z.string().max(4096).describe('The exact bounded HTML supplied by this local regression fixture.'),
    ready: z
      .array(
        z.strictObject({
          frame: z.enum(['preview', 'peer']).describe('Which pinned outer WindowProxy emitted readiness.'),
          origin: z.string().describe('The serialized origin of that browser-dispatched ready message.'),
        }),
      )
      .max(10)
      .describe('Canonical ready messages received only from the two expected outer sandbox windows.'),
    innerReady: countSchema.describe('Canonical render acknowledgements from the pinned inner window.'),
    innerOrigin: z.string().describe('The inner acknowledgement’s origin, empty before it arrives.'),
    malformedSent: countSchema.describe('Malformed parent payloads sent before the valid document.'),
  })
  .describe('Source-only fixture observations; real sandbox behavior is inspected separately by DevTools.');

/** @typedef {z.infer<typeof previewFixtureSchema>} PreviewFixtureState */

export const previewProbeSchema = z
  .strictObject({
    parentMessages: countSchema.describe('Browser messages observed from the sandbox’s actual parent.'),
    foreignMessages: countSchema.describe('Browser messages observed from other WindowProxy identities.'),
    foreignOrigin: z.string().describe('The last foreign sender’s serialized origin, empty before receipt.'),
    installations: countSchema.describe('Inner iframes added to the sandbox body during this probe.'),
    frames: countSchema.describe('Inner iframes currently present in the sandbox body.'),
    html: z.string().max(8192).describe('The exact inner srcdoc attribute, including its CSP prefix.'),
    sandbox: z.string().describe('The inner iframe’s sandbox tokens, empty before creation.'),
    referrerPolicy: z.string().describe('The inner iframe’s referrer policy, empty before creation.'),
    title: z.string().describe('The accessible inner iframe title, empty before creation.'),
    nativeAccess: z.boolean().describe('Whether the outer sandbox exposes an extension runtime API.'),
  })
  .describe('Bounded DOM and sender observations from an unprivileged DevTools world in the real sandbox.');

/** @typedef {z.infer<typeof previewProbeSchema>} PreviewProbeState */

export const nativeCheckSchema = z
  .strictObject({
    version: installedPackageSchema.shape.version.describe('The verified native host release version.'),
    projectId: z.string().min(1).describe('The project registered in the temporary database.'),
    root: z.string().min(1).describe('The exact temporary project folder read back from the host.'),
    initialProjects: z.literal(0).describe('The empty project count before the smoke mutation.'),
    projects: z.literal(1).describe('The single project saved by the smoke check.'),
    workers: z.literal(0).describe('No tasks were started during native verification.'),
  })
  .describe('A real production client, background transport, and isolated native-host round trip.');

export const domCountersSchema = z
  .object({ documents: countSchema, nodes: countSchema, jsEventListeners: countSchema })
  .describe('Chrome’s document, DOM node, and event listener counts after collection.');

export const packagedStylesheetsSchema = z
  .strictObject({
    url: z.string().min(1).max(4096).describe('The complete URL of the workspace page reporting its styles.'),
    stylesheets: z
      .array(
        z
          .strictObject({
            href: z
              .string()
              .min(1)
              .max(4096)
              .describe('The resolved URL of one external stylesheet, in document cascade order.'),
            media: z.string().max(512).describe('The stylesheet’s media condition, empty for all media.'),
            loaded: z.literal(true).describe('Chrome has loaded this stylesheet, not only its link element.'),
            disabled: z.literal(false).describe('The stylesheet is enabled on the packaged workspace.'),
          })
          .describe('One loaded, enabled external stylesheet reported by Chrome.'),
      )
      .min(1)
      .max(32)
      .describe(
        'Every workspace stylesheet in document order, with no inline or source-only fallback styles.',
      ),
  })
  .describe('Bounded Chrome observations used to give the release fixture the packaged workspace’s CSS.');

const layoutRectSchema = z
  .strictObject({
    left: z.number().finite().describe('The left edge in CSS pixels relative to the viewport.'),
    top: z.number().finite().describe('The top edge in CSS pixels relative to the viewport.'),
    right: z.number().finite().describe('The right edge in CSS pixels relative to the viewport.'),
    bottom: z.number().finite().describe('The bottom edge in CSS pixels relative to the viewport.'),
  })
  .refine((rect) => rect.right > rect.left && rect.bottom > rect.top)
  .describe('A nonempty, finite browser layout rectangle; scrolling may place it outside the viewport.');

const layoutItemSchema = z
  .strictObject({
    text: z
      .string()
      .min(1)
      .max(200)
      .describe('The complete visible label of this control or runner message.'),
    tag: z.enum(['BUTTON', 'SPAN']).describe('The native element used for this runner or recovery item.'),
    rect: layoutRectSchema,
  })
  .describe('One production runner or recovery item measured independently of its container.');

export const attentionLayoutSchema = z
  .strictObject({
    viewport: z
      .strictObject({
        width: countSchema.positive().describe('The emulated panel width in CSS pixels.'),
        height: countSchema.positive().describe('The emulated panel height in CSS pixels.'),
      })
      .describe('The emulated panel size in CSS pixels.'),
    project: z
      .strictObject({
        rect: layoutRectSchema,
        clientWidth: countSchema.positive().describe('The project pane’s available width in CSS pixels.'),
        scrollWidth: countSchema.positive().describe('The project pane’s content width in CSS pixels.'),
      })
      .describe('The existing project scroll owner, which must not require horizontal scrolling.'),
    status: layoutRectSchema,
    statusLabel: layoutRectSchema,
    summary: layoutRectSchema,
    summaryLines: z
      .array(layoutRectSchema)
      .min(1)
      .max(512)
      .describe('Every rendered line of the full reason.'),
    reason: z.string().min(1).max(4096).describe('The complete reason read back from the production status.'),
    role: z.string().nullable().describe('The status region’s accessibility role, or no attribute.'),
    live: z.string().nullable().describe('The status region’s live announcement setting, or no attribute.'),
    runner: layoutRectSchema,
    runnerItems: z.array(layoutItemSchema).min(1).max(8).describe('Runner items in DOM reading order.'),
    recovery: layoutRectSchema,
    recoveryItems: z.array(layoutItemSchema).min(2).max(3).describe('Native recovery buttons in DOM order.'),
    error: layoutRectSchema.nullable().describe('A separate task error banner, absent when not needed.'),
    editor: layoutRectSchema,
    console: layoutRectSchema.nullable().describe('The open Console, absent when closed.'),
    domOrder: z.boolean().describe('Whether status, runner, recovery, and editor retain DOM reading order.'),
  })
  .describe('Bounded Chrome geometry from the actual production task view and its complete status text.');

export const fixtureStateSchema = z
  .strictObject({
    dialogs: countSchema.describe('The number of open dialogs in the production fixture.'),
    title: z.string().describe('The current dialog heading.'),
    sameTreeLabel: z.boolean().describe('Whether the dialog refers to its own heading.'),
    activeId: z.string().describe('The focused element’s ID, or an empty string.'),
    replacementDraft: z.string().describe('The newer dialog’s editable text.'),
    fields: z
      .array(
        z.strictObject({
          value: z.string().describe('The current input text.'),
          userInvalid: z.boolean().describe('Whether Chrome now considers this input user-invalid.'),
          ariaInvalid: z.string().nullable().describe('The accessible invalid state, or no attribute.'),
          focused: z.boolean().describe('Whether this input has keyboard focus.'),
        }),
      )
      .describe('Required native inputs in the current form.'),
    alerts: z
      .array(
        z.strictObject({
          text: z.string().describe('The error message displayed in the dialog.'),
          visible: z.boolean().describe('Whether the error has a visible layout box.'),
        }),
      )
      .describe('In-dialog error announcements.'),
    busy: z.boolean().describe('Whether a form submission is still waiting.'),
    pendingSaves: z
      .array(
        z.strictObject({
          id: countSchema.describe('The controlled save sequence number.'),
          name: z.string().describe('The project name captured for this save.'),
          root: z.string().describe('The project folder captured for this save.'),
        }),
      )
      .describe('Controlled saves awaiting completion; these do not reach the native host.'),
    closes: countSchema.describe('The number of dialog close callbacks observed by the fixture.'),
    navigation: z.string().describe('The destination selected by the production callback.'),
    preview: z
      .strictObject({
        bytes: countSchema.describe('The number of preview bytes retained by the production owner.'),
        url: z.string().describe('The preview’s Blob URL, empty after release.'),
        source: z.string().describe('Decoded preview text, empty after release.'),
        error: z.string().describe('The preview error, empty when none is shown.'),
        loading: z.boolean().describe('Whether the preview is still loading.'),
      })
      .describe('Retained production preview state, including after disposal.'),
    fontCount: countSchema.describe('The number of FontFace objects currently in the document font set.'),
    fontReady: z.boolean().describe('Whether production font preferences finished loading.'),
    savedFonts: countSchema.describe('The number of private font byte records retained after disposal.'),
    systemFonts: countSchema.describe('The number of system font records retained after disposal.'),
    fontErrors: z.array(z.string()).describe('Font errors observed during this check.'),
  })
  .describe('JSON observations from actual production UI mounted in Chrome with controlled RPCs.');
