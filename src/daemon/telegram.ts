// Telegram's Bot API: the two calls a notifier needs. Every call has a time limit, and a refusal carries Telegram's own words.
// The bot token is part of the address, so nothing here ever puts an address in an error.
// Where Telegram is and how long one call may take. Only a test passes anything but this.
export interface TelegramEndpoint { apiUrl: string; timeoutMs: number }
export const TELEGRAM: TelegramEndpoint = { apiUrl: "https://api.telegram.org", timeoutMs: 15_000 };

export class TelegramError extends Error {}

async function call(at: TelegramEndpoint, token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  let response: Response | undefined;
  // A dropped connection is tried once more, because a person not being told matters more than their being told twice.
  // A timeout isn't: the limit is the promise.
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      response = await fetch(`${at.apiUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(at.timeoutMs),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") throw new TelegramError(`Telegram didn't answer within ${at.timeoutMs / 1000} seconds.`);
      if (attempt < 2) continue;
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
      throw new TelegramError(`Telegram couldn't be reached, twice: ${cause.replaceAll(token, "<bot token>")}.`);
    }
  }
  let answer: { ok?: boolean; description?: string; result?: unknown };
  try {
    answer = await response.json() as typeof answer;
  } catch {
    throw new TelegramError(`Telegram answered with something unreadable (HTTP ${response.status}).`);
  }
  if (answer.ok !== true) throw new TelegramError(`Telegram refused: ${answer.description ?? `HTTP ${response.status}`}.`);
  return answer.result;
}

// The bot's own username, which also proves the token is real.
export async function botUsername(at: TelegramEndpoint, token: string): Promise<string> {
  const me = await call(at, token, "getMe", {}) as { username?: string };
  if (typeof me?.username !== "string") throw new TelegramError("Telegram accepted the token but didn't name a bot.");
  return me.username;
}

// The chat that wrote to the bot most recently, so a person doesn't have to find their own chat id. Asks without waiting.
// Offset -1 asks for the newest update alone: without it Telegram gives the oldest hundred, and "last" would be wrong on a
// bot with a backlog. Only a person's own chat counts, so a group the bot sits in is never picked by accident.
export async function latestChat(at: TelegramEndpoint, token: string): Promise<{ id: string; who: string } | { group: string } | undefined> {
  const updates = await call(at, token, "getUpdates", { offset: -1, timeout: 0, allowed_updates: ["message"] }) as { message?: { chat?: { id?: number | string; type?: string; username?: string; first_name?: string; title?: string } } }[];
  const chat = updates.at(-1)?.message?.chat;
  if (chat?.id === undefined) return undefined;
  if (chat.type !== "private") return { group: chat.title ?? String(chat.id) };
  return { id: String(chat.id), who: chat.username ? `@${chat.username}` : chat.first_name ?? String(chat.id) };
}

// Answers only once Telegram has accepted the message, with the ids Telegram gave: the chat's own number, which is what a
// reply will carry even if the chat was named as @something, and the message's.
export async function sendText(at: TelegramEndpoint, token: string, chatId: string, text: string): Promise<{ chatId: string; messageId: number }> {
  const sent = await call(at, token, "sendMessage", { chat_id: chatId, text }) as { message_id?: number; chat?: { id?: number | string } };
  if (typeof sent?.message_id !== "number" || sent.chat?.id === undefined) throw new TelegramError("Telegram accepted the message but didn't say where it went.");
  return { chatId: String(sent.chat.id), messageId: sent.message_id };
}
