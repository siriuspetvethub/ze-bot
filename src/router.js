// Roteador minimal — Zé é puramente informacional.
// Não interpreta comandos, não atualiza painel, não pergunta nada.
// Quando recebe mensagem, manda 1x/dia por número uma resposta padrão com o link.
'use strict';

const memberResolver = require('./handlers/member-resolver');
const evolution     = require('./clients/evolution');
const sheets        = require('./clients/sheets');
const config        = require('./config');

const SHEET_LOG = 'ZE_LOG';

// Cache em memória: phone → timestamp do último auto-reply enviado.
// Limita auto-reply a 1x a cada AUTO_REPLY_TTL pra não spammar quem manda várias mensagens seguidas.
const lastAutoReplyAt = new Map();
const AUTO_REPLY_TTL  = 24 * 60 * 60 * 1000; // 24h

function shouldAutoReply(phone) {
  const last = lastAutoReplyAt.get(phone) || 0;
  return (Date.now() - last) > AUTO_REPLY_TTL;
}

function markReplied(phone) {
  lastAutoReplyAt.set(phone, Date.now());
}

const AUTO_REPLY_TEXT =
  `Oi! Eu só mando notificações do painel — não interpreto mensagens nem atualizo tarefas por aqui.\n\n` +
  `Pra ver ou atualizar qualquer coisa, acessa o painel:\n📊 ${config.DASHBOARD_URL}`;

/**
 * Ponto de entrada principal — processa um evento de webhook da Evolution API
 */
async function process(body) {
  const startTime = Date.now();

  const data    = body.data || body;
  const key     = data.key || {};
  const message = data.message || {};
  const rawJid  = key.remoteJid || '';
  const isGroup = rawJid.endsWith('@g.us');

  const senderNumber = memberResolver.normalizeJid(body);

  // Filtrar mensagens do próprio bot
  if (senderNumber === config.BOT_NUMBER || key.fromMe === true) return;

  // Em grupos: ignora sempre. Zé é só DM agora.
  if (isGroup) return;

  // Só processa texto ou áudio (ignora outros eventos)
  const isAudio = !!(message.audioMessage || message.pttMessage);
  const isText  = !!(message.conversation || message.extendedTextMessage?.text);
  if (!isAudio && !isText) return;

  // Resolver membro só pra log — não é mais bloqueio
  const { person } = memberResolver.resolveMember(senderNumber);

  // Auto-reply 1x por 24h
  if (shouldAutoReply(senderNumber)) {
    await evolution.sendText(senderNumber, AUTO_REPLY_TEXT).catch(err =>
      console.warn('[router] Falha no auto-reply:', err.message)
    );
    markReplied(senderNumber);
    logInteraction({
      sender: senderNumber, person,
      intent: 'auto_reply', actionResult: 'sent',
      duration: Date.now() - startTime
    });
  }
}

function logInteraction({ sender, person, intent, actionResult, duration }) {
  const values = [
    new Date().toISOString(),
    sender || '',
    intent || '',
    actionResult || '',
    '',
    String(duration || 0),
    person || '',
    '',
    ''
  ];
  sheets.post({ sheetName: SHEET_LOG, values }).catch(err =>
    console.warn('[router] Erro ao logar:', err.message)
  );
}

module.exports = { process };
