/** Shared contract for every Parley tool. One definition powers both the MCP
 *  endpoint and the seller agent's own tool-calling loop. */

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  /** Who invoked this. Buyer agents arrive over MCP; the seller agent calls the same tools. */
  actor: 'buyer_agent' | 'seller_agent';
}

export interface ToolDefinition<Args = Record<string, unknown>> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** Tools that can move money or reserve stock. Surfaced to clients as a hint. */
  destructive?: boolean;
  readOnly?: boolean;
  handler: (args: Args, ctx: ToolContext) => Promise<unknown>;
}

export class ToolError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
  return value.trim();
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new ToolError(`"${key}" must be a number.`);
  return parsed;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ToolError(`"${key}" must be a boolean.`);
}
