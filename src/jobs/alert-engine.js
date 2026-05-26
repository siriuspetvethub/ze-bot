// Motor de alertas — ZE-ALERT-ENGINE v3.1
// Mudanças v3:
//  - Bugs corrigidos: ZE_REMINDERS agora lê/escreve corretamente (schema + entries[])
//  - Contexto vivo integrado no briefing individual (como a tarefa afeta o projeto)
//  - Briefing ordena por prioridade: alta → media → baixa → sem prioridade
//  - Inatividade notifica o dono do projeto (via responsaveis.dono) e os managers
//  - Nag cobra a próxima ação específica da tarefa, não só o nome
//  - Tarefas estagnadas (in-progress >5d sem update) detectadas
//  - Tarefas sem responsável alertam managers
//  - Watchdog força feedback: re-cobra depois de 24h se não recebeu resposta
//  - Todos os alertas de gestão vão para MANAGERS (Thiago + Chardson)
//  - Removido: check-in 10h
// Mudanças v3.1:
//  - S5: runMondayContextoReminder — toda segunda 9h lembra donos de revisar contexto vivo
//  - S7: checkStalledApprovals — tarefas em aprovação >2d sem update cobram responsável
'use strict';

const sheets    = require('../clients/sheets');
const evolution = require('../clients/evolution');
const config    = require('../config');
const { frame } = require('../formatters/sirius-frame');

const SHEET_TASKS     = 'BACKEND DASH ';
const SHEET_REMINDERS = 'ZE_REMINDERS';
const STATUS_FECHADOS = ['feito', 'concluido', 'cancelado'];
const MAX_NAGS        = 6;
const NAG_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h entre nags da mesma tarefa
const STUCK_DAYS      = 2;
const INACTIVE_DAYS   = 3;
const STAGNANT_DAYS   = 5; // in-progress sem atualização por N dias = estagnada
const APPROVAL_DAYS   = 2; // em aprovação sem update por N dias = estagnada

// Cache em memória para deduplicar nags quando o Sheets falha ao salvar last_reminder_at
// Garante que a mesma mensagem não seja enviada duas vezes em menos de NAG_CACHE_TTL
const nagSentCache = new Map(); // 'phone:taskId' → timestamp
const NAG_CACHE_TTL = 2 * 60 * 60 * 1000; // 2h — alinhado com NAG_MIN_INTERVAL_MS

// Mapeamento slug → projeto (e inverso) para cruzar contexto vivo com tarefas
const SLUG_TO_PROJECT = {
  mel:          'MELANIE',
  comport:      'COMPORT',
  'foco-vet':   'FOCO',
  focovet:      'FOCO',
  map:          'MAP',
  vh:           'VH',
  king:         'KING',
  anmv:         'ANMV',
  sirius:       'SIRIUS',
  naves:        'NAVES',
  'lt-pneus':   'LT-PNEUS',
};
const PROJECT_TO_SLUG = Object.fromEntries(
  Object.entries(SLUG_TO_PROJECT).map(([k, v]) => [v, k])
);

/**
 * Parseia data no formato brasileiro ou ISO (YYYY-MM-DD)
 * CRÍTICO: verificar ISO antes do regex BR para evitar falsos atrasos
 */
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

/** Prioridade numérica (menor = mais urgente) para ordenação */
function prioOrder(t) {
  const p = (t.priority || '').toLowerCase();
  if (p === 'alta')  return 0;
  if (p === 'media') return 1;
  if (p === 'baixa') return 2;
  return 3;
}

/** Envia mensagem para todos os managers (Thiago + Chardson) */
async function sendToManagers(text) {
  for (const phone of config.MANAGERS) {
    await evolution.sendText(phone, text).catch(e =>
      console.warn(`[alert-engine] Falha ao enviar para manager ${phone}:`, e.message)
    );
    await new Promise(r => setTimeout(r, 800));
  }
}

/**
 * Constrói chave normalizada (project|task_name) para casar reminders ⇄ tarefas
 * Tira espaços nas pontas e case. Usado para detectar cobranças stale.
 */
function taskKey(project, taskName) {
  return `${(project || '').trim().toLowerCase()}|${(taskName || '').trim().toLowerCase()}`;
}

/** Set com as chaves de todas as tarefas FECHADAS (feito/concluido/cancelado) */
function buildClosedTaskKeySet(tasks) {
  const closed = new Set();
  for (const t of tasks) {
    const st = (t.status || '').toLowerCase();
    if (STATUS_FECHADOS.some(s => st.includes(s))) {
      closed.add(taskKey(t.project, t.task));
    }
  }
  return closed;
}

/**
 * Marca um reminder como resolvido (sem mensagem nem nag).
 * Usado quando descobrimos que a tarefa já foi fechada no painel.
 */
async function autoResolveReminder(reminder, reason) {
  if (!reminder._row) return;
  await sheets.patch({
    sheetName: SHEET_REMINDERS,
    row: reminder._row,
    updates: [
      { col: 'resolved',         value: 'true' },
      { col: 'last_reminder_at', value: new Date().toISOString() }
    ]
  }).catch(e => console.warn(`[alert-engine] Falha ao auto-resolver reminder (${reason}):`, e.message));
}

/** Verifica se tarefa está in-progress mas sem atualização há >STAGNANT_DAYS dias */
function isStagnant(t, hoje) {
  const st = (t.status || '').toLowerCase();
  if (!st.includes('andamento')) return false;
  const lastUpdate = parseDate(t.updatedAt || t.createdAt);
  if (!lastUpdate) return false;
  return (hoje - lastUpdate) > STAGNANT_DAYS * 86400000;
}

// ─────────────────────────────────────────────────────────────
// ALERTA MATINAL — 8h BRT
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
      // Evitar duplicatas para aliases com acentos (Álvaro / João)
      if (personName.includes('á') || personName.includes('ã') || personName.includes('õ')) continue;

      // Suporte a múltiplos responsáveis ("Thiago e Álvaro" ou "Thiago, Paula")
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
      const stagnadas   = sortByPrio(minhas.filter(t => isStagnant(t, hoje)));

      let body = `🌅 *Bom dia, ${personName}.*\n\n`;

      const fmtTask = (t, showDeadline = false) => {
        const prio  = t.priority === 'alta' ? '🔴 ' : t.priority === 'media' ? '🟡 ' : '';
        const prazo = showDeadline && t.deadline ? ` (${t.deadline})` : '';
        let line = `  • ${prio}[${t.project}] ${t.task}${prazo}\n`;
        if (t.nextAction) line += `     ⚡ _${t.nextAction}_\n`;
        line += `     🔗 ${config.taskLink(t)}\n`;
        // Linha de contexto: como esta tarefa afeta o projeto
        const slug = PROJECT_TO_SLUG[(t.project || '').toUpperCase()] || (t.project || '').toLowerCase();
        const ctx  = contextoVivo[slug];
        if (ctx && ctx.contexto) {
          const resumo = ctx.contexto.split('\n')[0].slice(0, 100);
          line += `     _↳ ${resumo}_\n`;
        }
        return line;
      };

      if (overdue.length > 0) {
        body += `⚠️ *${overdue.length} em atraso:*\n`;
        overdue.slice(0, 3).forEach(t => { body += fmtTask(t, true); });
        if (overdue.length > 3) body += `  ... e mais ${overdue.length - 3}\n`;
        body += '\n';
      }

      if (venteHoje.length > 0) {
        body += `🔴 *${venteHoje.length} vencem HOJE:*\n`;
        venteHoje.forEach(t => { body += fmtTask(t); });
        body += '\n';
      }

      if (amanhaTasks.length > 0) {
        body += `🟡 *Vencem amanhã (${amanhaTasks.length}):*\n`;
        amanhaTasks.forEach(t => { body += fmtTask(t); });
        body += '\n';
      }

      if (travadas.length > 0) {
        body += `🔴 *${travadas.length} travada(s):*\n`;
        travadas.forEach(t => {
          body += `  • [${t.project}] ${t.task}\n`;
          if (t.blocker) body += `     🚧 ${t.blocker}\n`;
          body += `     🔗 ${config.taskLink(t)}\n`;
        });
        body += '\n';
      }

      if (stagnadas.length > 0) {
        body += `😴 *${stagnadas.length} estagnada(s) (em andamento >5 dias sem update):*\n`;
        stagnadas.slice(0, 2).forEach(t => {
          body += `  • [${t.project}] ${t.task}\n`;
          if (t.nextAction) body += `     ⚡ _${t.nextAction}_\n`;
          body += `     🔗 ${config.taskLink(t)}\n`;
        });
        body += '\n';
      }

      if (semana.length > 0) {
        body += `📅 *Esta semana (${semana.length}):*\n`;
        semana.slice(0, 4).forEach(t => { body += fmtTask(t, true); });
        body += '\n';
      }

      const msg = frame({
        contextLabel: 'Alerta matinal · 08h',
        body: body.trimEnd(),
        linkLabel: 'painel operacional',
        link: config.DASHBOARD_URL,
      });

      await evolution.sendText(phone, msg);
      await new Promise(r => setTimeout(r, 1500));
    }

    // Verificações de gestão
    await checkProjectInactivity(tasks, hoje, contextoVivo);
    await checkNoOwnerTasks(tasks);
    await checkStalledApprovals(tasks);

  } catch (err) {
    console.error('[alert-engine] Erro no briefing matinal:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// WATCHDOG CONTEXTO VIVO — 17h BRT
// Envia snapshot dos projetos para o grupo + cobra donos que não atualizaram hoje
// ─────────────────────────────────────────────────────────────

async function runContextoVivoBriefing() {
  console.log('[alert-engine] Contexto vivo 17h BRT');
  try {
    const contextoVivo = await sheets.getContextoVivo().catch(() => ({}));
    const slugs = Object.keys(contextoVivo);
    if (slugs.length === 0) return;

    const hoje    = new Date();
    const hojeDD  = hoje.toLocaleDateString('pt-BR').slice(0, 5); // "DD/MM"
    const naoAtualizados = [];

    let grupoMsg = `📋 *Contexto Vivo — ${hoje.toLocaleDateString('pt-BR')}*\n\n`;

    for (const slug of slugs) {
      const ctx = contextoVivo[slug];
      if (!ctx || !ctx.cliente) continue;

      const statusEmoji = {
        ativo: '🟢', pausa: '⏸️', atencao: '🟡',
        critico: '🔴', onboarding: '🔵', negociacao: '🟠'
      }[ctx.status] || '⚪';

      const foiHoje = (ctx.atualizado_em || '').includes(hojeDD);

      grupoMsg += `${statusEmoji} *${ctx.cliente}*`;
      if (!foiHoje) {
        grupoMsg += ` _(atualizado: ${ctx.data_reuniao || '?'})_`;
        naoAtualizados.push({ slug, cliente: ctx.cliente, donoNome: ctx.responsaveis?.dono || '' });
      }
      grupoMsg += '\n';
      if (ctx.contexto)
        grupoMsg += `  _${ctx.contexto.split('\n')[0].slice(0, 120)}_\n`;
      if (ctx.proximas_acoes && ctx.proximas_acoes.length > 0)
        grupoMsg += `  ⚡ ${ctx.proximas_acoes[0]}\n`;
      if (ctx.blockers && ctx.blockers.length > 0)
        grupoMsg += `  🚧 ${ctx.blockers[0]}\n`;
      grupoMsg += '\n';
    }

    grupoMsg += `📊 ${config.DASHBOARD_URL}`;

    const groupId = config.ADMIN_GROUP_ID.replace('@g.us', '');
    await evolution.sendText(groupId, grupoMsg).catch(e =>
      console.warn('[alert-engine] Falha ao enviar ao grupo:', e.message)
    );

    // Snapshot 17h é só visibilidade pro grupo — a cobrança individual fica
    // pro job das 18h (seg-qui) / 12h (sex), que pede atualização via WhatsApp.

  } catch (err) {
    console.error('[alert-engine] Erro no contexto vivo 17h:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// ALERTA VESPERTINO — 16h BRT
// ─────────────────────────────────────────────────────────────

async function runAfternoon() {
  console.log('[alert-engine] Alerta 16h BRT');
  await runAlerts(['overdue', 'today']);
}

// ─────────────────────────────────────────────────────────────
// NAG CHECK — cada 5min (9h-18h BRT)
// ─────────────────────────────────────────────────────────────

async function runNagCheck() {
  try {
    // Carrega tarefas e reminders em paralelo. O cross-check com tarefas evita
    // cobrar reminder de tarefa que já foi marcada como feito/concluído no painel.
    const [reminderData, taskData] = await Promise.all([
      sheets.get({ sheetName: SHEET_REMINDERS }),
      sheets.get({ sheetName: SHEET_TASKS }).catch(() => ({ tasks: [] }))
    ]);

    const reminders = (reminderData.tasks || []).filter(r =>
      r.resolved !== 'true' && r.escalated !== 'true' &&
      !String(r.task_id || '').startsWith('stuck:')
    );

    if (reminders.length === 0) return;

    // Filtra reminders cuja tarefa subjacente já está fechada — auto-resolve sem cobrar.
    const closed = buildClosedTaskKeySet(taskData.tasks || []);
    const stillOpen = [];
    for (const r of reminders) {
      if (closed.has(taskKey(r.project, r.task_name))) {
        await autoResolveReminder(r, 'nag/task-already-closed');
      } else {
        stillOpen.push(r);
      }
    }

    if (stillOpen.length === 0) return;

    const now = Date.now();
    const toNag      = [];
    const toEscalate = [];

    stillOpen.forEach(r => {
      const lastSent = new Date(r.last_reminder_at).getTime();
      if (isNaN(lastSent) || (now - lastSent) < NAG_MIN_INTERVAL_MS) return;
      const count = parseInt(r.reminder_count || '0');
      if (count >= MAX_NAGS) toEscalate.push(r);
      else toNag.push(r);
    });

    // Agrupar nags por pessoa
    const nagByPerson = {};
    toNag.forEach(r => {
      if (!nagByPerson[r.person]) nagByPerson[r.person] = { phone: r.phone, tasks: [] };
      nagByPerson[r.person].tasks.push(r);
    });

    for (const [person, info] of Object.entries(nagByPerson)) {
      // Deduplicar via cache em memória: ignorar se já enviado há menos de NAG_CACHE_TTL
      const firstTaskId = info.tasks[0]?.task_id || '';
      const cacheKey = `${info.phone}:${firstTaskId}`;
      const lastCachedSend = nagSentCache.get(cacheKey) || 0;
      if (now - lastCachedSend < NAG_CACHE_TTL) continue;
      nagSentCache.set(cacheKey, now);

      const count = parseInt(info.tasks[0].reminder_count || '1');
      let tone;
      if (count <= 2) tone = `${person}, só passando pra lembrar:`;
      else if (count <= 4) tone = `${person}, essas tarefas continuam pendentes:`;
      else tone = `${person}, última vez antes de avisar a gestão:`;

      // Cobrar a próxima ação específica quando disponível
      const lista = info.tasks.map(t => {
        let line = `  • *${t.project}* — ${t.task_name}`;
        if (t.nextAction) line += `\n     ⚡ _${t.nextAction}_`;
        return line;
      }).join('\n');

      const msg = `${tone}\n\n${lista}\n\nResponde aqui se já fez alguma.`;
      await evolution.sendText(info.phone, msg);

      for (const r of info.tasks) {
        if (r._row) {
          await sheets.patch({
            sheetName: SHEET_REMINDERS,
            row: r._row,
            updates: [
              { col: 'reminder_count',    value: String(count + 1) },
              { col: 'last_reminder_at', value: new Date().toISOString() }
            ]
          }).catch(e => console.warn('[nag] Falha ao atualizar reminder:', e.message));
        }
      }
    }

    // Escalações para managers desativadas — marcar como escalated sem notificar
    if (toEscalate.length > 0) {
      for (const r of toEscalate) {
        if (r._row) {
          await sheets.patch({
            sheetName: SHEET_REMINDERS,
            row: r._row,
            updates: [
              { col: 'escalated',        value: 'true' },
              { col: 'last_reminder_at', value: new Date().toISOString() }
            ]
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[alert-engine] Erro no nag check:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// WATCHDOG TAREFAS TRAVADAS — 8h15 BRT
// Cobra responsável + força feedback + re-cobra após 24h sem resposta
// ─────────────────────────────────────────────────────────────

async function runStuckWatchdog() {
  console.log('[alert-engine] Watchdog tarefas travadas');
  try {
    const [taskData, reminderData] = await Promise.all([
      sheets.get({ sheetName: SHEET_TASKS }),
      sheets.get({ sheetName: SHEET_REMINDERS })
    ]);

    const tasks     = taskData.tasks     || [];
    const reminders = reminderData.tasks || [];

    const existing = new Set(
      reminders
        .filter(r => String(r.task_id || '').startsWith('stuck:') && r.resolved !== 'true')
        .map(r => r.task_id)
    );

    // Set de tarefas fechadas — usado pra auto-resolver reminders stale
    const closed = buildClosedTaskKeySet(tasks);

    // Re-cobrar stuck reminders ativos que passaram 24h sem resposta
    const reStuck = reminders.filter(r =>
      String(r.task_id || '').startsWith('stuck:') &&
      r.resolved !== 'true' && r.escalated !== 'true' &&
      (() => {
        const last = new Date(r.last_reminder_at).getTime();
        return !isNaN(last) && (Date.now() - last) > 24 * 60 * 60 * 1000;
      })()
    );

    for (const r of reStuck) {
      // Tarefa já foi resolvida no painel — silencia sem cobrar
      if (closed.has(taskKey(r.project, r.task_name))) {
        await autoResolveReminder(r, 'stuck/task-already-closed');
        continue;
      }

      const phone = config.TEAM_PHONES[r.person];
      if (!phone) continue;
      const count = parseInt(r.reminder_count || '1') + 1;
      const msg = count <= 2
        ? `🔴 *${r.person}*, ainda não recebi resposta sobre a tarefa travada:\n\n*[${r.project}]* ${r.task_name}\n\nO bloqueio foi resolvido? Me responde _sim_ ou explica o que está impedindo.`
        : `🚨 *${r.person}*, ${count}ª tentativa. Tarefa travada sem resposta:\n\n*[${r.project}]* ${r.task_name}\n\nVou acionar a gestão agora se não receber retorno.`;

      await evolution.sendText(phone, msg);
      if (r._row) {
        await sheets.patch({
          sheetName: SHEET_REMINDERS, row: r._row,
          updates: [
            { col: 'reminder_count',    value: String(count) },
            { col: 'last_reminder_at', value: new Date().toISOString() }
          ]
        }).catch(() => {});
      }
      if (count >= 3) {
        await sendToManagers(`🚨 *${r.person}* não responde sobre travada *[${r.project}]* ${r.task_name} — ${count}ª tentativa.`);
        if (r._row) {
          await sheets.patch({
            sheetName: SHEET_REMINDERS, row: r._row,
            updates: [{ col: 'escalated', value: 'true' }]
          }).catch(() => {});
        }
      }
      await new Promise(r => setTimeout(r, 1500));
    }

    // Novas tarefas travadas — primeiro contato
    const travadas = tasks.filter(t =>
      (t.status || '').toLowerCase().includes('travado') && t.person
    );

    for (const t of travadas) {
      const taskId = `stuck:${t.project}-${t.task}`.slice(0, 50);
      if (existing.has(taskId)) continue;

      const phone = config.TEAM_PHONES[t.person];
      if (!phone) continue;

      const msg = `🔴 *${t.person}*, a tarefa abaixo está marcada como _travada_:\n\n*[${t.project}]* ${t.task}\n${t.blocker ? `🚧 ${t.blocker}\n` : ''}🔗 ${config.taskLink(t)}\n\nO bloqueio foi resolvido? Me responde *sim* ou explica o que está impedindo — eu atualizo o status.`;
      await evolution.sendText(phone, msg);

      await sheets.post({
        sheetName: SHEET_REMINDERS,
        data: {
          task_id:          taskId,
          person:           t.person,
          phone,
          project:          t.project,
          task_name:        t.task,
          last_reminder_at: new Date().toISOString(),
          reminder_count:   '1',
          escalated:        'false',
          resolved:         'false'
        }
      }).catch(e => console.warn('[watchdog] Falha ao criar reminder:', e.message));

      // Cópia para managers (exceto se o próprio é manager)
      if (!config.MANAGERS.includes(phone)) {
        await sendToManagers(`ℹ️ Cobrei *${t.person}* sobre tarefa travada: _[${t.project}] ${t.task}_`);
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error('[alert-engine] Erro no stuck watchdog:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// INATIVIDADE DE PROJETO — junto com briefing matinal
// Notifica dono do projeto (responsaveis.dono) + managers
// ─────────────────────────────────────────────────────────────

async function checkProjectInactivity(tasks, hoje, contextoVivo) {
  try {
    const projetosComAberta = {};
    tasks.forEach(t => {
      if (!t.project) return;
      const st = (t.status || '').toLowerCase();
      if (STATUS_FECHADOS.some(s => st.includes(s))) return;
      if (!projetosComAberta[t.project]) projetosComAberta[t.project] = { tasks: [], total: 0 };
      projetosComAberta[t.project].tasks.push(t);
      projetosComAberta[t.project].total++;
    });

    const projetosAtivos = new Set(
      tasks
        .filter(t => (t.status || '').toLowerCase().includes('andamento'))
        .map(t => t.project)
    );

    const inativos = Object.entries(projetosComAberta).filter(([proj, info]) => {
      if (projetosAtivos.has(proj)) return false;
      return info.tasks.some(t => {
        const d = parseDate(t.deadline);
        return d && d <= new Date(hoje.getTime() + 14 * 86400000);
      });
    });

    if (inativos.length === 0) return;

    for (const [proj, info] of inativos) {
      const slug     = PROJECT_TO_SLUG[proj.toUpperCase()] || proj.toLowerCase();
      const ctx      = contextoVivo[slug] || {};
      const donoNome = ctx.responsaveis?.dono || '';
      const donoPhone = config.TEAM_PHONES[donoNome];

      if (donoPhone && !config.MANAGERS.includes(donoPhone)) {
        const msg = `📊 *${donoNome}*, o projeto *${proj}* está sem atividade há ${INACTIVE_DAYS}+ dias com ${info.total} tarefa(s) aberta(s).\n\nJá conversou com a equipe sobre o andamento? Me responde aqui.\n\n📊 ${config.DASHBOARD_URL}`;
        await evolution.sendText(donoPhone, msg).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    let msg = `📊 *Projetos sem atividade há ${INACTIVE_DAYS}+ dias:*\n\n`;
    inativos.forEach(([proj, info]) => {
      const slug = PROJECT_TO_SLUG[proj.toUpperCase()] || proj.toLowerCase();
      const ctx  = contextoVivo[slug] || {};
      const dono = ctx.responsaveis?.dono ? ` (resp: ${ctx.responsaveis.dono})` : '';
      msg += `• *${proj}*${dono} — ${info.total} tarefa(s) aberta(s)\n`;
    });
    msg += `\nJá notifiquei os donos dos projetos.`;
    await sendToManagers(msg);

  } catch (err) {
    console.warn('[alert-engine] Erro ao checar inatividade:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// TAREFAS SEM RESPONSÁVEL — alerta managers (junto com briefing matinal)
// ─────────────────────────────────────────────────────────────

async function checkNoOwnerTasks(tasks) {
  try {
    const semDono = tasks.filter(t => {
      const st = (t.status || '').toLowerCase();
      if (STATUS_FECHADOS.some(s => st.includes(s))) return false;
      return !t.person || t.person.trim() === '';
    });

    if (semDono.length === 0) return;

    const grupos = {};
    semDono.forEach(t => { grupos[t.project] = (grupos[t.project] || 0) + 1; });

    let msg = `⚠️ *${semDono.length} tarefa(s) sem responsável:*\n\n`;
    Object.entries(grupos).forEach(([proj, count]) => { msg += `• *${proj}*: ${count}\n`; });
    msg += `\n📊 ${config.DASHBOARD_URL}`;

    await sendToManagers(msg);
  } catch (err) {
    console.warn('[alert-engine] Erro ao checar tarefas sem dono:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// FUNÇÃO INTERNA: runAlerts (alerta vespertino 16h)
// ─────────────────────────────────────────────────────────────

async function runAlerts(types) {
  try {
    const data  = await sheets.get({ sheetName: SHEET_TASKS });
    const tasks = data.tasks || [];

    const hoje   = new Date(); hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje.getTime() + 86400000);

    let existingTaskIds = new Set();
    try {
      const remData = await sheets.get({ sheetName: SHEET_REMINDERS });
      existingTaskIds = new Set(
        (remData.tasks || []).filter(r => r.resolved !== 'true').map(r => r.task_id)
      );
    } catch (_) {}

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
      if (types.includes('overdue') && groups.overdue.length > 0)
        parts.push(`⚠️ *${groups.overdue.length} em atraso:*\n` + sortByPrio(groups.overdue).map(fmtTask).join('\n'));
      if (types.includes('today') && groups.today.length > 0)
        parts.push(`🔴 *${groups.today.length} vencem HOJE:*\n` + sortByPrio(groups.today).map(fmtTask).join('\n'));
      if (types.includes('tomorrow') && groups.tomorrow.length > 0)
        parts.push(`🟡 *${groups.tomorrow.length} vencem amanhã:*\n` + sortByPrio(groups.tomorrow).map(fmtTask).join('\n'));

      if (parts.length === 0) continue;

      const msg = `Oi ${person}!\n\n${parts.join('\n\n')}\n\nAlguma já foi? Me responde que eu atualizo. 📊 ${config.DASHBOARD_URL}`;
      await evolution.sendText(phone, msg);

      for (const t of groups.overdue) {
        const taskId = `overdue:${t.project}-${t.task}`.slice(0, 50);
        if (existingTaskIds.has(taskId)) continue;
        sheets.post({
          sheetName: SHEET_REMINDERS,
          data: {
            task_id:          taskId,
            person,
            phone,
            project:          t.project,
            task_name:        t.task,
            last_reminder_at: new Date().toISOString(),
            reminder_count:   '1',
            escalated:        'false',
            resolved:         'false'
          }
        }).catch(e => console.warn('[alert-engine] Erro ao registrar reminder:', e.message));
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[alert-engine] Erro nos alertas:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// S5 — LEMBRETE SEGUNDA 9h: REVISAR CONTEXTO VIVO
// Toda segunda, lembra cada dono de projeto para revisar o contexto vivo.
// Envia resumo do estado atual para os managers.
// ─────────────────────────────────────────────────────────────

async function runMondayContextoReminder() {
  console.log('[alert-engine] Lembrete segunda 9h — revisar contexto vivo');
  try {
    const contextoVivo = await sheets.getContextoVivo().catch(() => ({}));
    const slugs = Object.keys(contextoVivo);
    if (slugs.length === 0) return;

    const hoje   = new Date();
    const semana = hoje.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

    const notificados = [];

    for (const slug of slugs) {
      const ctx = contextoVivo[slug];
      if (!ctx || !ctx.cliente) continue;

      const donoNome  = ctx.responsaveis?.dono || '';
      const donoPhone = config.TEAM_PHONES[donoNome];
      if (!donoPhone) continue;

      const ultimaAtu = ctx.atualizado_em || ctx.data_reuniao || 'não registrado';
      const msg = `🗓️ *Bom dia, ${donoNome}!* Segunda-feira — hora da revisão semanal.\n\n` +
        `Projeto: *${ctx.cliente}*\n` +
        `Última atualização do contexto: _${ultimaAtu}_\n\n` +
        `Por favor, acessa o dashboard e atualiza:\n` +
        `  • O que está rolando agora\n` +
        `  • Próximas ações da semana\n` +
        `  • Algum blocker novo?\n\n` +
        `📊 ${config.DASHBOARD_URL}`;

      await evolution.sendText(donoPhone, msg).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      notificados.push({ cliente: ctx.cliente, dono: donoNome, ultimaAtu });
    }

    if (notificados.length > 0) {
      const lista = notificados.map(n => `• *${n.cliente}* (${n.dono}) — _${n.ultimaAtu}_`).join('\n');
      await sendToManagers(
        `📋 *Lembrete semanal enviado (${semana})*\n\n` +
        `Cobrei ${notificados.length} dono(s) para revisar o contexto vivo:\n\n${lista}`
      );
    }
  } catch (err) {
    console.error('[alert-engine] Erro no lembrete segunda:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// S7 — APROVAÇÕES ESTAGNADAS: >2 dias em aprovação sem update
// Chamado junto com o briefing matinal.
// Cobra responsável + notifica managers.
// ─────────────────────────────────────────────────────────────

async function checkStalledApprovals(tasks) {
  try {
    const hoje = Date.now();

    const emAprovacao = tasks.filter(t => {
      const st = (t.status || '').toLowerCase().replace(/\s/g, '');
      return st.includes('aprovacao') || st.includes('aprovação') || st === 'emaprovacao';
    });

    if (emAprovacao.length === 0) return;

    const stalled = emAprovacao.filter(t => {
      const lastUpdate = parseDate(t.updatedAt || t.createdAt);
      if (!lastUpdate) return false;
      return (hoje - lastUpdate.getTime()) > APPROVAL_DAYS * 86400000;
    });

    if (stalled.length === 0) return;

    // Agrupar por responsável
    const byPerson = {};
    stalled.forEach(t => {
      const people = (t.person || '').split(/[,e&]+/).map(p => p.trim()).filter(Boolean);
      for (const p of people) {
        if (!byPerson[p]) byPerson[p] = [];
        byPerson[p].push(t);
      }
    });

    for (const [person, personTasks] of Object.entries(byPerson)) {
      const phone = config.TEAM_PHONES[person];
      if (!phone) continue;

      const lista = personTasks.map(t => {
        const dias = Math.floor((hoje - (parseDate(t.updatedAt || t.createdAt)?.getTime() || hoje)) / 86400000);
        return `  • *[${t.project}]* ${t.task} _(${dias}d em aprovação)_\n     🔗 ${config.taskLink(t)}`;
      }).join('\n');

      const msg = `⏳ *${person}*, ${personTasks.length > 1 ? 'essas tarefas estão' : 'essa tarefa está'} em aprovação há mais de ${APPROVAL_DAYS} dias:\n\n${lista}\n\nJá foi aprovado? Atualiza o status ou me fala o que está travando.`;
      await evolution.sendText(phone, msg).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    }

    // Resumo para managers
    const lista = stalled.map(t => `• *[${t.project}]* ${t.task} (${t.person || 'sem dono'})`).join('\n');
    await sendToManagers(
      `⏳ *${stalled.length} tarefa(s) em aprovação estagnada:*\n\n${lista}\n\nJá cobrei os responsáveis.`
    );

  } catch (err) {
    console.warn('[alert-engine] Erro ao checar aprovações estagnadas:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// FIM DO DIA — convoca responsáveis a atualizar Contexto Vivo VIA WHATSAPP
// Seg-Qui 18h BRT · Sex 12h BRT
// Agrupa projetos por pessoa (primeiro nome → TEAM_PHONES) e manda 1 DM consolidada.
// Pula projetos com status pausado/pausa.
// ─────────────────────────────────────────────────────────────

async function runEndOfDayContextoPrompt() {
  console.log('[alert-engine] Fim do dia — convocar contexto vivo via WhatsApp');
  try {
    const contextoVivo = await sheets.getContextoVivo().catch(() => ({}));
    const slugs = Object.keys(contextoVivo);
    if (slugs.length === 0) return;

    // Agrega projetos por primeiro nome do responsável (qualquer role: dono/comercial/trafego/...)
    const byPerson = {};
    for (const slug of slugs) {
      const ctx = contextoVivo[slug];
      if (!ctx || !ctx.cliente) continue;
      const status = String(ctx.status || '').toLowerCase();
      if (status === 'pausa' || status === 'pausado') continue;

      const seen = new Set(); // evita duplicar quando mesma pessoa aparece em vários roles
      for (const name of Object.values(ctx.responsaveis || {})) {
        if (!name) continue;
        const firstName = String(name).trim().split(/\s+/)[0];
        if (!firstName || seen.has(firstName)) continue;
        seen.add(firstName);
        if (!config.TEAM_PHONES[firstName]) continue; // só time interno
        if (!byPerson[firstName]) byPerson[firstName] = [];
        byPerson[firstName].push({ cliente: ctx.cliente, slug });
      }
    }

    const nomes = Object.keys(byPerson);
    if (nomes.length === 0) return;

    for (const nome of nomes) {
      const phone = config.TEAM_PHONES[nome];
      const projects = byPerson[nome];
      const lista = projects.map(p => `  • ${p.cliente}`).join('\n');
      const msg = `🌙 *Fim do dia, ${nome}!*\n\n` +
        `Hora de atualizar o Contexto Vivo. Você é responsável por:\n\n${lista}\n\n` +
        `Responde aqui mesmo que eu gravo no painel — sem precisar abrir nada. Exemplos:\n` +
        `  • "atualiza contexto do <PROJ>: <texto>"\n` +
        `  • "blocker no <PROJ>: <texto>"\n` +
        `  • "próxima ação <PROJ>: <texto>"\n` +
        `  • "decisão <PROJ>: <texto>"`;
      await evolution.sendText(phone, msg).catch(err =>
        console.warn(`[alert-engine] Falha DM fim-do-dia para ${nome}:`, err.message)
      );
      await new Promise(r => setTimeout(r, 1200));
    }

    const resumo = nomes.map(n => `• *${n}* (${byPerson[n].length} projeto${byPerson[n].length > 1 ? 's' : ''})`).join('\n');
    await sendToManagers(`🌙 *Convocação fim-do-dia enviada*\n\nChamei ${nomes.length} pessoa(s) pra atualizar o Contexto Vivo via WhatsApp:\n\n${resumo}`);
  } catch (err) {
    console.error('[alert-engine] Erro no fim-do-dia contexto:', err.message);
  }
}

module.exports = {
  runMorning,
  runAfternoon,
  runNagCheck,
  runStuckWatchdog,
  runContextoVivoBriefing,
  runMondayContextoReminder,
  runEndOfDayContextoPrompt,
  checkStalledApprovals
};
