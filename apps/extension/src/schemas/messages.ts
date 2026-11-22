import { z } from 'zod';
import { dataResetStateSchema } from '../../../../packages/bridge/src/data-reset.js';
import { bridgeStatusSchema } from '../../../../packages/bridge/src/runner/types.js';
import { debugEntrySchema } from '../../../../packages/bridge/src/diagnostics.js';
import { snapshotSchema } from './host-results.js';
import { buildIdSchema, requestSchema, responseSchema } from '../../../../packages/protocol/src/index.js';
import { WorkspaceStateSchema } from '../../../../packages/ui/src/workspace.js';
import { identifierSchema, parametersSchema } from './primitives.js';

export const rpcRequestSchema = requestSchema
  .extend({ params: parametersSchema })
  .describe('An authenticated view request with explicit object parameters, checked by its capability.');

export const rpcResponseSchema = responseSchema;
export const workspaceStateSchema = WorkspaceStateSchema;

export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean().describe('Whether desktop notifications are enabled.'),
    sound: z.boolean().describe('Whether task notifications play a quiet chime.'),
  })
  .describe('Saved task notification preferences.');

export const savedNotificationPreferencesSchema = notificationPreferencesSchema
  .extend({
    enabled: notificationPreferencesSchema.shape.enabled
      .catch(false)
      .describe('Whether saved notifications are enabled; malformed values turn them off.'),
    sound: notificationPreferencesSchema.shape.sound
      .catch(false)
      .describe('Whether saved notification sounds are enabled; malformed values turn them off.'),
  })
  .catch({ enabled: false, sound: false })
  .describe('Saved preferences with invalid values turned off.');

export const notificationStorageSchema = z
  .object({
    'miter.notifications.v1': savedNotificationPreferencesSchema,
  })
  .describe('The Chrome storage response containing independently migrated notification preferences.');

export const notificationChangeSchema = notificationPreferencesSchema
  .partial()
  .strict()
  .describe('An explicit partial change to notification preferences.');

export const auxiliaryMessageSchema = z
  .discriminatedUnion('event', [
    z.object({
      event: z.literal('taskNotification'),
      data: z
        .object({
          workerId: identifierSchema,
          kind: z.enum(['warning', 'success', 'error']).describe('The notice severity.'),
          message: z.string().describe('The task notification text.'),
          setupApproval: z
            .literal(true)
            .optional()
            .describe('This notice opens the task’s pending setup command.'),
        })
        .describe('A task transition notice.'),
    }),
    z.object({
      event: z.literal('notificationSettings'),
      data: notificationPreferencesSchema,
    }),
    z.object({ event: z.literal('ding') }),
    z.object({ event: z.literal('debug'), data: z.array(debugEntrySchema) }),
    z.object({
      event: z.literal('bridges'),
      data: z.array(bridgeStatusSchema),
    }),
    z.object({ event: z.literal('workspace'), data: workspaceStateSchema }),
    z.object({
      event: z.literal('workspaceError'),
      error: z.string().describe('The workspace write failure.'),
    }),
  ])
  .describe('Validated non-RPC updates published to extension views.');

export const snapshotMessageSchema = z
  .object({
    event: z.literal('snapshot'),
    data: snapshotSchema,
  })
  .describe('An authoritative host snapshot event.');

const peerBuildSchema = z
  .object({
    version: z.string(),
    buildId: buildIdSchema.optional(),
  })
  .describe('A release and optional build fingerprint reported by a live connection.');

export const connectionMessageSchema = z
  .object({
    event: z.literal('connection'),
    connected: z.boolean().describe('Whether the host version is compatible.'),
    error: z.string().optional().describe('Why the host is unavailable or incompatible.'),
    helper: peerBuildSchema.optional().describe('Live identity from the current native port, if available.'),
  })
  .describe('Host connection status.');

export const nativeMessageSchema = z
  .union([
    snapshotMessageSchema,
    rpcResponseSchema,
    z.object({
      event: z.literal('resetRequired'),
      version: z.string().optional().describe('Local helper release during reset recovery.'),
      buildId: buildIdSchema.optional().describe('Local helper build during reset recovery.'),
      error: z.string().optional().describe('Why the native reset requires recovery.'),
    }),
  ])
  .describe('A decoded native host message.');

export const uiControlSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('hello'),
      id: identifierSchema,
      version: z.string().min(1).describe('The version compiled into the connecting view.'),
      buildId: buildIdSchema.optional().describe('The compiled view build, when available.'),
    }),
    z.object({ type: z.literal('ping'), id: identifierSchema }),
    z.object({ type: z.literal('reconnect') }),
  ])
  .describe('A view version challenge, liveness ping, or explicit host reconnect.');

export const backgroundHelloSchema = z
  .object({
    type: z.literal('hello'),
    id: identifierSchema,
    version: z.string().min(1).describe('The version compiled into the running background.'),
    buildId: buildIdSchema.optional().describe('The compiled background build, when available.'),
    helper: peerBuildSchema.optional().describe('Current native identity, when the helper is connected.'),
  })
  .describe('The background version returned for an exact view challenge.');

export const pongSchema = z
  .object({ type: z.literal('pong'), id: identifierSchema })
  .describe('An exact response to a view liveness challenge.');

export const resetStartSchema = z
  .object({
    type: z.literal('reset-start'),
    id: identifierSchema,
    confirmation: z.string().describe('The text typed by the user; the reset coordinator requires CLEAR.'),
  })
  .describe('An explicit destructive reset request; it is never replayed.');

export const resetMessageSchema = z
  .union([
    z.object({ type: z.literal('reset-state'), state: dataResetStateSchema }),
    z.object({
      type: z.literal('reset-quiesce'),
      id: identifierSchema,
      identify: z.boolean().optional().describe('Whether to prove this document with a URL challenge.'),
    }),
    z.object({ type: z.literal('reset-identified'), id: identifierSchema }),
    z.object({ id: identifierSchema, ok: z.literal(true) }),
    z.object({
      id: identifierSchema,
      ok: z.literal(false),
      error: z.string().optional().describe('The reset failure explanation.'),
    }),
  ])
  .describe('Reset state, document challenges, and exact destructive-request acknowledgements.');

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type AuxiliaryMessage = z.infer<typeof auxiliaryMessageSchema>;
export type RPCResponse = z.infer<typeof rpcResponseSchema>;
