// Roteador central de mensagens — coração do Zé Bot
// Porta o workflow ZE-ROUTER completo: normalização, resolução, classificação, dispatch
'use strict';

const memberResolver       = require('./handlers/member-resolver');
const intentClassifier     = require('./handlers/intent-classifier');
const sonnetResponder      = require('./handlers/sonnet-responder');
const taskManager          = require('./handlers/task-manager');
const taskConfirm          = require('./handlers/task-confirm');
const conversationHistory  = require('./handlers/conversation-history');
const query                = require('./handlers/query');
const knowledge            = require('./handlers/knowledge');
const meeting              = require('./handlers/meeting');
const audio                = require('./handlers/audio');
const evolution            = require('./clients/evolution');
const sheets               = require('./clients/sheets');
const config               = require('./config');

const SHEET_LOG = 'ZE_LOG';

// Mapeamento slug → projeto para cruzar contexto vivo
const SLUG_TO_PROJECT = {
  mel: 'MELANIE', comport: 'COMPORT', 'foco-vet': 'FOCO', focovet: 'FOCO',
  map: 'MAP', vh: 'VH', king: 'KING', anmv: 'ANMV', sirius: 'SIRIUS',
  naves: 'NAVES', 'lt-pneus': 'LT-PNEUS',
};
const PROJECT_TO_SLUG = Object.fromEntries(
  Object.entries(SLUG_TO_PROJECT).map(([k, v]) => [v, k])
);

/**
 * Handler para contexto_projeto — retorna snapshot do contexto vivo do projeto solicitado
 */
async function handleContextoProjeto(ctx) {
  const { intent, person, userMessage } = ctx;
  const project = (intent.project || '').toUpperCase();

  const contextoMap = await sheets.getContextoVivo();
  const slug = PROJECT_TO_SLUG[project];

  // Tentar pelo slug ou por varredura dos dados
  let dados = slug ? contextoMap[slug] : null;
  if (!dados) {
    // Fallback: procurar pelo projeto dentro dos dados
    const entry = Object.entries(contextoMap).find(([, v]) =>
      (v.cliente || '').toUpperCase().includes(project) ||
      (SLUG_TO_PROJECT[Object.keys(contextoMap).find(k => k === Object.keys(contextoMap)[0])] || '').toUpperCase() === project
    );
    if (entry) dados = entry[1];
  }

  if (!dados) {
    const projetos = Object.keys(contextoMap).map(s => SLUG_TO_PROJECT[s] || s).join(', ');
    return {
      actionResult: 'not_found',
      actionMessage: `Não encontrei contexto para *${project || 'esse projeto'}*.\n\nProjetos disponíveis: ${projetos}`
    };
  }

  const statusEmoji = { ativo: '🟢', atencao: '🟡', critico: '🔴', pausado: '⚫' };
  const emoji = statusEmoji[dados.status] || '⚪';
  const resp = dados.responsaveis || {};
  const responsaveis = [
    resp.dono      ? `👤 Dono: ${resp.dono}` : null,
    resp.comercial ? `💼 Comercial: ${resp.comercial}` : null,
    resp.trafego   ? `📢 Tráfego: ${resp.trafego}` : null,
  ].filter(Boolean).join('\n');

  const proximas = (dados.proximas_acoes || []).slice(0, 3).map((a, i) => `${i + 1}. ${a}`).join('\n');
  const blockers = (dados.blockers || []).slice(0, 2).map(b => `⚠️ ${b}`).join('\n');
  const alertas  = (dados.alertas || []).slice(0, 2).map(a => `🚨 ${a}`).join('\n');

  let msg = `${emoji} *[${project}]* — Contexto Vivo\n\n`;
  if (dados.contexto)      msg += `📌 ${dados.contexto}\n\n`;
  if (proximas)            msg += `*Próximas ações:*\n${proximas}\n\n`;
  if (blockers)            msg += `*Blockers:*\n${blockers}\n\n`;
  if (alertas)             msg += `*Alertas:*\n${alertas}\n\n`;
  if (responsaveis)        msg += `${responsaveis}\n\n`;
  if (dados.atualizado_em) msg += `_Atualizado: ${dados.atualizado_em}_`;

  return { actionResult: 'contexto_found', actionMessage: msg.trim() };
}

// Mapeamento de intents para handlers (null = vai direto ao Sonnet)
const INTENT_HANDLERS = {
  update_task_status: taskManager.handle,
  add_note:           taskManager.handle,
  create_task:        taskManager.handle,
  transfer_task:      taskManager.handle,
  reschedule_task:    taskManager.handle,
  block_task:         taskManager.handle,
  delete_task:        taskManager.handle,
  query_tasks:        query.handle,
  weekly_summary:     query.handle,
  team_view:          query.handle,
  daily_goal:         null, // apenas loga + Sonnet confirma
  ask_context:        knowledge.handle,
  contexto_projeto:   handleContextoProjeto,
  meeting:            meeting.handle,
  greeting:           null,
  unclear:            null
};

/**
 * Ponto de entrada principal — processa um evento de webhook da Evolution API
 * @param {object} body - Payload bruto do webhook
 */
async function process(body) {
  const startTime = Date.now();

  // --- 1. Normalizar e extrair dados do payload ---
  const data    = body.data || body;
  const key     = data.key || {};
  const message = data.message || {};
  const rawJid  = key.remoteJid || '';
  const isGroup = rawJid.endsWith('@g.us');

  // Número normalizado do remetente (resolve bug @lid)
  const senderNumber = memberResolver.normalizeJid(body);

  // Filtrar mensagens do próprio bot
  if (senderNumber === config.BOT_NUMBER || key.fromMe === true) {
    return; // Silencioso — não logar para não inflar métricas
  }

  // Em grupos: só responder se Zé for mencionado
  if (isGroup) {
    const text = message.conversation || message.extendedTextMessage?.text || '';
    const mentionsZe = /\bz[eé]\b/i.test(text) ||
      (message.extendedTextMessage?.contextInfo?.mentionedJid || []).some(j => j.includes(config.BOT_NUMBER));
    if (!mentionsZe) return;
  }

  // Ignorar eventos que não são mensagens de texto ou áudio
  const isAudio = !!(message.audioMessage || message.pttMessage);
  const isText  = !!(message.conversation || message.extendedTextMessage?.text);
  if (!isAudio && !isText) return;

  // --- 2. Resolver membro da equipe ---
  const { person, personFound } = memberResolver.resolveMember(senderNumber);

  if (!personFound) {
    // Avisar que número não está cadastrado
    const targetNumber = isGroup ? rawJid.split('@')[0] : senderNumber;
    await evolution.sendText(targetNumber, 'Oi! Não encontrei seu cadastro na equipe Sirius. Fala com o Thiago para te adicionar.');
    return;
  }

  // Número para envio de resposta
  const replyTo = isGroup ? rawJid.split('@')[0] : senderNumber;

  // --- 3. Verificar aprovação de reunião pendente (antes de classificar intent) ---
  const pendingMeeting = await meeting.getPending(senderNumber).catch(() => null);
  if (pendingMeeting) {
    const userMessage = message.conversation || message.extendedTextMessage?.text || '';
    try {
      const result = await meeting.processApproval(pendingMeeting, userMessage, { person, senderNumber });
      await evolution.sendText(replyTo, result.actionMessage);
      logInteraction({ sender: senderNumber, person, intent: 'meeting_approval', actionResult: result.actionResult, duration: Date.now() - startTime });
    } catch (err) {
      console.error('[router] Erro no processApproval:', err.message);
    }
    return;
  }

  // --- 3b. Verificar confirmação de tarefa pendente (antes de classificar intent) ---
  const pendingConfirm = await taskConfirm.getPending(senderNumber).catch(() => null);
  if (pendingConfirm) {
    const confirmText = (message.conversation || message.extendedTextMessage?.text || '').trim();

    // Seleção de menu de desambiguação — usuário responde com número 1/2/3
    if (pendingConfirm.intended_action === 'ambiguous_select') {
      const numMatch = confirmText.match(/^([1-5])$/);
      await taskConfirm.clearPending(pendingConfirm._row).catch(() => {});
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        let parsed = {};
        try { parsed = JSON.parse(pendingConfirm.intent_json || '{}'); } catch (_) {}
        const topMatches = parsed.topMatches || [];
        const chosen = topMatches[idx];
        if (chosen) {
          await taskConfirm.savePending(senderNumber, chosen, parsed.intent?.intent || 'update_task_status', parsed.intent || {});
          await evolution.sendText(replyTo, taskConfirm.buildConfirmMessage(chosen));
          logInteraction({ sender: senderNumber, person, intent: 'ambiguous_select', actionResult: 'selected', duration: Date.now() - startTime });
        } else {
          await evolution.sendText(replyTo, `Opção ${numMatch[1]} não existe. Pode repetir o pedido com mais detalhes?`);
          logInteraction({ sender: senderNumber, person, intent: 'ambiguous_select', actionResult: 'invalid', duration: Date.now() - startTime });
        }
      } else {
        await evolution.sendText(replyTo, 'Responde com o número da opção (1, 2 ou 3) ou me conta qual tarefa quer com mais detalhes.');
        logInteraction({ sender: senderNumber, person, intent: 'ambiguous_select', actionResult: 'non_numeric', duration: Date.now() - startTime });
      }
      return;
    }

    const isSim = /^(sim|s|isso|essa|confirma|yes|ok|pode)\b/i.test(confirmText);
    const isNao = /^(não|nao|errada|errado|outra|outro|n)\b/i.test(confirmText);

    if (isSim) {
      try {
        const { match, intent, action } = await taskConfirm.resolvePending(pendingConfirm);
        if (!match) {
          const msgNotFound = 'Não encontrei mais a tarefa na planilha. Pode repetir o pedido?';
          await evolution.sendText(replyTo, msgNotFound);
          conversationHistory.append(senderNumber, 'user', confirmText);
          conversationHistory.append(senderNumber, 'assistant', msgNotFound);
        } else {
          const result = await taskManager.executeAction(action, match, intent, person);
          await evolution.sendText(replyTo, result.actionMessage);
          conversationHistory.append(senderNumber, 'user', confirmText);
          conversationHistory.append(senderNumber, 'assistant', result.actionMessage);
          logInteraction({ sender: senderNumber, person, intent: 'task_confirm', actionResult: result.actionResult, duration: Date.now() - startTime });
        }
      } catch (err) {
        console.error('[router] Erro ao executar confirmação:', err.message);
        await evolution.sendText(replyTo, 'Erro ao executar a ação. Pode repetir?');
      }
      return;
    }

    if (isNao) {
      await taskConfirm.clearPending(pendingConfirm._row).catch(() => {});
      const msgCancelado = 'Ok, cancelei! Pode descrever melhor qual tarefa quer atualizar?';
      await evolution.sendText(replyTo, msgCancelado);
      conversationHistory.append(senderNumber, 'user', confirmText);
      conversationHistory.append(senderNumber, 'assistant', msgCancelado);
      logInteraction({ sender: senderNumber, person, intent: 'task_confirm_cancel', actionResult: 'cancelled', duration: Date.now() - startTime });
      return;
    }

    // Mensagem não é sim/não: limpar pending e processar como nova mensagem
    await taskConfirm.clearPending(pendingConfirm._row).catch(() => {});
  }

  // --- 4. Transcrever áudio se necessário ---
  let userMessage;
  if (isAudio) {
    const audioUrl = message.audioMessage?.url || message.pttMessage?.url || null;
    const messageId = key.id;
    userMessage = await audio.transcribe(audioUrl, messageId);
    if (!userMessage) {
      await evolution.sendText(replyTo, 'Opa, não consegui transcrever o áudio. Pode escrever?');
      return;
    }
  } else {
    userMessage = message.conversation || message.extendedTextMessage?.text || '';
  }

  if (!userMessage || userMessage.trim() === '') return;

  // --- 5a. Intercept "aprendi:" — registra aprendizado na ZE_KB sem passar pelo Haiku ---
  if (/^\s*aprendi\s*[:–\-]/i.test(userMessage)) {
    const learning = userMessage.replace(/^\s*aprendi\s*[:–\-]\s*/i, '').trim();
    if (learning) {
      sheets.post({
        sheetName: 'ZE_KB',
        values: ['GERAL', 'aprendizado', learning, `WhatsApp/${person}`, new Date().toISOString()]
      }).catch(e => console.warn('[router] Erro ao salvar aprendizado:', e.message));
      const replyAprendi = `📚 Registrado na base de conhecimento, ${person}!\n\n_"${learning.slice(0, 80)}${learning.length > 80 ? '...' : ''}"_`;
      await evolution.sendText(replyTo, replyAprendi);
      conversationHistory.append(senderNumber, 'user', userMessage);
      conversationHistory.append(senderNumber, 'assistant', replyAprendi);
      logInteraction({ sender: senderNumber, person, intent: 'aprendi', actionResult: 'saved_kb', duration: Date.now() - startTime });
    }
    return;
  }

  // --- 5b. Intercept "#meta" — registra objetivo do dia no ZE_LOG ---
  if (/#meta\b/i.test(userMessage)) {
    const goal = userMessage.replace(/#meta\s*/i, '').trim();
    sheets.post({
      sheetName: 'ZE_LOG',
      values: [new Date().toISOString(), senderNumber, 'daily_goal', 'log', '', '0', person, goal.slice(0, 200), '']
    }).catch(e => console.warn('[router] Erro ao logar meta:', e.message));
    const replyMeta = `✅ Meta registrada, ${person}! Bora fechar isso 💪`;
    await evolution.sendText(replyTo, replyMeta);
    conversationHistory.append(senderNumber, 'user', userMessage);
    conversationHistory.append(senderNumber, 'assistant', replyMeta);
    logInteraction({ sender: senderNumber, person, intent: 'daily_goal', actionResult: 'logged', duration: Date.now() - startTime });
    return;
  }

  // --- 5. Classificar intenção com Haiku (com histórico para resolver referências) ---
  const history = conversationHistory.get(senderNumber);
  const intent = await intentClassifier.classify(userMessage, history);

  // --- 6. Rotear para handler ---
  const intentKey = intent.intent || 'unclear';
  const handler   = INTENT_HANDLERS[intentKey];

  const ctx = { intent, person, senderNumber, userMessage };
  let actionResult  = null;
  let actionMessage = null;
  let knowledgeContext = null;

  // Greeting: injetar actionMessage para evitar que Sonnet alucine sugestões indevidas
  if (intentKey === 'greeting') {
    actionResult  = 'greeting';
    actionMessage = `Oi ${person}! Sou o Zé, assistente operacional da Sirius Digital.\n\nPosso te ajudar com:\n• 📋 Ver suas tarefas pendentes\n• ➕ Criar nova tarefa\n• ✅ Atualizar status de tarefa\n• 📊 Ver tarefas em atraso por projeto\n• 🔎 Filtrar por projeto (MELANIE, COMPORT, FOCO...)\n\nO que você precisa?`;
  }

  if (handler) {
    try {
      const result = await handler(ctx);
      actionResult     = result.actionResult;
      actionMessage    = result.actionMessage;
      knowledgeContext = result.knowledgeContext || null;
    } catch (err) {
      console.error(`[router] Erro no handler ${intentKey}:`, err.message);
      actionResult  = 'error';
      actionMessage = `Erro ao processar: ${err.message}`;
    }
  }

  // Intents com resposta estruturada: enviar direto sem passar pelo Sonnet
  if (intentKey === 'contexto_projeto' && actionMessage) {
    await evolution.sendText(replyTo, actionMessage);
    conversationHistory.append(senderNumber, 'user', userMessage);
    conversationHistory.append(senderNumber, 'assistant', actionMessage);
    const duration = Date.now() - startTime;
    logInteraction({ sender: senderNumber, person, intent: intentKey, actionResult, duration });
    return;
  }

  // --- 7. Gerar resposta final com Sonnet (com histórico) ---
  const finalResponse = await sonnetResponder.respond({
    person,
    userMessage,
    intent,
    actionResult,
    actionMessage,
    knowledgeContext
  }, history);

  // --- 8. Enviar via Evolution ---
  await evolution.sendText(replyTo, finalResponse);

  // --- 9. Salvar no histórico + logar na ZE_LOG ---
  conversationHistory.append(senderNumber, 'user', userMessage);
  conversationHistory.append(senderNumber, 'assistant', finalResponse);
  const duration = Date.now() - startTime;
  logInteraction({ sender: senderNumber, person, intent: intentKey, actionResult, duration });
}

/**
 * Loga interação na aba ZE_LOG do Sheets (não bloqueia o fluxo principal)
 * Schema: timestamp|sender|intent|action|result|duration_ms|extra1(person)|extra2|extra3
 */
function logInteraction({ sender, person, intent, actionResult, duration }) {
  const values = [
    new Date().toISOString(), // timestamp
    sender || '',             // sender
    intent || '',             // intent  (era: person — schema corrigido)
    actionResult || '',       // action  (era: intent)
    '',                       // result
    String(duration || 0),    // duration_ms
    person || '',             // extra1 = person
    '',                       // extra2
    ''                        // extra3
  ];
  sheets.post({ sheetName: SHEET_LOG, values }).catch(err =>
    console.warn('[router] Erro ao logar:', err.message)
  );
}

module.exports = { process };
