// Relatório diário e semanal — ZE-REPORT v2
// v2: contexto vivo no relatório 19h, envio para MANAGERS (Thiago + Chardson)
'use strict';

const sheets    = require('../clients/sheets');
const evolution = require('../clients/evolution');
const config    = require('../config');

const SHEET_TASKS = 'BACKEND DASH ';
const SHEET_LOG   = 'ZE_LOG';
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
  const iso = new Date(s);
  return isNaN(iso) ? null : iso;
}

async function sendToManagers(text) {
  for (const phone of config.MANAGERS) {
    await evolution.sendText(phone, text).catch(e =>
      console.warn(`[report] Falha ao enviar para manager ${phone}:`, e.message)
    );
    await new Promise(r => setTimeout(r, 800));
  }
}

async function run() {
  console.log('[report] Gerando relatório diário');
  try {
    const hoje    = new Date(); hoje.setHours(0, 0, 0, 0);
    const hojeStr = new Date().toISOString().slice(0, 10);
    const hojeDD  = new Date().toLocaleDateString('pt-BR').slice(0, 5); // "DD/MM"

    const [taskData, contextoVivo] = await Promise.all([
      sheets.get({ sheetName: SHEET_TASKS }),
      sheets.getContextoVivo().catch(() => ({}))
    ]);
    const tasks = taskData.tasks || [];

    let todayLog = [];
    try {
      const logData = await sheets.get({ sheetName: SHEET_LOG });
      const allLog  = logData.tasks || [];
      todayLog = allLog.filter(e => (e.timestamp || '').startsWith(hojeStr));
    } catch (_) {}

    const abertas    = tasks.filter(t => !STATUS_FECHADOS.some(s => (t.status || '').toLowerCase().includes(s)));
    const feitas     = tasks.filter(t => (t.status || '').toLowerCase().includes('feito') || (t.status || '').toLowerCase().includes('concluido'));
    const atrasadas  = abertas.filter(t => { const d = parseDate(t.deadline); return d && d < hoje; });
    const travadas   = abertas.filter(t => (t.status || '').toLowerCase().includes('travado'));
    const ventemHoje = abertas.filter(t => { const d = parseDate(t.deadline); return d && d.getTime() === hoje.getTime(); });
    const semDono    = abertas.filter(t => !t.person || t.person.trim() === '');

    const byProject = {};
    tasks.forEach(t => {
      const proj = t.project || 'SEM PROJETO';
      if (!byProject[proj]) byProject[proj] = { total: 0, abertas: 0, feitas: 0, atrasadas: 0 };
      byProject[proj].total++;
      const st = (t.status || '').toLowerCase();
      if (STATUS_FECHADOS.some(s => st.includes(s))) {
        byProject[proj].feitas++;
      } else {
        byProject[proj].abertas++;
        const d = parseDate(t.deadline);
        if (d && d < hoje) byProject[proj].atrasadas++;
      }
    });

    const byPerson = {};
    abertas.forEach(t => {
      const people = (t.person || 'Sem Responsável').split(/[,e&]+/).map(p => p.trim()).filter(Boolean);
      for (const p of people) {
        if (!byPerson[p]) byPerson[p] = { total: 0, atrasadas: 0, travadas: 0 };
        byPerson[p].total++;
        const d = parseDate(t.deadline);
        if (d && d < hoje) byPerson[p].atrasadas++;
        if ((t.status || '').toLowerCase().includes('travado')) byPerson[p].travadas++;
      }
    });

    const intentCounts = {};
    todayLog.forEach(e => {
      const intent = e.intent || 'unknown';
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    });

    // Status de atualização do contexto vivo por projeto
    const contextoStatus = {};
    Object.entries(contextoVivo).forEach(([slug, ctx]) => {
      if (!ctx || !ctx.cliente) return;
      contextoStatus[ctx.cliente] = {
        atualizadoHoje: (ctx.atualizado_em || '').includes(hojeDD),
        dataUltima:     ctx.data_reuniao || ctx.atualizado_em || 'desconhecida',
        dono:           ctx.responsaveis?.dono || '',
        status:         ctx.status || 'ativo'
      };
    });

    const reportDate = new Date().toLocaleDateString('pt-BR');
    const msg = buildReportMessage({
      reportDate,
      stats: {
        total: tasks.length, abertas: abertas.length, feitas: feitas.length,
        atrasadas: atrasadas.length, travadas: travadas.length,
        ventemHoje: ventemHoje.length, semDono: semDono.length,
        interacoesHoje: todayLog.length
      },
      byProject, byPerson, intentCounts,
      sampleAtrasadas: atrasadas.slice(0, 5),
      sampleTravadas:  travadas.slice(0, 3),
      contextoStatus
    });

    await sendToManagers(msg);

    sheets.post({
      sheetName: SHEET_LOG,
      values: [new Date().toISOString(), 'system', 'daily_report',
        `${tasks.length} tarefas | ${atrasadas.length} atrasadas | ${feitas.length} feitas`,
        '', '', '', '', '']
    }).catch(() => {});

    console.log('[report] Relatório enviado para managers');
  } catch (err) {
    console.error('[report] Erro ao gerar relatório:', err.message);
    evolution.sendText(config.ADMIN_PHONE,
      `⚠️ *Relatório Zé — ${new Date().toLocaleDateString('pt-BR')}*\n\nErro: ${err.message}\n\n📊 ${config.DASHBOARD_URL}`
    ).catch(() => {});
  }
}

function buildReportMessage({ reportDate, stats: s, byProject, byPerson, intentCounts, sampleAtrasadas, sampleTravadas, contextoStatus }) {
  let msg = `📊 *Relatório Operacional — ${reportDate}*\n_Gerado pelo Zé às 19h_\n\n`;

  msg += `*Visão Geral:*\n`;
  msg += `• ${s.total} tarefas no total\n`;
  msg += `• ${s.abertas} abertas | ${s.feitas} concluídas\n`;
  if (s.atrasadas > 0)      msg += `• ⚠️ *${s.atrasadas} em atraso*\n`;
  if (s.travadas > 0)       msg += `• 🔴 ${s.travadas} travada(s)\n`;
  if (s.ventemHoje > 0)     msg += `• 📅 ${s.ventemHoje} vencem hoje\n`;
  if (s.semDono > 0)        msg += `• ❓ ${s.semDono} sem responsável\n`;
  if (s.interacoesHoje > 0) msg += `• 💬 ${s.interacoesHoje} interações com Zé hoje\n`;
  msg += '\n';

  const projects = Object.entries(byProject);
  if (projects.length > 0) {
    msg += `*Por Projeto:*\n`;
    projects
      .sort(([, a], [, b]) => b.atrasadas - a.atrasadas || (b.feitas / b.total) - (a.feitas / a.total))
      .slice(0, 8)
      .forEach(([proj, st]) => {
        const pct    = st.total > 0 ? Math.round(st.feitas / st.total * 100) : 0;
        const filled = Math.round(pct / 100 * 8);
        const bar    = '█'.repeat(filled) + '░'.repeat(8 - filled);
        const atLabel = st.atrasadas > 0 ? ` ⚠️${st.atrasadas}` : '';
        msg += `${bar} *${proj}* ${pct}%${atLabel}\n`;
        msg += `  _(${st.feitas}/${st.total} feitas, ${st.abertas} abertas)_\n`;
      });
    msg += '\n';
  }

  // Contexto vivo — atualizado hoje?
  const ctxEntries = Object.entries(contextoStatus);
  if (ctxEntries.length > 0) {
    msg += `*Contexto Vivo:*\n`;
    ctxEntries.forEach(([cliente, info]) => {
      const icone = info.atualizadoHoje ? '✅' : '⚠️';
      const nota  = info.atualizadoHoje
        ? `atualizado hoje`
        : `desatualizado — última vez: ${info.dataUltima}`;
      msg += `${icone} *${cliente}* — ${nota}`;
      if (!info.atualizadoHoje && info.dono) msg += ` (resp: ${info.dono})`;
      msg += '\n';
    });
    msg += '\n';
  }

  const pessoas = Object.entries(byPerson);
  if (pessoas.length > 0) {
    msg += `*Por Pessoa (abertas):*\n`;
    pessoas
      .sort(([, a], [, b]) => b.atrasadas - a.atrasadas || b.total - a.total)
      .forEach(([pessoa, st]) => {
        const parts = [`${st.total} tarefa(s)`];
        if (st.atrasadas > 0) parts.push(`⚠️ ${st.atrasadas}`);
        if (st.travadas > 0)  parts.push(`🔴 ${st.travadas} travada(s)`);
        msg += `• *${pessoa}*: ${parts.join(' | ')}\n`;
      });
    msg += '\n';
  }

  if (sampleAtrasadas.length > 0) {
    msg += `*Top atrasos:*\n`;
    sampleAtrasadas.slice(0, 3).forEach(t => {
      msg += `⚠️ [${t.project}] ${t.task} → ${t.person || 'sem resp.'}\n`;
    });
    msg += '\n';
  }

  if (sampleTravadas.length > 0) {
    msg += `*Travadas:*\n`;
    sampleTravadas.forEach(t => {
      const blocker = t.blocker ? ` — _${t.blocker.slice(0, 60)}_` : '';
      msg += `🔴 [${t.project}] ${t.task}${blocker}\n`;
    });
    msg += '\n';
  }

  const intents = Object.entries(intentCounts);
  if (intents.length > 0) {
    msg += `*Interações Zé hoje:*\n`;
    intents.sort(([, a], [, b]) => b - a).slice(0, 5).forEach(([intent, count]) => {
      msg += `• ${intent}: ${count}x\n`;
    });
    msg += '\n';
  }

  msg += `📊 Dashboard: ${config.DASHBOARD_URL}`;
  return msg;
}

async function runWeekly() {
  console.log('[report] Gerando dashboard semanal');
  try {
    const hoje         = new Date(); hoje.setHours(0, 0, 0, 0);
    const inicioSemana = new Date(hoje.getTime() - 4 * 86400000);

    const [taskData, contextoVivo] = await Promise.all([
      sheets.get({ sheetName: SHEET_TASKS }),
      sheets.getContextoVivo().catch(() => ({}))
    ]);
    const tasks = taskData.tasks || [];

    let weekLog = [];
    try {
      const logData = await sheets.get({ sheetName: SHEET_LOG });
      const allLog  = logData.tasks || [];
      weekLog = allLog.filter(e => {
        const ts = new Date(e.timestamp || '');
        return !isNaN(ts) && ts >= inicioSemana;
      });
    } catch (_) {}

    const abertas   = tasks.filter(t => !STATUS_FECHADOS.some(s => (t.status || '').toLowerCase().includes(s)));
    const feitas    = tasks.filter(t => (t.status || '').toLowerCase().includes('feito') || (t.status || '').toLowerCase().includes('concluido'));
    const atrasadas = abertas.filter(t => { const d = parseDate(t.deadline); return d && d < hoje; });
    const travadas  = abertas.filter(t => (t.status || '').toLowerCase().includes('travado'));
    const andamento = abertas.filter(t => (t.status || '').toLowerCase().includes('andamento'));

    const byProject = {};
    tasks.forEach(t => {
      const proj = t.project || 'SEM PROJETO';
      if (!byProject[proj]) byProject[proj] = { total: 0, feitas: 0, abertas: 0, atrasadas: 0, travadas: 0 };
      byProject[proj].total++;
      const st = (t.status || '').toLowerCase();
      if (STATUS_FECHADOS.some(s => st.includes(s))) byProject[proj].feitas++;
      else {
        byProject[proj].abertas++;
        const d = parseDate(t.deadline);
        if (d && d < hoje) byProject[proj].atrasadas++;
        if (st.includes('travado')) byProject[proj].travadas++;
      }
    });

    const byPerson = {};
    tasks.forEach(t => {
      const people = (t.person || 'Sem Responsável').split(/[,e&]+/).map(p => p.trim()).filter(Boolean);
      for (const p of people) {
        if (!byPerson[p]) byPerson[p] = { feitas: 0, abertas: 0, atrasadas: 0 };
        const st = (t.status || '').toLowerCase();
        if (STATUS_FECHADOS.some(s => st.includes(s))) byPerson[p].feitas++;
        else {
          byPerson[p].abertas++;
          const d = parseDate(t.deadline);
          if (d && d < hoje) byPerson[p].atrasadas++;
        }
      }
    });

    const interacoesSemana = {};
    weekLog.forEach(e => {
      const p = e.extra1 || 'unknown';
      interacoesSemana[p] = (interacoesSemana[p] || 0) + 1;
    });

    const topPeople = Object.entries(byPerson)
      .filter(([, v]) => v.feitas > 0)
      .sort(([, a], [, b]) => b.feitas - a.feitas)
      .slice(0, 3);

    const slugMap = { MELANIE: 'mel', COMPORT: 'comport', FOCO: 'foco-vet', MAP: 'map', VH: 'vh', KING: 'king', ANMV: 'anmv', SIRIUS: 'sirius' };

    const semanaStr = `${inicioSemana.toLocaleDateString('pt-BR')} – ${hoje.toLocaleDateString('pt-BR')}`;
    let msg = `📊 *Dashboard Semanal — ${semanaStr}*\n_Gerado pelo Zé toda sexta às 8h_\n\n`;

    msg += `*📌 Visão Geral:*\n`;
    msg += `• ${tasks.length} tarefas | ${feitas.length} concluídas | ${andamento.length} em andamento\n`;
    if (atrasadas.length > 0) msg += `• ⚠️ *${atrasadas.length} em atraso*\n`;
    if (travadas.length > 0)  msg += `• 🔴 ${travadas.length} travada(s)\n`;
    if (weekLog.length > 0)   msg += `• 💬 ${weekLog.length} interações com Zé na semana\n`;
    msg += '\n';

    const projectEntries = Object.entries(byProject)
      .filter(([, v]) => v.total > 0)
      .sort(([, a], [, b]) => (b.feitas / b.total) - (a.feitas / a.total) || b.atrasadas - a.atrasadas)
      .slice(0, 6);

    if (projectEntries.length > 0) {
      msg += `*🗂 Progresso por Projeto:*\n`;
      projectEntries.forEach(([proj, st]) => {
        const pct    = Math.round(st.feitas / st.total * 100);
        const filled = Math.round(pct / 100 * 8);
        const bar    = '█'.repeat(filled) + '░'.repeat(8 - filled);
        const warn   = st.atrasadas > 0 ? ` ⚠️${st.atrasadas}at` : '';
        const trav   = st.travadas  > 0 ? ` 🔴${st.travadas}tr`  : '';
        const ctx    = contextoVivo[slugMap[proj.toUpperCase()] || proj.toLowerCase()];
        const ctxLinha = ctx?.contexto ? `\n  _${ctx.contexto.split('\n')[0].slice(0, 80)}_` : '';
        msg += `${bar} *${proj}* ${pct}%${warn}${trav}\n`;
        msg += `  _(${st.feitas}/${st.total} | ${st.abertas} aberta${st.abertas !== 1 ? 's' : ''})_${ctxLinha}\n`;
      });
      msg += '\n';
    }

    if (topPeople.length > 0) {
      msg += `*🏆 Mais produtivo(s):*\n`;
      topPeople.forEach(([p, st], i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        msg += `${medal} *${p}*: ${st.feitas} entrega(s)\n`;
      });
      msg += '\n';
    }

    const personEntries = Object.entries(byPerson).sort(([, a], [, b]) => b.atrasadas - a.atrasadas || b.abertas - a.abertas);
    if (personEntries.length > 0) {
      msg += `*👥 Situação do Time:*\n`;
      personEntries.forEach(([p, st]) => {
        const parts = [`${st.abertas} aberta(s)`];
        if (st.feitas > 0)    parts.unshift(`✅ ${st.feitas}`);
        if (st.atrasadas > 0) parts.push(`⚠️ ${st.atrasadas}`);
        const ints = interacoesSemana[p];
        if (ints)             parts.push(`💬 ${ints}x`);
        msg += `• *${p}*: ${parts.join(' | ')}\n`;
      });
      msg += '\n';
    }

    const topAtrasadas = atrasadas.slice(0, 3);
    if (topAtrasadas.length > 0) {
      msg += `*⚠️ Top Atrasos:*\n`;
      topAtrasadas.forEach(t => {
        msg += `• [${t.project}] ${t.task} → ${t.person || 'sem resp.'} (${t.deadline})\n`;
      });
      msg += '\n';
    }

    msg += `📊 Dashboard: ${config.DASHBOARD_URL}`;

    await sendToManagers(msg);

    sheets.post({
      sheetName: SHEET_LOG,
      values: [new Date().toISOString(), 'system', 'weekly_report',
        `${tasks.length} tarefas | ${feitas.length} feitas | ${atrasadas.length} atrasadas`,
        '', '', 'Thiago', '', '']
    }).catch(() => {});

    console.log('[report] Dashboard semanal enviado');
  } catch (err) {
    console.error('[report] Erro no dashboard semanal:', err.message);
    evolution.sendText(config.ADMIN_PHONE,
      `⚠️ *Dashboard Semanal — Erro*\n\nErro: ${err.message}\n\n📊 ${config.DASHBOARD_URL}`
    ).catch(() => {});
  }
}

module.exports = { run, runWeekly };
