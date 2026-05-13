// Entry point — servidor Express do Zé Bot
// Inicia webhook, cron jobs e expõe endpoint de health check
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const express       = require('express');
const cron          = require('node-cron');
const router        = require('./src/router');
const alertEngine    = require('./src/jobs/alert-engine');
const report         = require('./src/jobs/report');
const watchdog       = require('./src/jobs/watchdog');
const salesNotifier  = require('./src/jobs/sales-notifier');
const dailyBriefing  = require('./src/jobs/daily-briefing');
const config        = require('./src/config');

const app     = express();
const startAt = new Date();

// Modo de pausa — ativado via POST /admin/pause, desativado via POST /admin/resume
let paused = false;

app.use(express.json({ limit: '10mb' }));

// --- Endpoints ---

/**
 * Webhook principal — recebe eventos da Evolution API
 * URL configurada na Evolution: POST /webhook/ze-incoming
 */
app.post('/webhook/ze-incoming', async (req, res) => {
  // Responder imediatamente (Evolution não aguarda processamento)
  res.status(200).json({ ok: true });

  if (paused) {
    console.log('[server] PAUSED — ze-incoming ignorado');
    return;
  }

  // Processar assincronamente para não bloquear o webhook
  router.process(req.body).catch(err => {
    console.error('[server] Erro no router.process:', err.message);
  });
});

/**
 * Webhook de vendas — recebe eventos de Hotmart e Eduzz
 * URL configurada nas plataformas: POST /webhook/ze-sale-event
 */
app.post('/webhook/ze-sale-event', async (req, res) => {
  res.status(200).json({ ok: true, processed: true });

  if (paused) {
    console.log('[server] PAUSED — ze-sale-event ignorado');
    return;
  }

  salesNotifier.handleSaleEvent(req.body, req.headers).catch(err => {
    console.error('[server] Erro no salesNotifier:', err.message);
  });
});

/**
 * Health check — retorna status da aplicação
 */
app.get('/health', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startAt.getTime()) / 1000);
  res.json({
    ok:        true,
    paused,
    version:   config.CONFIG_VERSION,
    uptime:    uptimeSeconds,
    startedAt: startAt.toISOString(),
    instance:  config.EVOLUTION_INSTANCE,
    env: {
      hasAnthropicKey: !!config.ANTHROPIC_API_KEY,
      hasOpenAiKey:    !!config.OPENAI_API_KEY,
      hasEvolutionKey: !!config.EVOLUTION_API_KEY
    }
  });
});

/**
 * Webhook de contexto vivo — recebe mutações feitas pelo dashboard
 * O dashboard chama este endpoint ao salvar qualquer campo de tarefa.
 * Guard: origin='ze-whatsapp' é ignorado para evitar loop.
 * POST /webhook/ze-task-update
 * Body: { action, person, task, project, taskId, newStatus?, oldStatus?, origin? }
 */
app.post('/webhook/ze-task-update', async (req, res) => {
  res.status(200).json({ ok: true });

  const { action, person, task, project, taskId, newStatus, oldStatus, origin, note, target, deadline, reason, mentionedBy, excerpt } = req.body || {};

  // Anti-loop: ignorar atualizações originadas pelo próprio bot
  if (origin === 'ze-whatsapp' || origin === 'bot') return;
  if (!action || !task) return;
  if (paused) {
    console.log('[server] PAUSED — ze-task-update ignorado');
    return;
  }

  const LABELS = {
    status_change:  () => `${person || 'Alguém'} atualizou *[${project}]* ${task}\n   ${oldStatus ? `${oldStatus} → ` : ''}*${newStatus || ''}*`,
    person_change:  () => `${person || 'Alguém'} atribuiu *[${project}]* ${task}\n   → *${target || person}*`,
    note_added:     () => `${person || 'Alguém'} adicionou nota em *[${project}]* ${task}\n   💬 _${(note || '').slice(0, 80)}_`,
    reschedule:     () => `${person || 'Alguém'} reagendou *[${project}]* ${task}\n   📅 Novo prazo: *${deadline || ''}*`,
    blocked:        () => `${person || 'Alguém'} travou *[${project}]* ${task}${reason ? `\n   🚧 ${reason}` : ''}`,
    task_created:   () => `${person || 'Alguém'} criou tarefa em *[${project}]*\n   📋 ${task}`,
    task_deleted:   () => `${person || 'Alguém'} excluiu tarefa em *[${project}]*\n   🗑️ ${task}`,
    task_done_for_requester: () => `✅ *${target || 'Alguém'}* concluiu uma tarefa solicitada por *${person || 'alguém'}*\n   📋 *[${project}]* ${task}\n   👉 ${person ? person.split(/[,;\/]/)[0].trim() : 'solicitante'}, sua próxima ação está liberada.`,
  };

  // Ações que pingam @ no grupo (criação, conclusão pro solicitante, travamento).
  // Demais ações vão silenciosas — visíveis no grupo, sem notificar celular.
  const LOUD_ACTIONS = new Set(['task_created', 'task_done_for_requester', 'blocked']);

  function namesToMentions(namesStr) {
    if (!namesStr) return { jids: [], tags: '' };
    const names = String(namesStr).split(/[,;\/&]| e /).map(n => n.trim()).filter(Boolean);
    const phones = [];
    for (const n of names) {
      const phone = config.TEAM_PHONES[n];
      if (phone && !phones.includes(phone)) phones.push(phone);
    }
    return {
      jids: phones.map(p => `${p}@s.whatsapp.net`),
      tags: phones.map(p => `@${p}`).join(' ')
    };
  }

  const evolution = require('./src/clients/evolution');
  const tLink  = taskId
    ? `https://siriuspetvet.com.br/dash/?task=${encodeURIComponent(taskId)}`
    : 'https://siriuspetvet.com.br/dash/';
  const groupId = config.ADMIN_GROUP_ID.replace('@g.us', '');

  // ---- Caso especial: @menção (avisa no grupo + DM pra pessoa marcada) ----
  if (action === 'mention') {
    const mentionedName = person;                  // pessoa marcada
    const author        = mentionedBy || 'Alguém'; // quem marcou
    const phone         = config.TEAM_PHONES[mentionedName];
    if (!mentionedName) return;

    const excerptStr = (excerpt || '').slice(0, 80);
    const groupMsg = `🖥️ *Atualização pelo Dashboard*\n\n📣 *${author}* marcou *${mentionedName}* em *[${project}]* ${task}` +
      (excerptStr ? `\n   💬 _"${excerptStr}"_` : '') +
      `\n\n🔗 ${tLink}`;

    // Mensagem no grupo Sirius com menção real no WhatsApp (vira notificação no celular)
    if (phone) {
      const jid = `${phone}@s.whatsapp.net`;
      // Append @phone no fim pra o WhatsApp renderizar a menção (sem italic — interfere no parser)
      const groupMsgWithMention = `${groupMsg}\n\ncc @${phone}`;
      evolution.sendTextWithMentions(groupId, groupMsgWithMention, [jid]).catch(err =>
        console.error('[server] Falha ao notificar grupo (mention):', err.message)
      );
    } else {
      evolution.sendText(groupId, groupMsg).catch(err =>
        console.error('[server] Falha ao notificar grupo (mention, sem phone):', err.message)
      );
    }

    // DM pra pessoa marcada (mais detalhado, sem exposição no grupo)
    if (phone) {
      const excerptDM = (excerpt || '').slice(0, 120);
      const dmMsg = `📣 Você foi marcado em *[${project}]* ${task}\n   👤 Por: *${author}*` +
        (excerptDM ? `\n   💬 _"${excerptDM}"_` : '') +
        `\n\n🔗 ${tLink}`;
      evolution.sendText(phone, dmMsg).catch(err =>
        console.error(`[server] Falha ao mandar DM mention (${mentionedName}):`, err.message)
      );
    } else {
      console.warn(`[server] Sem phone configurado pra "${mentionedName}" — DM não enviada`);
    }
    return;
  }

  const textFn = LABELS[action] || (() => `${person || 'Alguém'} editou *[${project}]* ${task} (${action})`);
  const baseMsg = `🖥️ *Atualização pelo Dashboard*\n\n${textFn()}\n\n🔗 ${tLink}`;

  if (LOUD_ACTIONS.has(action)) {
    // Pra task_done_for_requester o "ponto focal" do ping é o solicitante (person);
    // pra task_created e blocked é o responsável (person).
    const { jids, tags } = namesToMentions(person);
    if (jids.length > 0) {
      const msgWithMention = `${baseMsg}\n\ncc ${tags}`;
      evolution.sendTextWithMentions(groupId, msgWithMention, jids).catch(err =>
        console.error('[server] Falha ao notificar grupo (loud):', err.message)
      );
    } else {
      evolution.sendText(groupId, baseMsg).catch(err =>
        console.error('[server] Falha ao notificar grupo (loud, sem phone):', err.message)
      );
    }
  } else {
    evolution.sendText(groupId, baseMsg).catch(err =>
      console.error('[server] Falha ao notificar grupo (dashboard):', err.message)
    );
  }
});

/**
 * Admin: disparar jobs manualmente para testes
 * POST /admin/trigger/:job?token=ZE_TEST_2026
 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'ZE_TEST_2026';

app.post('/admin/pause', (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  paused = true;
  console.log('[admin] MODO PAUSA ATIVADO — todas as automações suspensas');
  res.json({ ok: true, paused: true, message: 'Zé Bot pausado. Use /admin/resume para religar.' });
});

app.post('/admin/resume', (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  paused = false;
  console.log('[admin] MODO PAUSA DESATIVADO — automações reativadas');
  res.json({ ok: true, paused: false, message: 'Zé Bot reativado. Automações voltaram ao normal.' });
});

/**
 * Recebe resumo do checkup diário do painel operacional e dispara mensagem
 * no WhatsApp do Thiago (ADMIN_PHONE). Chamado pelo agente cloud do /schedule
 * que roda todo dia útil às 8h.
 *
 * POST /admin/checkup-notify?token=<ADMIN_TOKEN>
 * Body: { date_br, p0, p1, p2, top3_lines, report_path }
 */
app.post('/admin/checkup-notify', async (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { date_br, p0 = 0, p1 = 0, p2 = 0, top3_lines = '', report_path = '' } = req.body || {};
  if (!date_br) return res.status(400).json({ ok: false, error: 'date_br obrigatório (DD/MM)' });

  const total = Number(p0) + Number(p1) + Number(p2);
  let text;
  if (total === 0) {
    text = `☀️ Checkup do painel — ${date_br}\n\nTudo limpo. Smoke test OK em Chromium + WebKit, 0 bugs novos no feedback do time, logs do Zé sem exceptions.`;
  } else {
    text = `☀️ Checkup do painel — ${date_br}\n\nP0: ${p0} · P1: ${p1} · P2: ${p2}`;
    if (top3_lines) text += `\n\nTop 3:\n${top3_lines}`;
    if (report_path) text += `\n\nRelatorio completo: ${report_path}`;
    text += `\n\nResponde "aplicar" quando abrir o Claude pra eu seguir com os fixes.`;
  }

  try {
    const evolution = require('./src/clients/evolution');
    const result = await evolution.sendText(config.ADMIN_PHONE, text);
    res.json({ ok: true, sent: true, id: result && result.key && result.key.id });
  } catch (err) {
    console.error('[admin/checkup-notify] erro:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/trigger/:job', async (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { job } = req.params;
  const jobs = {
    morning:         () => alertEngine.runMorning(),
    stuck:           () => alertEngine.runStuckWatchdog(),
    afternoon:       () => alertEngine.runAfternoon(),
    nag:             () => alertEngine.runNagCheck(),
    contexto:        () => alertEngine.runContextoVivoBriefing(),
    monday:          () => alertEngine.runMondayContextoReminder(),
    report:          () => report.run(),
    weekly:          () => report.runWeekly(),
    'daily-briefing': () => dailyBriefing.run(req.body.taskIds || []),
  };
  if (!jobs[job]) return res.status(404).json({ ok: false, error: 'job not found', available: Object.keys(jobs) });
  res.json({ ok: true, job, triggered: new Date().toISOString() });
  jobs[job]().catch(err => console.error(`[admin/trigger] ${job}:`, err.message));
});

// --- Cron Jobs ---
// Container roda com TZ=America/Sao_Paulo — horários são BRT direto.

// Briefing matinal personalizado: 8h BRT, seg-sex
cron.schedule('0 8 * * 1-5', () => {
  if (paused) return;
  console.log('[cron] Briefing matinal 8h BRT');
  alertEngine.runMorning().catch(err => console.error('[cron] runMorning:', err.message));
});

// Watchdog tarefas travadas: 8h15 BRT, seg-sex
cron.schedule('15 8 * * 1-5', () => {
  if (paused) return;
  console.log('[cron] Watchdog travadas 8h15');
  alertEngine.runStuckWatchdog().catch(err => console.error('[cron] runStuckWatchdog:', err.message));
});

// Nag check: a cada 5 min, das 9h-18h BRT, seg-sex
cron.schedule('*/5 9-18 * * 1-5', () => {
  if (paused) return;
  alertEngine.runNagCheck().catch(err => console.error('[cron] runNagCheck:', err.message));
});

// Alerta vespertino: 16h BRT, seg-sex
cron.schedule('0 16 * * 1-5', () => {
  if (paused) return;
  console.log('[cron] Alerta 16h BRT');
  alertEngine.runAfternoon().catch(err => console.error('[cron] runAfternoon:', err.message));
});

// Contexto vivo + cobrança de atualização: 17h BRT, todos os dias úteis
cron.schedule('0 17 * * 1-5', () => {
  if (paused) return;
  console.log('[cron] Contexto vivo 17h BRT');
  alertEngine.runContextoVivoBriefing().catch(err => console.error('[cron] runContextoVivoBriefing:', err.message));
});

// Relatório diário: 19h BRT, seg-sex
cron.schedule('0 19 * * 1-5', () => {
  if (paused) return;
  console.log('[cron] Relatório diário 19h');
  report.run().catch(err => console.error('[cron] report:', err.message));
});

// Lembrete revisão contexto vivo: toda segunda 9h BRT
cron.schedule('0 9 * * 1', () => {
  if (paused) return;
  console.log('[cron] Lembrete contexto vivo segunda 9h');
  alertEngine.runMondayContextoReminder().catch(err => console.error('[cron] runMondayContextoReminder:', err.message));
});

// Dashboard semanal: sextas 8h BRT
cron.schedule('0 8 * * 5', () => {
  if (paused) return;
  console.log('[cron] Dashboard semanal sexta');
  report.runWeekly().catch(err => console.error('[cron] runWeekly:', err.message));
});

// Watchdog Evolution API: a cada 10 min (roda mesmo pausado — só verifica conexão, não envia msgs)
cron.schedule('*/10 * * * *', () => {
  watchdog.run().catch(err => console.error('[cron] watchdog:', err.message));
});

// --- Inicialização ---
app.listen(config.PORT, () => {
  console.log(`[server] Zé Bot v${config.CONFIG_VERSION} iniciado`);
  console.log(`[server] Porta: ${config.PORT}`);
  console.log(`[server] Instância Evolution: ${config.EVOLUTION_INSTANCE}`);
  console.log(`[server] Webhook: POST http://localhost:${config.PORT}/webhook/ze-incoming`);
  console.log(`[server] Health:  GET  http://localhost:${config.PORT}/health`);

  // Executar watchdog imediatamente ao iniciar
  watchdog.run().catch(err => console.error('[server] Watchdog inicial:', err.message));
});

// Tratar erros não capturados sem derrubar o processo
process.on('uncaughtException', err => {
  console.error('[server] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
