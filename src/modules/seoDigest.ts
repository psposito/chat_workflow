import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface DigestItem {
  title: string;
  link: string;
  summary: string;
  source: string;
}

export async function buildSeoDigest(items: DigestItem[]): Promise<string> {
  if (items.length === 0) return '📭 Nenhum item para o digest.';

  const itemsText = items
    .map(
      (item, i) =>
        `${i + 1}. [${item.source}] ${item.title}\n   ${item.summary}\n   ${item.link}`,
    )
    .join('\n\n');

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `Você é um especialista em SEO e marketing digital. Crie um digest resumido em português brasileiro a partir dos itens fornecidos.

Formato de saída:
- Agrupe os itens por categoria/tema (ex: Core Updates, Link Building, IA & SEO, Ferramentas, etc.)
- Use bullets (•) para cada item dentro da categoria
- Inclua o link ao final de cada bullet entre parênteses
- Seja conciso e direto, destacando o que é mais relevante para profissionais de SEO
- Máximo de 20 linhas no total
- Use emojis para os títulos de categoria`,
      },
      {
        role: 'user',
        content: `Monte o digest SEO com os seguintes itens:\n\n${itemsText}`,
      },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}
