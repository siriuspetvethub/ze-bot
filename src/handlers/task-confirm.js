// Confirmação stateful de tarefa antes de executar mutação
// Persiste "qual tarefa" + "qual ação" no Sheets por 5 minutos
// Resolve o problema de contexto perdido quando membro diz "sim" numa nova mensagem
'use strict';

const sheets = require('../clients/sheets');

const SHEET_CONFIRM = 'ZE_PENDING_CONFIRM';
const SHEET_TASKS   = 'BACKEND DASH ';
const TTL_MS = 5 * 60 * 1000; // 5 minutos — confirmações curtas

/**
 * Busca confirmação pendente para um número de telefone
 * Filtra registros expirados (>5min) e já processados
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
async function getPending(phone) {
  try {
    const data = await sheets.get({ sheetName: SHEET_CONFIRM });
    const rows = data.tasks || data.rows || [];
    const now = Date.now();
    const pending = rows.find(r =>
      r.phone === phone &&
      r.status === 'pending' &&
      (now - new Date(r.created_at).getTime()) < TTL_MS
    );
    return pending || null;
  } catch (err) {
    console.warn('[task-confirm] Erro ao buscar pendente:', err.message);
    return null;
  }
}

/**
 * Salva estado de confirmação pendente no Sheets
 * @param {string} phone - número do remetente (para lookup na próxima mensagem)
 * @param {object} task - tarefa encontrada pelo fuzzy match
 * @param {string} action - intent.intent da ação pretendida
 * @param {object} intent - objeto completo do Haiku (para reexecutar)
 */
async function savePending(phone, task, action, intent) {
  await sheets.post({
    sheetName: SHEET_CONFIRM,
    values: [
      phone,
      String(task._row || ''),
      task._sheetName || SHEET_TASKS,
      task.task || '',
      task.project || '',
      task.person || '',
      task.status || '',
      task.deadline || '',
      action,
      JSON.stringify(intent),
      'pending',
      new Date().toISOString()
    ]
  });
}

/**
 * Cancela uma confirmação pendente (usuário disse "não")
 * @param {number} row
 */
async function clearPending(row) {
  if (!row) return;
  await sheets.patch({
    sheetName: SHEET_CONFIRM,
    row,
    updates: [{ col: 'status', value: 'cancelled' }]
  });
}

/**
 * Marca uma confirmação pendente como aprovada/executada
 * (usado quando a ação não é de tarefa — ex: update_contexto)
 * @param {number} row
 */
async function markApproved(row) {
  if (!row) return;
  await sheets.patch({
    sheetName: SHEET_CONFIRM,
    row,
    updates: [{ col: 'status', value: 'approved' }]
  });
}

/**
 * Salva confirmação pendente para um update no Contexto Vivo
 * Reutiliza a aba ZE_PENDING_CONFIRM com intended_action='update_contexto'
 * @param {string} phone
 * @param {{slug, project, field, value, mode, cliente}} data
 */
async function savePendingContexto(phone, data) {
  const preview = (data.value || '').slice(0, 60);
  await sheets.post({
    sheetName: SHEET_CONFIRM,
    values: [
      phone,
      '',                                  // task_row (n/a)
      'CONTEXTO_VIVO',                     // task_sheet (marcador)
      `${data.field}: ${preview}`,         // task (preview legível)
      data.project || '',                  // project
      '',                                  // person
      '',                                  // task_status
      '',                                  // deadline
      'update_contexto',                   // intended_action
      JSON.stringify(data),                // intent_json (payload completo)
      'pending',
      new Date().toISOString()
    ]
  });
}

/**
 * Resolve e retorna dados para executar a ação confirmada
 * Rebusca a tarefa no Sheets pelo _row para ter dados atualizados
 * @param {object} pending - registro do ZE_PENDING_CONFIRM
 * @returns {Promise<{ match: object|null, intent: object, action: string }>}
 */
async function resolvePending(pending) {
  // Marcar como aprovado
  await sheets.patch({
    sheetName: SHEET_CONFIRM,
    row: pending._row,
    updates: [{ col: 'status', value: 'approved' }]
  });

  // Rebuscar tarefa para ter dados frescos
  let match = null;
  try {
    const data = await sheets.get({ sheetName: pending.task_sheet || SHEET_TASKS });
    const tasks = data.tasks || [];
    const taskRow = parseInt(pending.task_row, 10);
    match = tasks.find(t => t._row === taskRow) || null;
  } catch (err) {
    console.warn('[task-confirm] Erro ao rebuscar tarefa:', err.message);
  }

  let intent = {};
  try { intent = JSON.parse(pending.intent_json || '{}'); } catch (_) {}

  return {
    match,
    intent,
    action: pending.intended_action || intent.intent || ''
  };
}

/**
 * Formata mensagem "é essa?" para confirmação
 * @param {object} task - tarefa encontrada
 * @returns {string}
 */
function buildConfirmMessage(task) {
  const statusEmoji = {
    pendente: '⚪', emaprovacao: '🟡', feito: '✅',
    travado: '🔴', concluido: '✅', cancelado: '⛔'
  };
  const emoji = statusEmoji[(task.status || '').toLowerCase()] || '⚪';
  const partes = [
    task.person  ? `👤 ${task.person}`  : null,
    task.deadline ? `📅 ${task.deadline}` : null,
    `${emoji} ${task.status || 'pendente'}`
  ].filter(Boolean).join(' | ');
  return `Encontrei essa aqui:\n\n📌 *${task.task}* (${task.project})\n${partes}\n\nÉ essa? Responde *sim* ou *não*`;
}

/**
 * Salva menu de desambiguação pendente — várias tarefas parecidas, usuário deve escolher
 * @param {string} phone
 * @param {Array} topMatches - lista de tarefas candidatas (máx 5)
 * @param {object} intent - intent original do Haiku
 */
async function saveAmbiguous(phone, topMatches, intent) {
  await sheets.post({
    sheetName: SHEET_CONFIRM,
    values: [
      phone,
      '',
      SHEET_TASKS,
      '',
      '',
      '',
      '',
      '',
      'ambiguous_select',
      JSON.stringify({ topMatches, intent }),
      'pending',
      new Date().toISOString()
    ]
  });
}

module.exports = { getPending, savePending, saveAmbiguous, clearPending, markApproved, resolvePending, buildConfirmMessage, savePendingContexto };
