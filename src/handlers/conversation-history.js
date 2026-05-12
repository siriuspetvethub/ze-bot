// Histórico de conversa em memória por usuário
// TTL de 30 minutos de inatividade — suficiente para uma conversa de WhatsApp
// Não persiste entre restarts do servidor (aceitável para o caso de uso)
'use strict';

const TTL_MS   = 30 * 60 * 1000; // 30 minutos
const MAX_PAIRS = 8;              // 8 trocas = 16 mensagens

const store = new Map(); // phone → { messages: [{role, content}], lastActivity }

/**
 * Retorna histórico ativo do usuário.
 * Se expirado, limpa e retorna array vazio.
 * @param {string} phone
 * @returns {Array<{role: string, content: string}>}
 */
function get(phone) {
  const entry = store.get(phone);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > TTL_MS) {
    store.delete(phone);
    return [];
  }
  return entry.messages;
}

/**
 * Adiciona uma mensagem ao histórico do usuário.
 * Garante alternância user/assistant e tamanho máximo.
 * @param {string} phone
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function append(phone, role, content) {
  if (!content || !content.trim()) return;

  let messages = get(phone);
  messages = [...messages, { role, content }];

  // Cortar para MAX_PAIRS trocas
  if (messages.length > MAX_PAIRS * 2) {
    messages = messages.slice(-(MAX_PAIRS * 2));
  }

  // API Claude exige que comece com 'user'
  while (messages.length > 0 && messages[0].role !== 'user') {
    messages = messages.slice(1);
  }

  store.set(phone, { messages, lastActivity: Date.now() });
}

/**
 * Remove histórico do usuário (ex: após /clear ou erro grave)
 * @param {string} phone
 */
function clear(phone) {
  store.delete(phone);
}

module.exports = { get, append, clear };
