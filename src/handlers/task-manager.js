// Gerenciador de tarefas — CRUD completo via Sheets proxy
// Porta a lógica dos nós "Resolver e Atualizar" e "Criar Tarefa" do ZE-ROUTER
// e o workflow ZE-TASK-MGR completo (com desambiguação e delete)
'use strict';

const sheets      = require('../clients/sheets');
const evolution   = require('../clients/evolution');
const config      = require('../config');
const taskConfirm = require('./task-confirm');

// Aba de tarefas — atenção ao trailing space (nome real da aba, renomeada v25)
const SHEET_TASKS = 'BACKEND DASH ';
const SHEET_REMINDERS = 'ZE_REMINDERS';

// Status que indicam tarefa fechada (não editar)
const STATUS_FECHADOS = ['feito', 'concluido', 'cancelado'];

/**
 * Normaliza string para comparação fuzzy (remove acentos, lowercase)
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Regex para capturar @mencoes (nomes do time)
const MENTION_REGEX = /[@＠](thiago|álvaro|alvaro|crissa|luan|chardson|paula|joão|joao)/gi;

/**
 * Extrai nomes mencionados via @ em um texto, mapeando para chaves do TEAM_PHONES
 * @param {string} text
 * @returns {string[]} array de nomes canônicos (ex: ['Thiago', 'Crissa'])
 */
function extractMentions(text) {
  const matches = [];
  const seen = new Set();
  let m;
  MENTION_REGEX.lastIndex = 0;
  while ((m = MENTION_REGEX.exec(text || '')) !== null) {
    const normalized = norm(m[1]);
    const canonical = Object.keys(config.TEAM_PHONES).find(k => norm(k) === normalized);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      matches.push(canonical);
    }
  }
  return matches;
}

/**
 * Envia notificação WhatsApp para cada pessoa mencionada (exceto quem enviou)
 * @param {string[]} mentions
 * @param {object} task - tarefa afetada (ou objeto parcial com task/project/id)
 * @param {string} senderPerson - quem fez a ação
 * @param {string} textSnippet - trecho onde ocorreu a menção
 */
function notifyMentioned(mentions, task, senderPerson, textSnippet) {
  if (!mentions || mentions.length === 0) return;
  const tLink = config.taskLink(task);
  const excerpt = (textSnippet || '').slice(0, 120);
  for (const name of mentions) {
    if (norm(name) === norm(senderPerson)) continue; // não notificar quem enviou
    const phone = config.TEAM_PHONES[name];
    if (!phone) continue;
    const msg = `🔔 *${senderPerson}* te mencionou numa tarefa:\n\n📌 *${task.task || ''}* (${task.project || ''})\n💬 "${excerpt}"\n\n🔗 ${tLink}`;
    evolution.sendText(phone, msg).catch(e =>
      console.warn(`[task-manager] Falha ao notificar menção para ${name}:`, e.message)
    );
  }
}

/**
 * Notifica o grupo admin sobre uma mutação de tarefa (fire and forget)
 * @param {string} action - Intent executado
 * @param {object} task - Tarefa afetada
 * @param {string} person - Quem fez a ação
 * @param {object} [extra] - Campos adicionais (newStatus, note, target, deadline)
 */
function notifyGroup(action, task, person, extra = {}) {
  const tLink = config.taskLink(task);
  const proj  = task.project || '';
  const name  = task.task    || '';

  const LABELS = {
    update_task_status: () => `${person} atualizou *[${proj}]* ${name}\n   Status → *${extra.newStatus || ''}*`,
    add_note:           () => `${person} adicionou nota em *[${proj}]* ${name}\n   💬 _${(extra.note || '').slice(0, 80)}_`,
    transfer_task:      () => `${person} transferiu *[${proj}]* ${name}\n   → *${extra.target || ''}*`,
    reschedule_task:    () => `${person} reagendou *[${proj}]* ${name}\n   📅 Novo prazo: *${extra.deadline || ''}*`,
    block_task:         () => `${person} travou *[${proj}]* ${name}${extra.reason ? `\n   🚧 ${extra.reason}` : ''}`,
    delete_task:        () => `${person} removeu a tarefa *[${proj}]* ${name}`,
    create_task:        () => `${person} criou nova tarefa em *[${proj}]*\n   📋 ${name}${extra.deadline ? ` — prazo ${extra.deadline}` : ''}`,
  };

  const textFn = LABELS[action];
  if (!textFn) return;

  const groupId = config.ADMIN_GROUP_ID.replace('@g.us', '');
  const msg = `🔔 *Atualização de Tarefa*\n\n${textFn()}\n\n🔗 ${tLink}`;
  evolution.sendText(groupId, msg).catch(e =>
    console.warn('[task-manager] Falha ao notificar grupo:', e.message)
  );
}

/**
 * Fuzzy match de uma tarefa nos resultados do Sheets
 * @param {Array} tasks - Lista de tarefas
 * @param {object} intent - Intenção classificada pelo Haiku
 * @param {string} person - Nome do remetente (para filtro de pessoa)
 * @returns {{ match: object|null, ambiguous: boolean, topMatches: Array }}
 */
function resolveTask(tasks, intent, person) {
  // create_task não precisa resolver tarefa existente
  if (intent.intent === 'create_task') {
    return { match: null, ambiguous: false, topMatches: [], skipResolve: true };
  }

  let candidates = tasks.filter(t => !STATUS_FECHADOS.some(s => norm(t.status).includes(s)));

  // Filtrar por projeto se fornecido
  if (intent.project) {
    const filtered = candidates.filter(t => norm(t.project).includes(norm(intent.project)));
    if (filtered.length > 0) candidates = filtered;
  }

  // Filtrar por pessoa
  const personName = intent.person || person;
  if (personName) {
    const filtered = candidates.filter(t => norm(t.person).includes(norm(personName)));
    if (filtered.length > 0) candidates = filtered;
  }

  if (!intent.task) {
    return { match: null, ambiguous: false, topMatches: [] };
  }

  const terms = norm(intent.task).split(' ').filter(w => w.length > 2);
  if (terms.length === 0) {
    return { match: null, ambiguous: false, topMatches: [] };
  }

  const scored = candidates
    .map(t => ({
      ...t,
      matchScore: terms.reduce((acc, w) => acc + (norm(t.task).includes(w) ? 1 : 0), 0) / terms.length
    }))
    .filter(t => t.matchScore > 0.3)
    .sort((a, b) => b.matchScore - a.matchScore);

  if (scored.length === 0) return { match: null, ambiguous: false, topMatches: [] };
  if (scored.length === 1) return { match: scored[0], ambiguous: false, topMatches: [] };

  // Top match muito superior ao segundo: usar diretamente
  if (scored[0].matchScore > scored[1].matchScore * 1.5) {
    return { match: scored[0], ambiguous: false, topMatches: [] };
  }

  return { match: null, ambiguous: true, topMatches: scored.slice(0, 3) };
}

/**
 * Handler principal — processa intenções de CRUD de tarefas
 * @param {object} ctx - { intent, person, userMessage }
 * @returns {Promise<{ actionResult, actionMessage }>}
 */
async function handle(ctx) {
  const { intent, person } = ctx;
  const action = intent.intent;

  try {
    // Criar tarefa (não precisa de busca)
    if (action === 'create_task') {
      const result = await createTask(intent, person);
      if (result.actionResult === 'created') {
        const mentions = extractMentions([ctx.userMessage, intent.notes].filter(Boolean).join(' '));
        notifyMentioned(mentions, { task: intent.task, project: intent.project || 'SIRIUS', id: null }, person, ctx.userMessage);
      }
      return result;
    }

    // Buscar todas as tarefas para resolver a mencionada
    const data = await sheets.get({ sheetName: SHEET_TASKS });
    const tasks = data.tasks || [];
    const { match, ambiguous, topMatches } = resolveTask(tasks, intent, person);

    // Desambiguação: múltiplos candidatos similares
    if (ambiguous) {
      await taskConfirm.saveAmbiguous(ctx.senderNumber, topMatches, intent).catch(e =>
        console.warn('[task-manager] Erro ao salvar ambiguous:', e.message)
      );
      const lista = topMatches.map((t, i) => `${i + 1}. *${t.project}* — ${t.task} [${t.person}]`).join('\n');
      return {
        actionResult: 'ambiguous',
        actionMessage: `Achei ${topMatches.length} tarefas parecidas. Qual você quer?\n\n${lista}\n\nResponde com o número (1, 2 ou 3) ou descreva melhor.`
      };
    }

    // Tarefa não encontrada
    if (!match) {
      return {
        actionResult: 'not_found',
        actionMessage: `Não encontrei *${intent.task || 'essa tarefa'}* no projeto *${intent.project || 'informado'}*. Pode descrever melhor ou acessar o dash: ${config.DASHBOARD_URL}`
      };
    }

    // Delete: pedir confirmação própria (não usa pending confirm)
    if (action === 'delete_task') {
      return await deleteTask(match, ctx.userMessage);
    }

    // Para qualquer mutação: pedir confirmação "é essa?" antes de executar
    await taskConfirm.savePending(ctx.senderNumber, match, action, intent);
    return {
      actionResult: 'confirm_required',
      actionMessage: taskConfirm.buildConfirmMessage(match)
    };

  } catch (err) {
    console.error('[task-manager] Erro:', err.message);
    return { actionResult: 'error', actionMessage: 'Erro ao processar tarefa: ' + err.message };
  }
}

/**
 * Cria nova tarefa no Sheets
 */
async function createTask(intent, person) {
  const result = await sheets.post({
    sheetName: SHEET_TASKS,
    data: {
      project:  intent.project  || 'SIRIUS',
      task:     intent.task     || '',
      person:   intent.person   || person || '',
      deadline: intent.newDeadline || '',
      status:   'pendente',
      blocker:  '',
      notes:    'Criado pelo Zé via WhatsApp',
      origin:   'ze-whatsapp'
    }
  });

  const resp = intent.person && intent.person !== person ? ` para ${intent.person}` : '';
  const prazo = intent.newDeadline ? ` Prazo: ${intent.newDeadline}` : '';
  const link = result?.id ? config.taskLink({ id: result.id }) : config.DASHBOARD_URL;
  notifyGroup('create_task',
    { task: intent.task, project: intent.project || 'SIRIUS', id: result?.id },
    person,
    { deadline: intent.newDeadline }
  );
  return {
    actionResult: 'created',
    actionMessage: `Tarefa *${intent.task}* criada no projeto *${intent.project || 'SIRIUS'}*${resp}.${prazo}\n🔗 ${link}`
  };
}

/**
 * Executa ação de mutação em uma tarefa encontrada
 */
async function executeAction(action, match, intent, person) {
  const updates = [];
  let actionMessage = '';

  switch (action) {
    case 'update_task_status': {
      const newStatus = intent.status || 'feito';
      if (match._colStatus) updates.push({ col: match._colStatus, value: newStatus });
      const tLink = config.taskLink(match);
      actionMessage = `*${match.task}* (${match.project}) → *${newStatus}* ✅\n🔗 ${tLink}`;
      if (newStatus === 'feito') {
        actionMessage += `\n\n💡 _Se aprendeu algo no processo:\naprendi: [seu texto]_`;
      }
      notifyGroup('update_task_status', match, person, { newStatus });
      // Notificar Thiago individualmente quando tarefa vai para aprovação
      if (newStatus === 'emaprovacao') {
        const approvalMsg = `🟡 *${person}* colocou uma tarefa em aprovação:\n\n*[${match.project}]* ${match.task}\n\n🔗 ${tLink}`;
        evolution.sendText(config.ADMIN_PHONE, approvalMsg).catch(e =>
          console.warn('[task-manager] Falha ao notificar aprovação:', e.message)
        );
      }
      break;
    }

    case 'add_note': {
      if (match._colNotes) {
        const curr = match.notes || '';
        const dateStr = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const entry = `${person} ${dateStr}: ${intent.notes}`;
        updates.push({ col: match._colNotes, value: curr ? `${curr} | ${entry}` : entry });
      }
      const tLinkNote = config.taskLink(match);
      actionMessage = `Nota adicionada em *${match.task}* (${match.project}).\n🔗 ${tLinkNote}`;
      notifyGroup('add_note', match, person, { note: intent.notes });
      break;
    }

    case 'transfer_task': {
      const target = intent.targetPerson || intent.person;
      if (match._colPerson) updates.push({ col: match._colPerson, value: target || '' });
      const tLinkTransfer = config.taskLink(match);
      actionMessage = `*${match.task}* transferida para *${target}*.\n🔗 ${tLinkTransfer}`;
      notifyGroup('transfer_task', match, person, { target });
      // Notificar o novo responsável individualmente
      const targetPhone = config.TEAM_PHONES[target];
      if (targetPhone && target !== person) {
        evolution.sendText(targetPhone,
          `📋 *${person}* te transferiu uma tarefa:\n\n*[${match.project}]* ${match.task}\n\n🔗 ${tLinkTransfer}`
        ).catch(e => console.warn('[task-manager] Falha ao notificar transferência:', e.message));
      }
      break;
    }

    case 'reschedule_task': {
      if (match._colDeadline) updates.push({ col: match._colDeadline, value: intent.newDeadline || '' });
      const tLinkReschedule = config.taskLink(match);
      actionMessage = `Prazo de *${match.task}* alterado para *${intent.newDeadline}*.\n🔗 ${tLinkReschedule}`;
      notifyGroup('reschedule_task', match, person, { deadline: intent.newDeadline });
      break;
    }

    case 'block_task': {
      if (match._colStatus) updates.push({ col: match._colStatus, value: 'travado' });
      if (match._colBlocker && intent.notes) updates.push({ col: match._colBlocker, value: intent.notes });
      const tLinkBlock = config.taskLink(match);
      actionMessage = `*${match.task}* marcada como _travada_.${intent.notes ? ' Motivo: ' + intent.notes : ''}\n🔗 ${tLinkBlock}`;
      notifyGroup('block_task', match, person, { reason: intent.notes });
      break;
    }

    default:
      return { actionResult: 'unknown', actionMessage: 'Ação não reconhecida: ' + action };
  }

  if (match._colUpdatedAt) {
    updates.push({ col: match._colUpdatedAt, value: new Date().toISOString().slice(0, 10) });
  }

  if (updates.length > 0) {
    await sheets.patch({ sheetName: match._sheetName || SHEET_TASKS, row: match._row, updates });
  }

  // Se tarefa concluída ou travada, resolver reminders pendentes no ZE_REMINDERS
  if (action === 'update_task_status' && ['feito', 'travado'].includes(intent.status)) {
    resolveReminders(person, match.task).catch(err =>
      console.warn('[task-manager] Erro ao resolver reminders:', err.message)
    );
  }

  return { actionResult: 'success', actionMessage };
}

/**
 * Confirma e executa delete de uma tarefa
 */
async function deleteTask(match, userMessage) {
  const isConfirm = /^(sim|confirma|yes|pode|ok|vai)\b/i.test((userMessage || '').trim());

  if (isConfirm && match._row) {
    await sheets.remove({ sheetName: match._sheetName || SHEET_TASKS, row: match._row });
    return {
      actionResult: 'deleted',
      actionMessage: `Tarefa *${match.task}* (${match.project}) removida. Se foi engano, avisa que posso recriar.`
    };
  }

  return {
    actionResult: 'confirm_delete',
    actionMessage: `Tem certeza que quer apagar:\n*${match.task}* (${match.project})?\n\nResponde _sim_ pra confirmar.`
  };
}

/**
 * Marca reminders pendentes como resolvidos quando tarefa é concluída
 */
async function resolveReminders(person, taskName) {
  const data = await sheets.get({ sheetName: SHEET_REMINDERS });
  const reminders = (data.tasks || []).filter(r =>
    r.person === person &&
    r.task_name === taskName &&
    r.resolved !== 'true'
  );
  for (const r of reminders) {
    await sheets.patch({
      sheetName: SHEET_REMINDERS,
      row: r._row,
      updates: [{ col: 'resolved', value: 'true' }]
    });
  }
}

module.exports = { handle, executeAction };
