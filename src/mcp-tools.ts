// How an operation becomes a tool, for every route that serves tools. It names no MCP SDK, so each route can bring its own.
import { z } from "zod";
import { DaemonGone, DaemonRefused } from "./ipc/client.ts";
import { DEFAULT_WAIT_SECONDS, OPERATIONS, type Operation, type Param } from "./ipc/operations.ts";

export const TOOL_OPERATIONS: readonly Operation[] = OPERATIONS.filter((op) => !op.personOnly && !op.programOnly);

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export async function asResult(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await work()) }] };
  } catch (err: unknown) {
    const code = err instanceof DaemonGone || err instanceof DaemonRefused ? err.code : "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], isError: true };
  }
}

function schemaOf(param: Param): z.ZodType {
  const base = param.allowed
    ? z.enum(param.allowed as [string, ...string[]])
    : param.kind === "number" ? z.number() : param.kind === "boolean" ? z.boolean() : z.string();
  const described = base.describe(param.description);
  return param.required && !param.daemonEnforced ? described : described.optional();
}

export function inputSchema(op: Operation): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  if (op.scoped) {
    shape["agent"] = z.string().describe("Your agent's name or agent_id. Every call names it.");
  }
  if (op.acts) {
    shape["force"] = z.boolean().optional().describe("Take the agent from another caller that holds it. Only when your operator means to move it here.");
  }
  for (const param of op.params) if (!param.programOnly) shape[param.name] = schemaOf(param);
  return shape;
}

// The caller comes from the route and never from the arguments. A tool can never say a person agreed: only the command line asks one.
export function toolParams(args: Record<string, unknown>, caller: string): Record<string, unknown> {
  const params: Record<string, unknown> = { ...args, caller };
  delete params["person_confirmed"];
  return params;
}

// A wait gets a longer limit than other calls, because it can last as long as the caller asked.
export function callLimitMs(op: Operation, args: Record<string, unknown>): number | undefined {
  return op.method === "wait" ? ((args["timeout_seconds"] as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000 + 10_000 : undefined;
}
