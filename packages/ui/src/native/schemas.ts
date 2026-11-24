import { z } from 'zod';

export const MenuItemSchema = z
  .object({
    id: z.string().describe('Stable action identifier used when updating an open menu.'),
    label: z.string().describe('Visible action label, always rendered as text.'),
    disabled: z.boolean().optional().describe('Whether this action is unavailable.'),
    danger: z.boolean().optional().describe('Whether the action is destructive.'),
    separatorBefore: z
      .boolean()
      .optional()
      .describe('Whether to separate this action from the previous group.'),
    shortcut: z.string().optional().describe('Displayed keyboard shortcut hint.'),
  })
  .describe('Menu presentation data; executable callbacks are separate plain types.');

export const TabItemSchema = z
  .object({
    id: z.string().describe('Registered project or task identifier.'),
    label: z.string().describe('Visible tab label rendered as text.'),
    title: z.string().optional().describe('Optional full tab tooltip.'),
  })
  .describe('Workspace tab presentation data.');

export const ToastKindSchema = z
  .enum(['success', 'info', 'warning', 'error'])
  .describe('Ephemeral notification severity.');

export const ToastInputSchema = z
  .object({
    message: z.string().describe('Notification message rendered as text, never markup.'),
    kind: ToastKindSchema.optional(),
    key: z.string().optional().describe('Optional deduplication key.'),
    duration: z.number().optional().describe('Requested visible duration, bounded by the toast center.'),
  })
  .describe('Ephemeral toast presentation data, excluding action callbacks.');

export const ToastViewSchema = z
  .object({
    id: z.string().describe('Local ephemeral notification identifier.'),
    message: z.string().describe('Visible notification text.'),
    kind: ToastKindSchema,
    busy: z.boolean().describe('Whether the toast action is in flight.'),
  })
  .describe('Visible toast state, excluding action callbacks.');
