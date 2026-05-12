// Cliente Evolution API — envio de mensagens WhatsApp
// Encapsula todas as chamadas à Evolution API com autenticação centralizada
'use strict';

const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.EVOLUTION_API_URL,
  headers: {
    'apikey': config.EVOLUTION_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

/**
 * Envia mensagem de texto via WhatsApp
 * @param {string} number - Número destino (somente dígitos, ex: 5561999393066)
 * @param {string} text - Texto da mensagem
 * @returns {Promise<object>} Resposta da Evolution API
 */
async function sendText(number, text) {
  const instance = config.EVOLUTION_INSTANCE;
  const resp = await client.post(`/message/sendText/${instance}`, {
    number,
    text
  });
  return resp.data;
}

/**
 * Envia mensagem de texto com menções (@) via WhatsApp
 * @param {string} number - Número ou JID destino (grupo ou contato)
 * @param {string} text - Texto da mensagem (use @NUMERO sem DDI alternativo para marcar)
 * @param {string[]} mentionedJids - JIDs dos mencionados (ex: ["5511995417981@s.whatsapp.net"])
 * @returns {Promise<object>}
 */
async function sendTextWithMentions(number, text, mentionedJids) {
  const instance = config.EVOLUTION_INSTANCE;
  const resp = await client.post(`/message/sendText/${instance}`, {
    number,
    text,
    mentionsEveryOne: false,
    mentioned: mentionedJids
  });
  return resp.data;
}

/**
 * Baixa mídia codificada em base64 via Evolution (getBase64FromMediaMessage)
 * Necessário para mensagens de áudio antes de transcrever com Whisper
 * @param {string} messageId - key.id da mensagem
 * @returns {Promise<string>} base64 do áudio
 */
async function getMediaBase64(messageId) {
  const instance = config.EVOLUTION_INSTANCE;
  const resp = await client.post(`/chat/getBase64FromMediaMessage/${instance}`, {
    key: { id: messageId }
  });
  return resp.data.base64 || null;
}

/**
 * Verifica estado da conexão da instância
 * @returns {Promise<string>} Estado: 'open' | 'connecting' | 'close'
 */
async function getConnectionState() {
  const instance = config.EVOLUTION_INSTANCE;
  const resp = await client.get(`/instance/connectionState/${instance}`);
  // Suporte a múltiplos formatos de resposta da Evolution API
  return resp.data?.state || resp.data?.instance?.state || 'unknown';
}

module.exports = { sendText, sendTextWithMentions, getMediaBase64, getConnectionState };
