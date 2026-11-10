import { z } from 'zod';

/** A file window is a read-only, task-scoped viewer, never the workspace app. */
export const FileTargetSchema = z
  .object({
    workerId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .describe('Task identifier owning the viewed file.'),
    path: z
      .string()
      .min(1)
      .max(1000)
      .refine(
        (path) =>
          !/[\\\u0000-\u001f]/.test(path) &&
          !path.startsWith('/') &&
          !/^[a-zA-Z]:/.test(path) &&
          !path.split('/').some((part) => !part || part === '.' || part === '..'),
      )
      .describe('Project-relative file path, without traversal or control characters.'),
  })
  .describe('Read-only task-scoped file viewer target.');

export const FileWindowOptionsSchema = z
  .object({
    url: z.string().describe('Validated file viewer URL.'),
    type: z.literal('popup').describe('Separate read-only popup window.'),
    focused: z.boolean().describe('Whether to focus the new window.'),
    width: z.number().describe('Initial window width in CSS pixels.'),
    height: z.number().describe('Initial window height in CSS pixels.'),
    setSelfAsOpener: z.boolean().describe('Whether the workspace becomes the opener.'),
  })
  .describe('Browser window creation options for a file preview.');

export type FileTarget = z.infer<typeof FileTargetSchema>;

export function validateFileTarget(target: FileTarget): FileTarget {
  const result = FileTargetSchema.safeParse(target);

  if (!result.success) {
    if (result.error.issues.some((issue) => issue.path[0] === 'workerId')) {
      throw new Error('Invalid file task.');
    }

    throw new Error('Choose a project-relative file.');
  }

  return result.data;
}

export function filePreviewURL(base: string, target: FileTarget): string {
  const checked = validateFileTarget(target);
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('task', checked.workerId);
  url.searchParams.set('file', checked.path);
  return url.href;
}

export function parseFileTarget(url: string): FileTarget {
  const query = new URL(url).searchParams;
  const workerId = query.get('task');
  const path = query.get('file');

  if (
    query.getAll('task').length !== 1 ||
    query.getAll('file').length !== 1 ||
    workerId === null ||
    path === null
  ) {
    throw new Error('The file link is incomplete. Open the file again from Miter.');
  }

  return validateFileTarget({ workerId, path });
}

export function fileWindowOptions(url: string): z.infer<typeof FileWindowOptionsSchema> {
  return {
    url,
    type: 'popup',
    focused: true,
    width: 1080,
    height: 760,
    setSelfAsOpener: false,
  };
}
