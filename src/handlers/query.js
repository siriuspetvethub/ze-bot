// Consulta de tarefas — porta a lógica do nó "Consultar Tarefas" do ZE-ROUTER
// Suporta: minhas tarefas, atraso, urgentes, por projeto, visão geral
'use strict';

const sheets = require('../clients/sheets');
const config = require('../config');

const SHEET_TASKS = 'BACKEND DASH '; // renomeada v25 (trailing space é real)
const STATUS_FECHADOS = ['feito', 'concluido', 'cancelado'];
const STATUS_EMOJI = { pendente: '⬜', andamento: '🔄', emaprovacao: '🟡', travado: '🔴' };
const MAX_DISPLAY = 10;

/**
 * Parseia data no formato brasileiro ou ISO
 * @param {string} s
 * @returns {Date|null}
 */
function parseDate(s) {
  if (!s) return null;
  // ISO YYYY-MM-DD — verificar antes do regex BR para evitar captura errada
  // Ex: "2026-04-03" seria parseado como d=26,m=04,y=03 → 2003-04-26 sem este check
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
  const iso = new Date(s);
  return isNaN(iso) ? null : iso;
}

/**
 * Handler de consulta de tarefas — despacha para o modo correto baseado no intent
 * @param {object} ctx - { intent, person, userMessage }
 * @returns {Promise<{ actionResult, actionMessage }>}
 */
async function handle(ctx) {
  const intentKey = ctx.intent?.intent || 'query_tasks';
  if (intentKey === 'weekly_summary') return handleWeeklySummary(ctx);
  if (intentKey === 'team_view')      return handleTeamView(ctx);
  return handleQuery(ctx);
}

/**
 * Consulta padrão de tarefas (minhas tarefas, atraso, urgentes, por projeto)
 */
async function handleQuery(ctx) {
  const { intent, person, userMessage } = ctx;

  try {
    const data = await sheets.get({ sheetName: SHEET_TASKS });
    const tasks = data.tasks || [];

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const limite30d = new Date(hoje.getTime() - 30 * 86400000);

    const query = (intent?.task || userMessage || '').toLowerCase();
    let filtered = tasks.filter(t => {
      if (STATUS_FECHADOS.some(s => (t.status || '').toLowerCase().includes(s))) return false;
      const d = parseDate(t.deadline);
      return !d || d >= limite30d;
    });
    let title = '';

    if (query.includes('atraso') || query.includes('atrasad')) {
      filtered = filtered.filter(t => { const d = parseDate(t.deadline); return d && d < hoje; });
      title = `Tarefas em atraso (${filtered.length})`;
    } else if (query.includes('minh') || query.includes('meu')) {
      filtered = filtered.filter(t => t.person === person);
      title = `Suas tarefas (${filtered.length})`;
    } else if (query.includes('urgent') || query.includes('priorid')) {
      const in48h = new Date(hoje.getTime() + 2 * 86400000);
      filtered = filtered.filter(t => { const d = parseDate(t.deadline); return d && d <= in48h; });
      title = `Urgentes — vencem em 48h (${filtered.length})`;
    } else if (intent?.project) {
      const p = intent.project.toLowerCase();
      filtered = filtered.filter(t => (t.project || '').toLowerCase().includes(p));
      title = `Projeto ${intent.project} (${filtered.length} pendentes)`;
    } else {
      // Default: tarefas da pessoa
      filtered = filtered.filter(t => t.person === person);
      title = `Suas tarefas (${filtered.length})`;
    }

    const display = filtered.slice(0, MAX_DISPLAY);
    let msg = `*${title}*\n\n`;

    display.forEach(t => {
      const em = STATUS_EMOJI[t.status] || '⬜';
      const link = config.taskLink(t);
      msg += `${em} *${t.project}* — ${t.task}`;
      if (t.deadline) msg += ` (${t.deadline})`;
      if (t.person && t.person !== person) msg += ` [${t.person}]`;
      msg += `\n`;
      if (t.nextAction) msg += `   ⚡ ${t.nextAction}\n`;
      if ((t.status || '').toLowerCase().includes('travado') && t.blocker) msg += `   🚧 ${t.blocker}\n`;
      msg += `   🔗 ${link}\n`;
    });

    if (filtered.length > MAX_DISPLAY) {
      msg += `\n... e mais ${filtered.length - MAX_DISPLAY}. Ver tudo: ${config.DASHBOARD_URL}`;
    }
    if (filtered.length === 0) msg += '_Nenhuma tarefa encontrada_ 🎉';

    return { actionResult: 'query', actionMessage: msg };
  } catch (err) {
    console.error('[query] Erro:', err.message);
    return { actionResult: 'error', actionMessage: 'Erro ao consultar tarefas: ' + err.message };
  }
}

/**
 * Resumo semanal — tarefas da pessoa para os próximos 7 dias agrupadas por dia
 */
async function handleWeeklySummary(ctx) {
  const { person } = ctx;

  try {
    const data = await sheets.get({ sheetName: SHEET_TASKS });
    const tasks = data.tasks || [];

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const em7d = new Date(hoje.getTime() + 7 * 86400000);
    const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    // Abertas desta pessoa com deadline nos próximos 7 dias + atrasadas
    const abertas = tasks.filter(t => {
      if (STATUS_FECHADOS.some(s => (t.status || '').toLowerCase().includes(s))) return false;
      return t.person === person;
    });

    const semana = abertas.filter(t => {
      const d = parseDate(t.deadline);
      return d && d <= em7d;
    }).sort((a, b) => {
      const da = parseDate(a.deadline), db = parseDate(b.deadline);
      return (!da && !db) ? 0 : !da ? 1 : !db ? -1 : da - db;
    });

    const semDl = abertas.filter(t => !parseDate(t.deadline));

    if (semana.length === 0 && semDl.length === 0) {
      return { actionResult: 'query', actionMessage: `*Sua semana, ${person}*\n\nNenhuma tarefa para os próximos 7 dias 🎉\n\n📊 ${config.DASHBOARD_URL}` };
    }

    // Agrupar por dia
    const byDay = {};
    semana.forEach(t => {
      const d = parseDate(t.deadline);
      let label;
      if (d < hoje) {
        label = '⚠️ Em atraso';
      } else if (d.getTime() === hoje.getTime()) {
        label = `🔴 Hoje (${DIAS[d.getDay()]})`;
      } else {
        const diff = Math.round((d - hoje) / 86400000);
        label = `📅 ${DIAS[d.getDay()]} (daqui ${diff}d — ${t.deadline})`;
      }
      if (!byDay[label]) byDay[label] = [];
      byDay[label].push(t);
    });

    let msg = `*Sua semana, ${person}* 📅\n\n`;
    for (const [label, tlist] of Object.entries(byDay)) {
      msg += `${label}:\n`;
      tlist.forEach(t => {
        msg += `  ${STATUS_EMOJI[t.status] || '⬜'} *[${t.project}]* ${t.task}\n`;
        if (t.nextAction) msg += `     ⚡ ${t.nextAction}\n`;
        if ((t.status || '').toLowerCase().includes('travado') && t.blocker) msg += `     🚧 ${t.blocker}\n`;
        msg += `     🔗 ${config.taskLink(t)}\n`;
      });
      msg += '\n';
    }

    if (semDl.length > 0) {
      msg += `📌 *Sem prazo (${semDl.length}):*\n`;
      semDl.slice(0, 5).forEach(t => {
        msg += `  ⬜ *[${t.project}]* ${t.task}\n`;
        if (t.nextAction) msg += `     ⚡ ${t.nextAction}\n`;
        msg += `     🔗 ${config.taskLink(t)}\n`;
      });
      if (semDl.length > 5) msg += `  ... e mais ${semDl.length - 5}\n`;
    }

    msg += `\n📊 ${config.DASHBOARD_URL}`;
    return { actionResult: 'query', actionMessage: msg };
  } catch (err) {
    console.error('[query] Erro weekly_summary:', err.message);
    return { actionResult: 'error', actionMessage: 'Erro ao gerar resumo semanal: ' + err.message };
  }
}

/**
 * Visão do time — card por pessoa com tarefas, atrasadas, travadas (apenas para Thiago)
 */
async function handleTeamView(ctx) {
  const { person } = ctx;

  // Só Thiago pode ver o time completo
  if (person !== 'Thiago') {
    return handleWeeklySummary(ctx); // redireciona para resumo pessoal
  }

  try {
    const data = await sheets.get({ sheetName: SHEET_TASKS });
    const tasks = data.tasks || [];

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

    const abertas = tasks.filter(t =>
      !STATUS_FECHADOS.some(s => (t.status || '').toLowerCase().includes(s))
    );

    // Agrupar por pessoa
    const byPerson = {};
    abertas.forEach(t => {
      const p = t.person || '(sem responsável)';
      if (!byPerson[p]) byPerson[p] = { total: 0, atrasadas: 0, travadas: 0, andamento: 0, hoje: 0 };
      byPerson[p].total++;
      const d = parseDate(t.deadline);
      if (d && d < hoje) byPerson[p].atrasadas++;
      if (d && d.getTime() === hoje.getTime()) byPerson[p].hoje++;
      if ((t.status || '').toLowerCase().includes('travado')) byPerson[p].travadas++;
      if ((t.status || '').toLowerCase().includes('andamento')) byPerson[p].andamento++;
    });

    // Ordenar: mais atrasadas primeiro
    const entries = Object.entries(byPerson).sort(([, a], [, b]) => b.atrasadas - a.atrasadas || b.total - a.total);

    let msg = `*👥 Visão do Time*\n_${new Date().toLocaleDateString('pt-BR')}_\n\n`;

    for (const [personName, st] of entries) {
      const parts = [];
      if (st.andamento > 0)  parts.push(`🔄 ${st.andamento} em andamento`);
      if (st.hoje > 0)       parts.push(`📅 ${st.hoje} vencem hoje`);
      if (st.atrasadas > 0)  parts.push(`⚠️ ${st.atrasadas} atrasadas`);
      if (st.travadas > 0)   parts.push(`🔴 ${st.travadas} travadas`);
      const resumo = parts.length > 0 ? parts.join(' | ') : '✅ em dia';
      msg += `*${personName}* — ${st.total} tarefa(s) | ${resumo}\n`;
    }

    const feitas = tasks.filter(t => (t.status || '').toLowerCase().includes('feito')).length;
    msg += `\n_Total: ${tasks.length} | ${abertas.length} abertas | ${feitas} concluídas_\n`;
    msg += `📊 ${config.DASHBOARD_URL}`;

    return { actionResult: 'query', actionMessage: msg };
  } catch (err) {
    console.error('[query] Erro team_view:', err.message);
    return { actionResult: 'error', actionMessage: 'Erro ao gerar visão do time: ' + err.message };
  }
}

module.exports = { handle };
