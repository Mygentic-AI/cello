// Holding an agent and being woken for it are separate. Any call can take hold of an agent nobody holds, but doorbells go only to
// a session that took it with use_agent. After a fork, a reconnect or a daemon restart, a session can be sending as an agent with
// no doorbell wired to it: it talks, and never hears the replies. Seen 2026-11-18, when Claude Code forked a window in the
// background. So a send, or a new session, says so when the caller isn't one that will be woken.
//
// Only MCP sessions are told. They rely on doorbells. The command line and programs such as the Hermes bridge wait for
// themselves, and every send of theirs would carry it.
export function doorbellWarning(listeners: Iterable<{ caller: string; onBell?: unknown }>, caller: string, agentName: string): string | undefined {
  if (!caller.startsWith("mcp:")) return undefined;
  // A wait in progress (onBell) ends at its first doorbell, so it isn't what wakes a session for good.
  const ringing = [...listeners].filter((listener) => !listener.onBell);
  if (ringing.some((listener) => listener.caller === caller)) return undefined;
  if (ringing.length > 0) return `Another session is set to be woken for ${agentName}, not this one, so replies will wake that session. To hear them here, take the agent with cello_use_agent and force.`;
  return `This session isn't set to be woken for ${agentName}, so nothing will tell you when a reply comes. Take the agent with cello_use_agent.`;
}
