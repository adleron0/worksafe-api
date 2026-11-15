/**
 * Teste comparativo dos modelos (fase 3 do plano de Bots).
 *
 * Para cada caso, manda ao modelo a mensagem da pessoa com as instruções e as
 * ferramentas do bot (como no sistema) e confere a PRIMEIRA decisão: chamou a
 * ferramenta certa, com os campos certos, ou fez a pergunta certa quando faltava
 * informação. Não toca no banco: mede só o julgamento do modelo, o tempo e o
 * custo. É a etapa que decide o modelo de cada bot.
 *
 * Uso (precisa das chaves no .env):
 *   npm run ai:eval -- gemini:gemini-3-flash-preview gemini:gemini-3.1-pro-preview anthropic:claude-haiku-5-5 anthropic:claude-sonnet-5-5
 * Saída: tabela no terminal e o relatório em scripts/ai-eval-resultado.md
 * Custa dinheiro de verdade (pouco: ~30 chamadas por modelo).
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { BASE_RULES, BOT_DEFAULTS } from '../src/features/ai/bots/bot.defaults';
import { ProviderRegistry } from '../src/features/ai/providers/provider.registry';
import { READ_TOOLS } from '../src/features/ai/tools/read.tools';
import { WRITE_TOOLS } from '../src/features/ai/tools/write.tools';

interface Case {
  id: string;
  bot: string;
  mensagem: string;
  /** ferramentas aceitas como primeira chamada; [] = deve perguntar, sem chamar nada */
  esperado: string[];
  /** campos que precisam vir na chamada, com o valor (ou "*" para qualquer valor) */
  campos?: Record<string, unknown>;
  /** palavras que a pergunta deve conter quando esperado = [] */
  pergunta?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cases: Case[] = require('./ai-eval-casos.json');

const tools = new Map([...READ_TOOLS, ...WRITE_TOOLS].map((tool) => [tool.name, tool]));

function judge(item: Case, calls: { name: string; input: Record<string, unknown> }[], text: string): { ok: boolean; why: string } {
  if (!item.esperado.length) {
    if (calls.length) return { ok: false, why: `chamou ${calls[0].name} em vez de perguntar` };
    const lower = text.toLowerCase();
    const miss = (item.pergunta ?? []).filter((word) => !lower.includes(word.toLowerCase()));
    return miss.length ? { ok: false, why: `pergunta sem: ${miss.join(', ')}` } : { ok: true, why: 'perguntou' };
  }
  if (!calls.length) return { ok: false, why: 'não chamou ferramenta' };
  const first = calls[0];
  if (!item.esperado.includes(first.name)) return { ok: false, why: `chamou ${first.name}` };
  for (const [field, value] of Object.entries(item.campos ?? {})) {
    const got = first.input[field];
    if (got === undefined || got === null || got === '') return { ok: false, why: `faltou ${field}` };
    if (value !== '*' && String(got).toLowerCase() !== String(value).toLowerCase()) return { ok: false, why: `${field}=${JSON.stringify(got)}` };
  }
  return { ok: true, why: first.name };
}

async function main() {
  const targets = process.argv.slice(2).filter((arg) => arg.includes(':') && !arg.startsWith('--'));
  // --intervalo=13 espera 13 s entre chamadas (plano gratuito do Gemini: 5 por minuto)
  const pause = Number(process.argv.find((arg) => arg.startsWith('--intervalo='))?.split('=')[1] ?? 0) * 1000;
  if (!targets.length) {
    console.log('Informe os modelos: npm run ai:eval -- gemini:gemini-3-flash-preview anthropic:claude-haiku-5-5');
    process.exit(1);
  }
  const registry = new ProviderRegistry();
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const lines: string[] = [`# Teste comparativo dos bots — ${today}`, '', `${cases.length} casos por modelo.`, ''];
  const summary: string[] = ['| Modelo | Acertos | Custo total (US$) | Tempo médio |', '|---|---|---|---|'];
  const details: string[] = [];

  for (const target of targets) {
    const [providerId, model] = target.split(':');
    const provider = registry.get(providerId);
    if (!provider?.available()) {
      console.log(`${target}: sem chave, pulando`);
      summary.push(`| ${target} | sem chave | — | — |`);
      continue;
    }
    let hits = 0;
    let cost = 0;
    let time = 0;
    details.push(`\n## ${target}\n`, '| Caso | Resultado | Detalhe | ms |', '|---|---|---|---|');
    for (const item of cases as Case[]) {
      const bot = BOT_DEFAULTS.find((entry) => entry.key === item.bot)!;
      const defs = bot.tools.map((name) => tools.get(name)!).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
      const system = `${BASE_RULES}\n\n## Seu papel\n${bot.instructions}\n\n## Contexto\n- Empresa: WorkSafe\n- Pessoa: Teste\n- Hoje: ${today}`;
      if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
      const started = Date.now();
      try {
        const response = await provider.chat({ model, system, messages: [{ role: 'user', text: item.mensagem }], tools: defs });
        const ms = Date.now() - started;
        time += ms;
        cost += registry.cost(providerId, model, response.usage);
        const verdict = judge(item, response.toolCalls, response.text);
        if (verdict.ok) hits++;
        details.push(`| ${item.id} | ${verdict.ok ? 'ok' : 'erro'} | ${verdict.why.replace(/\|/g, '/')} | ${ms} |`);
        process.stdout.write(verdict.ok ? '.' : 'x');
      } catch (error) {
        details.push(`| ${item.id} | falha | ${String((error as Error).message).slice(0, 80).replace(/\|/g, '/')} | — |`);
        process.stdout.write('!');
      }
    }
    const total = cases.length;
    console.log(`\n${target}: ${hits}/${total} · US$ ${cost.toFixed(4)} · ${Math.round(time / total)} ms`);
    summary.push(`| ${target} | ${hits}/${total} (${Math.round((hits / total) * 100)}%) | ${cost.toFixed(4)} | ${Math.round(time / total)} ms |`);
  }
  const out = join(__dirname, 'ai-eval-resultado.md');
  writeFileSync(out, [...lines, ...summary, ...details, ''].join('\n'));
  console.log(`\nRelatório: ${out}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
