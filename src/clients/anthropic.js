// Cliente Anthropic — Haiku para classificação de intenção, Sonnet para respostas
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// System prompt do Haiku para classificar intenção
const HAIKU_SYSTEM = `Voce e o Ze, assistente interno da Sirius Digital.
Analise a mensagem e retorne SOMENTE um JSON valido (sem markdown) com:

{
  "intent": "update_task_status" | "add_note" | "create_task" | "transfer_task" | "reschedule_task" | "block_task" | "delete_task" | "query_tasks" | "weekly_summary" | "team_view" | "ask_context" | "contexto_projeto" | "update_contexto" | "meeting" | "greeting" | "daily_goal" | "unclear",
  "project": "ANMV" | "COMPORT" | "FOCO" | "KING" | "MAP" | "MELANIE" | "NAVES" | "LT-PNEUS" | "SIRIUS" | "VH" | null,
  "task": "descricao resumida" | null,
  "status": "pendente" | "andamento" | "emaprovacao" | "feito" | "travado" | null,
  "person": "Alvaro" | "Chardson" | "Joao" | "Luan" | "Rick" | "Maria" | "Paula" | "Thiago" | null,
  "targetPerson": "nome" | null,
  "newDeadline": "dd/mm" | null,
  "notes": "nota" | null,
  "contextField": "contexto" | "proximas_acoes" | "decisoes" | "blockers" | "alertas" | "entregaveis" | "foraDoEscopo" | "contatos" | "ofertaPrincipal" | null,
  "contextValue": "conteudo a gravar no campo" | null,
  "contextMode": "append" | "replace" | null,
  "confidence": 0.0,
  "suggestions": ["sugestao1", "sugestao2"]
}

Regras:
- confidence < 0.7 → intent = "unclear"
- "cria/criar/crie/adiciona/adicione/cadastra/cadastre/coloca uma tarefa/nova tarefa/poe uma tarefa/inclui uma tarefa" → create_task (extrair task, project, person, deadline da mensagem)
- "terminei/concluí/finalizei" → update_task_status, status=feito
- "travado/bloqueado/emperrado" → block_task, status=travado
- "comecei/estou fazendo" → update_task_status, status=andamento
- "passa pro/transfere" → transfer_task
- "adia/adiou/muda prazo" → reschedule_task
- "oi/bom dia/e ai" → greeting (SOMENTE se nao houver historico recente; se a ultima mensagem do assistente foi pergunta de confirmacao "sim/nao/bora", classifique como continuacao da intencao anterior, NUNCA como greeting)
- "como esta o [projeto]/contexto de [projeto]/situacao de [projeto]/update de [projeto]/o que ta rolando em [projeto]" (LEITURA, sem ":") → contexto_projeto (com project preenchido)
- "atualiza contexto de [proj]: X/contexto novo do [proj]: X/[proj] mudou X" → update_contexto, contextField="contexto", contextValue="X", contextMode=null. REGRA RIGIDA: se a mensagem contem a palavra "contexto" antes de ":", contextField é SEMPRE "contexto" — NUNCA classifique o conteudo depois do ":" como blocker/alerta/decisao
- "blocker no/em/de [proj]: X/[proj] travou em X/bloqueio no [proj]: X" → update_contexto, contextField="blockers", contextValue="X", contextMode=null
- "proxima acao [proj]: X/proxima ação no [proj]: X/[proj] a fazer: X/[proj] precisa X" → update_contexto, contextField="proximas_acoes", contextValue="X"
- "decisao [proj]: X/decidimos no [proj]: X/[proj] decidido: X" → update_contexto, contextField="decisoes", contextValue="X"
- "alerta [proj]: X/aviso no [proj]: X" → update_contexto, contextField="alertas", contextValue="X"
- "entregaveis [proj]: X/escopo [proj]: X" → update_contexto, contextField="entregaveis", contextValue="X"
- "fora de escopo [proj]: X/foraDoEscopo [proj]: X" → update_contexto, contextField="foraDoEscopo", contextValue="X"
- "oferta [proj]: X/oferta principal [proj]: X" → update_contexto, contextField="ofertaPrincipal", contextValue="X"
- "substitui/substituir/sobrescreve/troca [campo] do [proj] por: X" → update_contexto, contextMode="replace"
- "adiciona/anexa no [campo] do [proj]: X" → update_contexto, contextMode="append"
- Para update_contexto: contextValue deve conter SOMENTE o conteúdo após os dois pontos (":"), sem o prefixo do campo
- Sinal forte de update_contexto: presença de ":" após menção ao projeto/campo (ex "blocker no FOCO: X")
- "como esta/o que decidimos/reuniao" → ask_context ou meeting
- "minha semana/semana/o que tenho essa semana" → weekly_summary
- "como esta o time/ver time/status do time/visao do time" → team_view
- "#meta/vou fechar/meu objetivo hoje/pretendo fazer" → daily_goal
- Resposta curta como "sim/nao/bora/pode/manda/confirma/ok" no meio de uma conversa: NUNCA classifique como greeting. Use o historico para inferir a intencao real da pergunta que estava aberta.
- Retorne SOMENTE o JSON`;

/**
 * Classifica a intenção da mensagem usando Haiku
 * Recebe histórico opcional para resolver referências anafóricas ("essa tarefa", "ela", etc.)
 * @param {string} userMessage - Mensagem do usuário
 * @param {Array<{role,content}>} [history] - Últimas mensagens da conversa
 * @returns {Promise<object>} Objeto com intent, project, task, status, person, etc.
 */
async function classifyIntent(userMessage, history = []) {
  // Usar últimas 4 mensagens do histórico (2 trocas) para contexto de classificação
  const contextMessages = history.slice(-4);
  const messages = [...contextMessages, { role: 'user', content: userMessage }];
  // API Claude exige que comece com 'user'
  const safeMessages = messages[0]?.role === 'user' ? messages : messages.slice(messages.findIndex(m => m.role === 'user'));

  const response = await client.messages.create({
    model: config.HAIKU_MODEL,
    max_tokens: 512,
    system: HAIKU_SYSTEM,
    messages: safeMessages
  });

  const rawText = response.content?.[0]?.text || '';
  let parsed;
  try {
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    parsed = { intent: 'unclear', confidence: 0, parseError: e.message };
  }

  // Forçar unclear quando confiança baixa
  if (typeof parsed.confidence === 'number' && parsed.confidence < 0.7 && parsed.intent !== 'greeting') {
    parsed.intent = 'unclear';
  }

  return parsed;
}

/**
 * Gera resposta final em linguagem natural usando Sonnet
 * @param {object} ctx - Contexto completo: person, userMessage, intent, actionResult, actionMessage, knowledgeContext?
 * @param {Array<{role,content}>} [history] - Histórico da conversa para contexto
 * @returns {Promise<string>} Texto da resposta para enviar ao usuário
 */
async function generateResponse(ctx, history = []) {
  const { person, userMessage, intent, actionResult, actionMessage, knowledgeContext } = ctx;

  // Data atual em BRT para o Sonnet não precisar inferir
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // Se actionMessage trouxe um link especifico (ex: ?task=TSK-1234), preserva ele.
  // Caso contrario, cai pro link geral do dashboard.
  const linkMatch = actionMessage && actionMessage.match(/https?:\/\/[^\s)]+/);
  const linkInstruction = linkMatch
    ? `URL desta interacao (USE EXATAMENTE este link no formato 🔗 ${linkMatch[0]} — NUNCA encurte, troque pelo dashboard generico ou invente outro): ${linkMatch[0]}`
    : `URL do dashboard (use apenas se nao houver link especifico — NUNCA inventar outra): ${config.DASHBOARD_URL}`;

  const userContent = [
    `Data de hoje: ${hoje}`,
    `Pessoa: ${person}`,
    `Mensagem original: ${userMessage}`,
    `Intent: ${intent?.intent || 'unclear'}`,
    `Resultado da acao: ${actionResult || 'nenhum'}`,
    `Mensagem da acao (use como base da resposta — nao reescreva nem substitua links): ${actionMessage || 'nenhum'}`,
    linkInstruction,
    knowledgeContext ? `Contexto de conhecimento:\n${knowledgeContext}` : null
  ].filter(Boolean).join('\n');

  // Últimas 10 mensagens do histórico (5 trocas) para contexto de resposta
  const contextMessages = history.slice(-10);
  const messages = [...contextMessages, { role: 'user', content: userContent }];
  const safeMessages = messages[0]?.role === 'user' ? messages : messages.slice(messages.findIndex(m => m.role === 'user'));

  const response = await client.messages.create({
    model: config.SONNET_MODEL,
    max_tokens: 1024,
    system: config.PERSONALITY_PROMPT,
    messages: safeMessages
  });

  return response.content?.[0]?.text || 'Opa, tive um probleminha aqui. Tenta de novo?';
}

/**
 * Extrai estrutura de reunião a partir de transcrição/resumo usando Sonnet
 * @param {string} meetingContent - Texto da transcrição ou resumo
 * @returns {Promise<object>} Objeto com titulo, resumo, decisoes, tarefas, pendencias
 */
async function extractMeeting(meetingContent) {
  const system = 'Voce e um assistente especializado em extrair informacoes estruturadas de transcricoes e resumos de reunioes. Responda SOMENTE em JSON valido, sem markdown, sem texto adicional.';

  const userPrompt = `Analise a seguinte transcricao/resumo de reuniao e extraia as informacoes estruturadas.

Retorne um JSON com esta estrutura exata:
{
  "titulo": "titulo curto da reuniao (max 60 chars)",
  "data": "data da reuniao se mencionada, senao null",
  "participantes": ["lista de nomes"],
  "resumo": ["bullet 1", "bullet 2", "bullet 3"],
  "decisoes": ["decisao 1", "decisao 2"],
  "tarefas": [
    {
      "projeto": "nome do projeto (ANMV/COMPORT/FOCO/KING/MAP/MELANIE/SIRIUS/VH ou GERAL)",
      "tarefa": "descricao clara da tarefa (max 100 chars)",
      "responsavel": "nome da pessoa (Thiago/Alvaro/Luan/Rick/Maria/Chardson/Paula ou null)",
      "prazo": "data no formato DD/MM/YYYY ou null",
      "prioridade": "alta/media/baixa"
    }
  ],
  "pendencias": ["item pendente para proxima reuniao"]
}

Projetos validos: ANMV, COMPORT, FOCO, KING, MAP, MELANIE, SIRIUS, VH
Responsaveis validos: Thiago, Alvaro, Luan, Rick, Maria, Chardson, Paula

TRANSCRICAO:
${meetingContent}`;

  const response = await client.messages.create({
    model: config.SONNET_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const rawText = response.content?.[0]?.text || '';
  const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { classifyIntent, generateResponse, extractMeeting };
