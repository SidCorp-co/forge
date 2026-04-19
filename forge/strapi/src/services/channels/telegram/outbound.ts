import { Bot } from 'grammy';
import { chunkText } from '../chunker';
import { markdownToTelegramHtml } from './format';

export async function sendTelegramReply(
  bot: Bot,
  chatId: string,
  text: string,
  maxChunkSize: number,
): Promise<void> {
  const chunks = chunkText(text, maxChunkSize);
  for (const chunk of chunks) {
    const html = markdownToTelegramHtml(chunk);
    await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
  }
}
