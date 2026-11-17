// Telegram's Bot API: the two calls a notifier needs. Every call has a time limit, and a refusal carries Telegram's own words.
// The bot token is part of the address, so nothing here ever puts an address in an error.
const TIMEOUT_MS = 15_000;

export class TelegramError extends Error {}

async function call(apiUrl: string, token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") throw new TelegramError(`Telegram didn't answer within ${TIMEOUT_MS / 1000} seconds.`);
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
    throw new TelegramError(`Telegram couldn't be reached: ${cause.replaceAll(token, "<bot token>")}.`);
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
export async function botUsername(apiUrl: string, token: string): Promise<string> {
  const me = await call(apiUrl, token, "getMe", {}) as { username?: string };
  if (typeof me?.username !== "string") throw new TelegramError("Telegram accepted the token but didn't name a bot.");
  return me.username;
}

// The chat that wrote to the bot most recently, so a person doesn't have to find their own chat id. Asks without waiting.
export async function latestChat(apiUrl: string, token: string): Promise<{ id: string; who: string } | undefined> {
  const updates = await call(apiUrl, token, "getUpdates", { timeout: 0, allowed_updates: ["message"] }) as { message?: { chat?: { id?: number | string; username?: string; first_name?: string; title?: string } } }[];
  const chat = [...updates].reverse().find((u) => u.message?.chat?.id !== undefined)?.message?.chat;
  if (chat?.id === undefined) return undefined;
  return { id: String(chat.id), who: chat.username ? `@${chat.username}` : chat.first_name ?? chat.title ?? String(chat.id) };
}

// Answers only once Telegram has accepted the message, with the id Telegram gave it.
export async function sendText(apiUrl: string, token: string, chatId: string, text: string): Promise<number> {
  const sent = await call(apiUrl, token, "sendMessage", { chat_id: chatId, text }) as { message_id?: number };
  if (typeof sent?.message_id !== "number") throw new TelegramError("Telegram accepted the message but gave it no id.");
  return sent.message_id;
}
