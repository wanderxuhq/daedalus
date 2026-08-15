import type { Tool } from '../tools/types.ts';

/**
 * Validate a tool-call input against the tool's declared JSON schema. Returns
 * null when the input satisfies every required field, or a short, actionable
 * error message naming the missing/mistyped field so the model can retry.
 *
 * This is the safety net for malformed model output: the schema's `required`
 * list is only a hint to the model — nothing stops it from emitting an `edit`
 * call without a `path`. Without this check the raw Node TypeError
 * (`isAbsolute(undefined)`) leaks to the user instead of a clear instruction.
 */
export function validateToolInput(tool: Tool, input: unknown): string | null {
  const schema = tool.inputSchema as {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  if (schema?.type !== 'object' || !schema.properties) return null;
  const required = schema.required ?? [];
  if (required.length === 0) return null;

  if (input === null || typeof input !== 'object') {
    return `${tool.name}: tool call input must be an object (required: ${required.join(', ')})`;
  }
  const obj = input as Record<string, unknown>;
  for (const key of required) {
    const value = obj[key];
    const type = schema.properties[key]?.type ?? 'string';
    if (value === undefined || value === null) {
      return `${tool.name}: missing required "${key}" (${type}). Retry the call with all required fields: ${required.join(', ')}`;
    }
    if (type === 'string' && typeof value !== 'string') {
      return `${tool.name}: "${key}" must be a ${type}, got ${typeof value}. Retry with a valid value.`;
    }
  }
  return null;
}
