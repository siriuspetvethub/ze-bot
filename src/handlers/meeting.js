// Processador de reuniões — porta o ZE-MEETING com aprovação stateful
// Usa aba ZE_MEETING_PENDING no Sheets para persistir estado entre mensagens
// v2: aprovação SEMPRE roteada para Thiago + suporte a ajuste antes de aprovar
'use strict';

const sheets    = require('../clients/sheets');
const anthropic = require('../clients/anthropic');
const evolution = require('../clients/evolution');
const config    = require('../config');

const SHEET_PENDING = 'ZE_MEETING_PENDING';
const SHEET_KB      = 'ZE_KB';
const SHEET_TASKS   = 'BACKEND DASH '; // renomeada v25 (trailing space é real)
const MAX_CONTENT_CHARS = 50000;
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Busca aprovação pendente para um número de telefone
 * Verifica ZE_MEETING_PENDING e ignora registros expirados (>24h)
 * @param {string} senderNumber
 * @returns {Promise<object|null>}
 */
async function getPending(senderNumber) {
  try {
    const data = await sheets.get({ sheetName: SHEET_PENDING });
    const rows = data.tasks || data.rows || [];
    const now = Date.now();

    const pending = rows.find(r =>
      r.phone === senderNumber &&
      r.status === 'pending' &&
      (now - new Date(r.created_at).getTime()) < EXPIRY_MS
    );

    return pending || null;
  } catch (err) {
    console.warn('[meeting] Erro ao buscar pendentes:', err.message);
    return null;
  }
}

/**
 * Processa resposta de aprovação para reunião pendente
 * Aceita: "sim" (todas), "1,3,5" (específicas), "não" (cancelar), "ajustar N: texto" (editar)
 * @param {object} pending - Registro do ZE_MEETING_PENDING
 * @param {string} message - Resposta do usuário
 * @param {object} ctx - Contexto completo
 * @returns {Promise<{ actionResult, actionMessage }>}
 */
async function processApproval(pending, message, ctx) {
  const response = (message || '').toLowerCase().trim();
  let tarefas = [];

  try {
    tarefas = JSON.parse(pending.tarefas_json || '[]');
  } catch (_) {
    tarefas = [];
  }

  // Cancelar
  if (/^(nao|não|cancelar|n)$/i.test(response)) {
    await updatePendingStatus(pending._row, 'cancelled');
    return {
      actionResult: 'cancelled',
      actionMessage: 'Ok, cancelei. As tarefas da reunião não foram criadas.'
    };
  }

  // Ajustar tarefa específica: "ajustar 2: novo texto da tarefa"
  const adjustMatch = message.match(/^ajustar\s+(\d+)\s*[:–\-]\s*(.+)$/i);
  if (adjustMatch) {
    const idx = parseInt(adjustMatch[1], 10) - 1; // 0-based
    const novoTexto = adjustMatch[2].trim();
    if (idx < 0 || idx >= tarefas.length) {
      return {
        actionResult: 'meeting_adjust_error',
        actionMessage: `Não encontrei a tarefa ${idx + 1}. Temos ${tarefas.length} tarefa(s) na lista.`
      };
    }
    tarefas[idx].tarefa = novoTexto;
    // Persistir ajuste no Sheets
    await sheets.patch({
      sheetName: SHEET_PENDING,
      row: pending._row,
      updates: [
        { col: 'tarefas_json', value: JSON.stringify(tarefas) },
        { col: 'updated_at',   value: new Date().toISOString() }
      ]
    });
    // Reenviar lista atualizada para revisão
    const listaAtualizada = tarefas.map((t, i) => {
      const resp  = t.responsavel ? ` → ${t.responsavel}` : '';
      const prazo = t.prazo ? ` (${t.prazo})` : '';
      const emoji = t.prioridade === 'alta' ? '🔴' : t.prioridade === 'media' ? '🟡' : '🟢';
      return `${i + 1}. ${emoji} [${t.projeto}] ${t.tarefa}${resp}${prazo}`;
    }).join('\n');
    return {
      actionResult: 'meeting_adjusted',
      actionMessage: `✏️ Tarefa ${idx + 1} atualizada!\n\n${listaAtualizada}\n\n_Responda "sim", números específicos ou "não" para cancelar._`
    };
  }

  let tasksToCreate = [];

  if (/^(sim|todas|all|s)$/i.test(response)) {
    tasksToCreate = tarefas;
  } else {
    // Parsear números: "1,3,5" ou "1 3 5" ou "1-3"
    const indices = new Set();
    response.replace(/[^0-9,\-\s]/g, ' ').split(/[,\s]+/).forEach(part => {
      part = part.trim();
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        for (let i = a; i <= b; i++) indices.add(i);
      } else if (part) {
        indices.add(Number(part));
      }
    });
    tasksToCreate = tarefas.filter((_, i) => indices.has(i + 1));
  }

  if (tasksToCreate.length === 0) {
    return {
      actionResult: 'ambiguous',
      actionMessage: `Não entendi a seleção. Responde:\n• _sim_ para criar todas\n• números separados por vírgula (ex: _1,3,5_)\n• _ajustar N: novo texto_ para editar uma tarefa\n• _não_ para cancelar`
    };
  }

  // Criar tarefas aprovadas no dashboard
  const results = [];
  const errors = [];
  for (const t of tasksToCreate) {
    try {
      await sheets.post({
        sheetName: SHEET_TASKS,
        values: [t.projeto || 'SIRIUS', t.tarefa, t.responsavel || ctx.person, t.prazo || '', 'pendente', '', `Via reunião: ${pending.titulo}`]
      });
      results.push(t);
    } catch (e) {
      errors.push(`${t.tarefa}: ${e.message}`);
    }
  }

  await updatePendingStatus(pending._row, 'approved');

  let msg = `✅ *${results.length} tarefa(s) criada(s)* da reunião "${pending.titulo}":\n\n`;
  results.forEach((t, i) => { msg += `${i + 1}. ${t.tarefa}\n`; });
  if (errors.length > 0) {
    msg += `\n⚠️ ${errors.length} falha(s):\n${errors.join('\n')}`;
  }
  msg += `\n\n📊 ${config.DASHBOARD_URL}`;

  // Notificar cada responsável sobre suas novas tarefas
  const byPerson = {};
  for (const t of results) {
    const resp = t.responsavel;
    if (!resp) continue;
    if (!byPerson[resp]) byPerson[resp] = [];
    byPerson[resp].push(t);
  }

  for (const [personName, tasks] of Object.entries(byPerson)) {
    const phone = config.TEAM_PHONES[personName];
    if (!phone) continue;
    const lista = tasks.map(t => {
      const prazo = t.prazo ? ` (prazo: ${t.prazo})` : '';
      const emoji = t.prioridade === 'alta' ? '🔴' : t.prioridade === 'media' ? '🟡' : '🟢';
      return `${emoji} *[${t.projeto}]* ${t.tarefa}${prazo}`;
    }).join('\n');
    const notif = `📋 *Nova(s) tarefa(s) para você* — reunião "${pending.titulo}":\n\n${lista}\n\n📊 ${config.DASHBOARD_URL}`;
    evolution.sendText(phone, notif).catch(e =>
      console.warn(`[meeting] Falha ao notificar ${personName}:`, e.message)
    );
  }

  return { actionResult: 'approved', actionMessage: msg };
}

/**
 * Handler de nova reunião — extrai estrutura via Sonnet e encaminha para Thiago aprovar
 * @param {object} ctx - { intent, person, userMessage, senderNumber }
 * @returns {Promise<{ actionResult, actionMessage }>}
 */
async function handle(ctx) {
  const { userMessage, person, senderNumber } = ctx;

  // Truncar conteúdo longo antes de enviar ao Sonnet
  let content = userMessage || '';
  const wasTruncated = content.length > MAX_CONTENT_CHARS;
  if (wasTruncated) {
    content = content.slice(0, MAX_CONTENT_CHARS) + '\n[...TEXTO TRUNCADO]';
  }

  try {
    const extracted = await anthropic.extractMeeting(content);
    const tarefas = extracted.tarefas || [];
    const meetingId = `MTG-${Date.now()}`;

    // Formatar mensagem de aprovação com contexto de quem enviou
    const approvalMsg = formatApprovalMessage(extracted, meetingId, person);

    // Persistir estado — aprovação SEMPRE roteada para Thiago (config.ADMIN_PHONE)
    if (tarefas.length > 0) {
      await sheets.post({
        sheetName: SHEET_PENDING,
        values: [meetingId, config.ADMIN_PHONE, person, extracted.titulo, JSON.stringify(tarefas), 'pending', new Date().toISOString(), new Date().toISOString()]
      });
    }

    // Salvar na base de conhecimento
    const resumoStr   = (extracted.resumo   || []).join(' | ');
    const decisoesStr = (extracted.decisoes || []).join(' | ');
    sheets.post({
      sheetName: SHEET_KB,
      values: [meetingId, extracted.titulo, 'meeting', resumoStr, decisoesStr, person, new Date().toISOString()]
    }).catch(err => console.warn('[meeting] Erro ao salvar na KB:', err.message));

    // Se quem enviou NÃO é Thiago: encaminhar aprovação para ele e avisar o remetente
    if (senderNumber !== config.ADMIN_PHONE) {
      if (tarefas.length > 0) {
        evolution.sendText(config.ADMIN_PHONE, approvalMsg).catch(e =>
          console.warn('[meeting] Erro ao encaminhar para Thiago:', e.message)
        );
      }
      return {
        actionResult: 'meeting_forwarded',
        actionMessage: `✅ Reunião recebida${wasTruncated ? ' (texto longo — truncado)' : ''}!\n\n` +
          `Encaminhei ${tarefas.length > 0 ? `as *${tarefas.length} tarefa(s)*` : 'o resumo'} para o Thiago revisar antes de subir no dash.`
      };
    }

    // Thiago enviou diretamente: retornar aprovação para ele
    return { actionResult: 'meeting', actionMessage: approvalMsg };
  } catch (err) {
    console.error('[meeting] Erro:', err.message);
    return { actionResult: 'error', actionMessage: 'Erro ao processar reunião: ' + err.message };
  }
}

/**
 * Formata mensagem de aprovação de tarefas da reunião
 */
function formatApprovalMessage(extracted, meetingId, senderPerson) {
  const tarefas  = extracted.tarefas  || [];
  const decisoes = extracted.decisoes || [];
  const resumo   = extracted.resumo   || [];

  let msg = `📋 *Reunião: ${extracted.titulo}*\n`;
  if (extracted.data) msg += `_${extracted.data}_\n`;
  if (senderPerson) msg += `👤 Enviada por: ${senderPerson}\n`;
  msg += '\n';

  if (resumo.length > 0) {
    msg += '*Resumo:*\n';
    resumo.forEach(b => { msg += `• ${b}\n`; });
    msg += '\n';
  }

  if (decisoes.length > 0) {
    msg += '*Decisões:*\n';
    decisoes.forEach(d => { msg += `✓ ${d}\n`; });
    msg += '\n';
  }

  if (tarefas.length > 0) {
    msg += `*Tarefas identificadas (${tarefas.length}):*\n`;
    tarefas.forEach((t, i) => {
      const resp  = t.responsavel ? ` → ${t.responsavel}` : '';
      const prazo = t.prazo ? ` (${t.prazo})` : '';
      const emoji = t.prioridade === 'alta' ? '🔴' : t.prioridade === 'media' ? '🟡' : '🟢';
      msg += `${i + 1}. ${emoji} [${t.projeto}] ${t.tarefa}${resp}${prazo}\n`;
    });
    msg += '\n_Avalie antes de subir no dash:_\n';
    msg += '_• "sim" — criar todas_\n';
    msg += '_• "1,3" — criar só essas_\n';
    msg += '_• "ajustar 2: novo texto" — editar uma tarefa_\n';
    msg += '_• "não" — cancelar_';
  } else {
    msg += '_Nenhuma tarefa identificada nesta reunião._';
  }

  return msg;
}

/**
 * Atualiza status de um registro ZE_MEETING_PENDING
 */
async function updatePendingStatus(row, status) {
  if (!row) return;
  await sheets.patch({
    sheetName: SHEET_PENDING,
    row,
    updates: [
      { col: 'status',     value: status },
      { col: 'updated_at', value: new Date().toISOString() }
    ]
  });
}

module.exports = { handle, getPending, processApproval };
