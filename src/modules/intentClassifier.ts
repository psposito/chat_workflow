import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Intent =
  | 'help'
  | 'datetime'
  | 'calendar_list'
  | 'calendar_create'
  | 'email_list'
  | 'email_feedback'
  | 'tasks_list'
  | 'tasks_create'
  | 'tasks_delete'
  | 'tasks_complete'
  | 'tasks_postpone'
  | 'seo'
  | 'meu_dia'
  | 'stats'
  | 'preferences'
  | 'accounts_list'
  | 'chat';

export interface IntentResult {
  intent: Intent;
  params: Record<string, unknown>;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Cache (5-minute TTL, keyed by normalised message)
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: IntentResult;
  timestamp: number;
}

const intentCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000;

function normalizeForCache(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// OpenAI client (lazy init)
// ---------------------------------------------------------------------------

let openai: OpenAI;
function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ---------------------------------------------------------------------------
// classifyIntent
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Classifique a intenção da mensagem do usuário de um bot de WhatsApp pessoal.
Responda APENAS com JSON válido, sem markdown:
{"intent":"...","params":{},"confidence":0.0}

Intenções disponíveis:
- help: quer saber os comandos disponíveis
- datetime: pergunta sobre hora, data atual, dia da semana
- calendar_list: quer ver agenda/compromissos/eventos (hoje, amanhã, semana, etc.)
- calendar_create: quer criar/marcar/agendar reunião, evento, call, compromisso
- email_list: quer ver e-mails, inbox, mensagens novas
- email_feedback: dando feedback sobre e-mail (ex: "urgente 1", "importante 3", "não importante 2")
- tasks_list: quer ver tarefas, lembretes pendentes
- tasks_create: quer criar tarefa/lembrete com data ou hora
- tasks_delete: quer excluir/remover/apagar tarefa(s)
- tasks_complete: quer marcar tarefa como concluída/feita/pronta
- tasks_postpone: quer adiar/remarcar tarefa
- seo: quer novidades, notícias de SEO, marketing digital
- meu_dia: quer resumo do dia (agenda + tarefas + emails juntos)
- stats: quer estatísticas do bot, como tá indo, erros
- preferences: quer configurar preferências (silencioso, lembrete, etc.)
- accounts_list: quer ver contas Google vinculadas
- chat: conversa livre, pergunta genérica, qualquer outra coisa

Regras:
- confidence = 0.0 a 1.0 (quão seguro você está)
- Se não souber, use intent "chat" com confidence 0.5
- params pode ter campos como: index (número da tarefa/email), date (data mencionada)`;

export async function classifyIntent(message: string): Promise<IntentResult> {
  const key = normalizeForCache(message);

  const cached = intentCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Mensagem: "${message.slice(0, 500)}"` },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    let parsed: { intent?: string; params?: Record<string, unknown>; confidence?: number };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const validIntents: Intent[] = [
      'help', 'datetime', 'calendar_list', 'calendar_create',
      'email_list', 'email_feedback', 'tasks_list', 'tasks_create',
      'tasks_delete', 'tasks_complete', 'tasks_postpone',
      'seo', 'meu_dia', 'stats', 'preferences', 'accounts_list', 'chat',
    ];

    const intent = validIntents.includes(parsed.intent as Intent)
      ? (parsed.intent as Intent)
      : 'chat';

    const result: IntentResult = {
      intent,
      params: typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : {},
      confidence: typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5,
    };

    intentCache.set(key, { result, timestamp: Date.now() });
    return result;

  } catch (err) {
    console.warn('[intentClassifier] Classification failed:', (err as Error).message);
    return { intent: 'chat', params: {}, confidence: 0 };
  }
}
