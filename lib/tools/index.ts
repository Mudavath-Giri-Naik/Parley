import { checkMandateTool, createMandateTool } from './checkMandate';
import { checkOrderStatusTool } from './checkOrderStatus';
import { checkStockTool } from './checkStock';
import { createOrderAndPayTool } from './createOrderAndPay';
import { getAuditTrailTool } from './getAuditTrail';
import { getProductDetailsTool } from './getProductDetails';
import { searchProductsTool } from './searchProducts';
import type { ToolDefinition } from './types';

/**
 * The tool registry. These are the capabilities Parley exposes to a buyer agent over
 * MCP, and the same set the seller agent reasons with. One definition, two consumers.
 */
export const tools: ToolDefinition[] = [
  searchProductsTool,
  getProductDetailsTool,
  checkStockTool,
  checkMandateTool,
  createMandateTool,
  createOrderAndPayTool,
  checkOrderStatusTool,
  getAuditTrailTool,
];

export function findTool(name: string, extra: ToolDefinition[] = []): ToolDefinition | undefined {
  return [...tools, ...extra].find((tool) => tool.name === name);
}

export type { ToolDefinition } from './types';
