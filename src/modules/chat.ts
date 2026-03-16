import OpenAI from 'openai';
import {
  getMemory, saveMemory, pruneMemory, countMemory,
  getOldestNonSummaryMessages, deleteMessagesByIds,
  getUserFacts, saveUserFact, FactCategory,
  listPendingTasks, getEnabledGoogleAccounts,
} from '../db/database';

const TZ = 'America/Sao_Paulo';
const MEMORY_LIMIT = 20;
const SUMMARISE_THRESHOLD = 24; // summarise when count exceeds this

let openai: OpenAI;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ---------------------------------------------------------------------------
// Summarise oldest messages into a single compact entry
// ---------------------------------------------------------------------------

async function maybeSummariseMemory(phone: string): Promise<void> {
  const count = countMemory(phone);
  if (count <= SUMMARISE_THRESHOLD) return;

  const oldest = getOldestNonSummaryMessages(phone, 10);
  if (oldest.length < 4) return; // not worth summarising

  try {
    const convo = oldest
      .map((m) => `${m.role === 'user' ? 'Usuário' : 'Bot'}: ${m.content}`)
      .join('\n');

    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Resuma a conversa abaixo em 2-3 frases em português, preservando fatos importantes sobre o usuário e as tarefas/assuntos discutidos. Seja conciso.',
        },
        { role: 'user', content: convo },
      ],
    });

    const summary = completion.choices[0]?.message?.content?.trim() ?? '';
    if (!summary) return;

    // Delete the messages we summarised
    deleteMessagesByIds(oldest.map((m) => m.id));

    // Save as a summary entry
    saveMemory(phone, 'assistant', `[Resumo de conversa anterior: ${summary}]`, true);

    console.log(`[chat] Summarised ${oldest.length} messages for ${phone}`);
  } catch (err) {
    console.warn('[chat] Summarisation failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Build contextual system prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(phone: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: TZ,
  });
  const timeStr = now.toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  });

  // Pending tasks (up to 5)
  let tasksCtx = 'Nenhuma tarefa pendente.';
  try {
    const tasks = listPendingTasks(phone).slice(0, 5);
    if (tasks.length > 0) {
      tasksCtx = tasks
        .map((t) => {
          const when = t.due_date ? ` (${t.due_date.split('-').reverse().join('/')}${t.due_time ? ' ' + t.due_time : ''})` : '';
          return `• ${t.title}${when}`;
        })
        .join('\n');
    }
  } catch { /* non-fatal */ }

  // Google accounts linked
  let accountsCtx = '';
  try {
    const accounts = getEnabledGoogleAccounts();
    if (accounts.length > 0) {
      accountsCtx = `\nCONTAS GOOGLE VINCULADAS: ${accounts.map((a) => a.email).join(', ')}`;
    }
  } catch { /* non-fatal */ }

  // User facts (up to 10 most recently used)
  let factsCtx = 'Ainda não há informações salvas sobre o usuário.';
  try {
    const facts = getUserFacts(phone, 10);
    if (facts.length > 0) {
      factsCtx = facts.map((f) => `• ${f.fact}`).join('\n');
    }
  } catch { /* non-fatal */ }

  return [
    `Você é um assistente pessoal via WhatsApp. Hoje é ${dateStr}, ${timeStr} (horário de Brasília, GMT-3).`,
    '',
    'TAREFAS PENDENTES DO USUÁRIO:',
    tasksCtx,
    accountsCtx,
    '',
    'FATOS SOBRE O USUÁRIO (lembranças de conversas anteriores):',
    factsCtx,
    '',
    'INSTRUÇÕES:',
    '• Responda de forma concisa e prática em português. Máximo 10 linhas.',
    '• Use formatação WhatsApp quando útil (*bold*, _italic_).',
    '• Se o usuário perguntar sobre agenda, tarefas ou e-mails, sugira o comando correspondente.',
    '• Seja amigável mas direto ao ponto.',
  ].filter((l) => l !== undefined).join('\n');
}

// ---------------------------------------------------------------------------
// Async fact extraction (non-blocking — runs in background)
// ---------------------------------------------------------------------------

async function extractAndStoreFacts(
  phone: string,
  userMessage: string,
  botReply: string,
): Promise<void> {
  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Analise esta troca de mensagens e extraia fatos duradouros sobre o usuário úteis em conversas futuras.
Retorne APENAS JSON: {"facts":[{"fact":"string","category":"preference|project|person|habit|general"}]}

REGRAS:
- Só extraia fatos úteis em FUTURAS conversas
- Ignore fatos triviais ("está com fome", "vai almoçar agora")
- Foque em: projetos em andamento, preferências, nomes de pessoas/clientes, rotinas, objetivos
- Se não houver nada relevante, retorne {"facts":[]}
- Máximo 3 fatos por extração`,
        },
        {
          role: 'user',
          content: `Usuário: ${userMessage.slice(0, 500)}\nBot: ${botReply.slice(0, 500)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let parsed: { facts?: { fact: string; category: string }[] };
    try { parsed = JSON.parse(raw); } catch { return; }

    const validCategories: FactCategory[] = ['preference', 'project', 'person', 'habit', 'general'];
    for (const item of parsed.facts ?? []) {
      if (typeof item.fact !== 'string' || item.fact.trim().length < 5) continue;
      const category = validCategories.includes(item.category as FactCategory)
        ? (item.category as FactCategory)
        : 'general';
      saveUserFact(phone, item.fact.trim(), category);
    }
  } catch (err) {
    // Non-fatal — fact extraction should never affect response
    console.warn('[chat] Fact extraction failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Main chat function
// ---------------------------------------------------------------------------

export async function chat(phone: string, message: string): Promise<string> {
  // 1. Summarise if conversation is too long (async, non-blocking for this turn)
  maybeSummariseMemory(phone).catch(() => {});

  // 2. Persist user message
  saveMemory(phone, 'user', message);

  // 3. Build messages array: contextual system prompt + history
  const history = getMemory(phone, MEMORY_LIMIT);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(phone) },
    ...history.map((entry) => ({
      role: entry.role as 'user' | 'assistant',
      content: entry.content,
    })),
  ];

  // 4. Call GPT-4o-mini
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
  });

  const reply = completion.choices[0]?.message?.content?.trim() ?? '';

  // 5. Persist assistant reply and prune history
  saveMemory(phone, 'assistant', reply);
  pruneMemory(phone, MEMORY_LIMIT);

  // 6. Extract facts asynchronously (does not block response)
  extractAndStoreFacts(phone, message, reply).catch(() => {});

  return reply;
}
