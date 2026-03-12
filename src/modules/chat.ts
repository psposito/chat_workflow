import OpenAI from 'openai';
import { getMemory, saveMemory, pruneMemory } from '../db/database';

const SYSTEM_PROMPT =
  'Você é um assistente no WhatsApp. Responda de forma clara, objetiva e amigável. Máximo 8 linhas.';

const MEMORY_LIMIT = 10;

let openai: OpenAI;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export async function chat(phone: string, message: string): Promise<string> {
  // 1. Persist the incoming user message
  saveMemory(phone, 'user', message);

  // 2. Build messages array: system prompt + conversation history
  const history = getMemory(phone, MEMORY_LIMIT);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((entry) => ({
      role: entry.role as 'user' | 'assistant',
      content: entry.content,
    })),
  ];

  // 3. Call GPT-4o-mini
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
  });

  const reply = completion.choices[0]?.message?.content?.trim() ?? '';

  // 4. Persist the assistant reply and keep history bounded
  saveMemory(phone, 'assistant', reply);
  pruneMemory(phone, MEMORY_LIMIT);

  return reply;
}
