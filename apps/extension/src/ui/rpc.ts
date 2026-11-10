import type { z } from 'zod';

export type ViewRPC = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export async function callResult<Result>(
  rpc: ViewRPC,
  schema: z.ZodType<Result>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Result> {
  const result = await rpc(method, params);

  const parsed = schema.safeParse(result);

  if (!parsed.success) {
    throw new Error(
      'Miter could not read the response to ' +
        method +
        '. The action was not retried. Check its current state before repeating it.',
      { cause: parsed.error },
    );
  }

  return parsed.data;
}
