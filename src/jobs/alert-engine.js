// Briefings informativos — Zé é puramente informativo.
// Manhã (8h): resumo personalizado por pessoa com link.
// Tarde (16h): atrasadas + vencem hoje/amanhã, sem cobrar resposta.
// Sem nag, sem cobrança, sem watchdog de travadas.
'use strict';

const sheets    = require('../clients/sheets');
const evolution = require('../clients/evolution');
const config    = require('../config');

const SHEET_TASKS     = 'BACKEND DASH ';
const STATUS_FECHADOS = ['feito', 'concluido', 'cancelado'];

const SLUG_TO_PROJECT = {
  mel: 'MELANIE', comport: 'COMPORT', 'foco-vet': 'FOCO', focovet: 'FOCO',
  map: 'MAP', vh: 'VH', king: 'KING', anmv: 'ANMV', sirius: 'SIRIUS',
  naves: 'NAVES', 'lt-pneus': 'LT-PNEUS',
};
const PROJECT_TO_SLUG = Object.fromEntries(
  Object.entries(SLUG_TO_PROJECT).map(([k, v]) => [v, k])
);

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

function prioOrder(t) {
  const p = (t.priority || '').toLowerCase();
  if (p === 'alta')  return 0;
  if (p === 'media') return 1;
  if (p === 'baixa') return 2;
  return 3;
}

// ─────────────────────────────────────────────────────────────
// BRIEFING MATINAL — 8h BRT
// Mensagem pessoal informativa: o que está em atraso, vence hoje, vence amanhã,
// está travado/estagnado. Sem cobrar resposta. Link pro painel no final.
// ─────────────────────────────────────────────────────────────

async function runMorning() {
  console.log('[alert-engine] Briefing matinal 8h BRT');
  try {
    const [taskData, contextoVivo] = await Promise.all([
      sheets.get({ sheetName: SHEET_TASKS }),
      sheets.getContextoVivo().catch(() => ({}))
    ]);
    const tasks = taskData.tasks || [];

    const hoje    = new Date(); hoje.setHours(0, 0, 0, 0);
    const amanha  = new Date(hoje.getTime() + 86400000);
    const em7d    = new Date(hoje.getTime() + 7 * 86400000);

    const abertas = tasks.filter(t => {
      const st = (t.status || '').toLowerCase();
      return t.person && !STATUS_FECHADOS.some(s => st.includes(s));
    });

    for (const [personName, phone] of Object.entries(config.TEAM_PHONES)) {
      if (!phone) continue;
      if (personName.includes('á') || personName.includes('ã') || personName.includes('õ')) continue;

      const minhas = abertas.filter(t =>
        (t.person || '').split(/[,e&]+/).map(p => p.trim()).includes(personName)
      );
      if (minhas.length === 0) continue;

      const sortByPrio = arr => arr.slice().sort((a, b) => prioOrder(a) - prioOrder(b));

      const overdue     = sortByPrio(minhas.filter(t => { const d = parseDate(t.deadline); return d && d < hoje; }));
      const venteHoje   = sortByPrio(minhas.filter(t => { const d = parseDate(t.deadline); return d && d.getTime() === hoje.getTime(); }));
      const amanhaTasks = sortByPrio(minhas.filter(t => { const d = parseDate(t.deadline); return d && d.getTime() === amanha.getTime(); }));
      const semana      = sortByPrio(minhas.filter(t => { const d = parseDate(t.deadline); return d && d > amanha && d <= em7d; }));
      const travadas    = sortByPrio(minhas.filter(t => (t.status || '').toLowerCase().includes('travado')));

      let msg = `🌅 *Bom dia, ${personName}!*\n\n`;

      const fmtTask = (t, showDeadline = false) => {
        const prio  = t.priority === 'alta' ? '🔴 ' : t.priority === 'media' ? '🟡 ' : '';
        const prazo = showDeadline && t.deadline ? ` (${t.deadline})` : '';
        let line = `  • ${prio}[${t.project}] ${t.task}${prazo}\n`;
        if (t.nextAction) line += `     ⚡ _${t.nextAction}_\n`;
        line += `     🔗 ${config.taskLink(t)}\n`;
        const slug = PROJECT_TO_SLUG[(t.project || '').toUpperCase()] || (t.project || '').toLowerCase();
        const ctx  = contextoVivo[slug];
        if (ctx && ctx.contexto) {
          const resumo = ctx.contexto.split('\n')[0].slice(0, 100);
          line += `     _↳ ${resumo}_\n`;
        }
        return line;
      };

      if (overdue.length > 0) {
        msg += `⚠️ *${overdue.length} em atraso:*\n`;
        overdue.slice(0, 3).forEach(t => { msg += fmtTask(t, true); });
        if (overdue.length > 3) msg += `  ... e mais ${overdue.length - 3}\n`;
        msg += '\n';
      }

      if (venteHoje.length > 0) {
        msg += `🔴 *${venteHoje.length} vencem HOJE:*\n`;
        venteHoje.forEach(t => { msg += fmtTask(t); });
        msg += '\n';
      }

      if (amanhaTasks.length > 0) {
        msg += `🟡 *Vencem amanhã (${amanhaTasks.length}):*\n`;
        amanhaTasks.forEach(t => { msg += fmtTask(t); });
        msg += '\n';
      }

      if (travadas.length > 0) {
        msg += `🔴 *${travadas.length} travada(s):*\n`;
        travadas.forEach(t => {
          msg += `  • [${t.project}] ${t.task}\n`;
          if (t.blocker) msg += `     🚧 ${t.blocker}\n`;
          msg += `     🔗 ${config.taskLink(t)}\n`;
        });
        msg += '\n';
      }

      if (semana.length > 0) {
        msg += `📅 *Esta semana (${semana.length}):*\n`;
        semana.slice(0, 4).forEach(t => { msg += fmtTask(t, true); });
        msg += '\n';
      }

      msg += `📊 ${config.DASHBOARD_URL}`;

      await evolution.sendText(phone, msg);
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error('[alert-engine] Erro no briefing matinal:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ALERTA VESPERTINO — 16h BRT
// Lista em atraso / vence hoje / vence amanhã. Sem cobrar resposta.
// ─────────────────────────────────────────────────────────────

async function runAfternoon() {
  console.log('[alert-engine] Alerta 16h BRT');
  try {
    const data  = await sheets.get({ sheetName: SHEET_TASKS });
    const tasks = data.tasks || [];

    const hoje   = new Date(); hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje.getTime() + 86400000);

    const abertas = tasks.filter(t => {
      const st = (t.status || '').toLowerCase();
      return t.person && t.deadline && !STATUS_FECHADOS.some(s => st.includes(s));
    });

    const porPessoa = {};
    abertas.forEach(t => {
      const prazo = parseDate(t.deadline);
      if (!prazo) return;
      const people = (t.person || '').split(/[,e&]+/).map(p => p.trim()).filter(Boolean);
      for (const p of people) {
        if (!porPessoa[p]) porPessoa[p] = { overdue: [], today: [], tomorrow: [] };
        if (prazo < hoje)                              porPessoa[p].overdue.push(t);
        else if (prazo.getTime() === hoje.getTime())   porPessoa[p].today.push(t);
        else if (prazo.getTime() === amanha.getTime()) porPessoa[p].tomorrow.push(t);
      }
    });

    for (const [person, groups] of Object.entries(porPessoa)) {
      const phone = config.TEAM_PHONES[person];
      if (!phone) continue;

      const sortByPrio = arr => arr.slice().sort((a, b) => prioOrder(a) - prioOrder(b));
      const fmtTask = t => {
        const prio = t.priority === 'alta' ? '🔴 ' : t.priority === 'media' ? '🟡 ' : '';
        let s = `  • ${prio}*${t.project}* — ${t.task}\n`;
        if (t.nextAction) s += `     ⚡ _${t.nextAction}_\n`;
        s += `     🔗 ${config.taskLink(t)}`;
        return s;
      };

      const parts = [];
      if (groups.overdue.length > 0)
        parts.push(`⚠️ *${groups.overdue.length} em atraso:*\n` + sortByPrio(groups.overdue).map(fmtTask).join('\n'));
      if (groups.today.length > 0)
        parts.push(`🔴 *${groups.today.length} vencem HOJE:*\n` + sortByPrio(groups.today).map(fmtTask).join('\n'));
      if (groups.tomorrow.length > 0)
        parts.push(`🟡 *${groups.tomorrow.length} vencem amanhã:*\n` + sortByPrio(groups.tomorrow).map(fmtTask).join('\n'));

      if (parts.length === 0) continue;

      const msg = `Oi ${person}!\n\n${parts.join('\n\n')}\n\n📊 ${config.DASHBOARD_URL}`;
      await evolution.sendText(phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[alert-engine] Erro no alerta vespertino:', err.message);
  }
}

module.exports = {
  runMorning,
  runAfternoon
};
