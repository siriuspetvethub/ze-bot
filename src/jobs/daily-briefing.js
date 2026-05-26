// Job: Briefing pós-daily — enviado após o Zé subir as tarefas da daily
// Envia para cada membro: tarefas novas da daily de hoje + atrasadas em aberto
// + CTA para reportar tarefas não mapeadas
'use strict';

const sheets    = require('../clients/sheets');
const evolution = require('../clients/evolution');
const config    = require('../config');
const { frame } = require('../formatters/sirius-frame');

const STATUS_FECHADOS = ['feito', 'concluido', 'cancelado'];

function parseDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) {
    const d = new Date(String(s).slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? null : d;
  }
  const br = String(s).match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-]?(\d{2,4})?/);
  if (br) {
    const [, d, m, y] = br;
    const year = y ? (y.length === 2 ? '20' + y : y) : '2026';
    return new Date(`${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00`);
  }
  return null;
}

function prioOrder(t) {
  const p = (t.priority || '').toLowerCase();
  if (p === 'alta')  return 0;
  if (p === 'media') return 1;
  if (p === 'baixa') return 2;
  return 3;
}

function sortByPrio(arr) {
  return arr.slice().sort((a, b) => prioOrder(a) - prioOrder(b));
}

function isAberta(t) {
  const st = (t.status || '').toLowerCase();
  return !STATUS_FECHADOS.some(s => st.includes(s));
}

/** Remove diacríticos para comparação normalizada */
function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function fmtTask(t, showDeadline = false) {
  const prio  = t.priority === 'alta' ? '🔴 ' : t.priority === 'media' ? '🟡 ' : '';
  const prazo = showDeadline && t.deadline ? ` _(${t.deadline})_` : '';
  let line = `  • ${prio}*[${t.project}]* ${t.task}${prazo}\n`;
  line += `     🔗 ${config.taskLink(t)}\n`;
  return line;
}

/** Retorna data local BRT no formato YYYY-MM-DD */
function todayBRT() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

/** Verifica se tarefa é nova — por ID explícito ou por origin+createdAt */
function isNew(t, newIds) {
  if (newIds && newIds.length > 0) return newIds.includes(t.id);
  const hoje = todayBRT();
  if ((t.origin || '').startsWith('daily-')) {
    return (t.createdAt || '').slice(0, 10) === hoje;
  }
  return false;
}

/**
 * Envia briefing pós-daily para cada pessoa da equipe com:
 * - Tarefas novas da daily de hoje (por pessoa)
 * - Tarefas em atraso (por pessoa)
 * - CTA para reportar tarefas não mapeadas
 *
 * @param {string[]} [newTaskIds] - Lista explícita de IDs das tarefas novas.
 *   Quando fornecida, usa IDs para identificar novas (mais confiável).
 *   Quando omitida, tenta detectar por origin=daily-* + createdAt=hoje.
 */
async function run(newTaskIds = []) {
  console.log('[daily-briefing] Iniciando envio pós-daily', newTaskIds.length ? `(${newTaskIds.length} IDs explícitos)` : '(auto-detecção)');
  try {
    const taskData = await sheets.get({ sheetName: 'BACKEND DASH ' });
    const tasks = taskData.tasks || [];

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

    const abertas = tasks.filter(t => t.person && isAberta(t));

    for (const [personName, phone] of Object.entries(config.TEAM_PHONES)) {
      if (!phone) continue;
      // Evita duplicatas de aliases com acento (Álvaro / João)
      if (/[áàãâéêíóôõúç]/i.test(personName)) continue;

      const normName = norm(personName);
      const minhas = abertas.filter(t =>
        (t.person || '').split(/[,e&]+/).map(p => norm(p.trim())).includes(normName)
      );

      const novas    = sortByPrio(minhas.filter(t => isNew(t, newTaskIds)));
      const atrasadas = sortByPrio(minhas.filter(t => {
        const d = parseDate(t.deadline);
        return d && d < hoje && !isNew(t, newTaskIds);
      }));

      if (novas.length === 0 && atrasadas.length === 0) continue;

      let body = `Oi, *${personName}*. Acabei de subir as tarefas da daily de hoje.\n\n`;

      if (novas.length > 0) {
        body += `*✅ ${novas.length} nova${novas.length > 1 ? 's' : ''} pra você:*\n`;
        novas.forEach(t => { body += fmtTask(t, true); });
        body += '\n';
      }

      if (atrasadas.length > 0) {
        body += `⚠️ *${atrasadas.length} em atraso:*\n`;
        atrasadas.slice(0, 4).forEach(t => { body += fmtTask(t, true); });
        if (atrasadas.length > 4) body += `  _... e mais ${atrasadas.length - 4}_\n`;
        body += '\n';
      }

      body += `_Percebeu alguma tarefa sua que não está mapeada? Me avisa aqui que eu mesmo subo no painel pra você._ 👍`;

      const msg = frame({
        contextLabel: 'Briefing · 08h',
        body,
        linkLabel: 'painel operacional',
        link: config.DASHBOARD_URL,
      });

      await evolution.sendText(phone, msg);
      console.log(`[daily-briefing] Enviado para ${personName} (${phone}) — ${novas.length} nova(s), ${atrasadas.length} atrasada(s)`);
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log('[daily-briefing] Concluído');
  } catch (err) {
    console.error('[daily-briefing] Erro:', err.message);
    throw err;
  }
}

module.exports = { run };
