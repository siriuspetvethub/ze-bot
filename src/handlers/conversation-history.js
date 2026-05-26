// Histórico de conversa persistido no Sheets (aba ZE_HISTORY) com cache em RAM.
// Sobrevive a restarts/deploys do servidor — diferente da versão antiga que era só RAM.
'use strict';

const sheets = require('../clients/sheets');

const SHEET_HISTORY = 'ZE_HISTORY';
const TTL_MS    = 30 * 60 * 1000; // 30 min de inatividade — depois reidrata do Sheets
const MAX_PAIRS = 8;              // 8 trocas = 16 mensagens mantidas em contexto

// phone → { messages: [{role, content}], lastActivity, hydrated }
const cache = new Map();

function trimMessages(messages) {
  let out = messages;
  if (out.length > MAX_PAIRS * 2) {
    out = out.slice(-(MAX_PAIRS * 2));
  }
  // API Claude exige que comece com 'user'
  while (out.length > 0 && out[0].role !== 'user') {
    out = out.slice(1);
  }
  return out;
}

/**
 * Retorna histórico do usuário. Async porque pode buscar no Sheets.
 * Cache hit (e não expirado) → serve do cache, sem network.
 * Cache miss ou expirado → reidrata do Sheets, popula cache.
 */
async function get(phone) {
  const entry = cache.get(phone);
  if (entry && Date.now() - entry.lastActivity <= TTL_MS) {
    return entry.messages;
  }

  // Cache miss/expirado — buscar no Sheets
  try {
    const data = await sheets.get({ sheetName: SHEET_HISTORY });
    const rows = data.tasks || [];
    const cutoff = Date.now() - TTL_MS;

    const recent = rows
      .filter(r => r.phone === phone)
      .filter(r => {
        const ts = Date.parse(r.created_at || '');
        return Number.isFinite(ts) && ts >= cutoff;
      })
      .map(r => ({ role: r.role, content: r.content }))
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content);

    const messages = trimMessages(recent);
    cache.set(phone, { messages, lastActivity: Date.now(), hydrated: true });
    return messages;
  } catch (err) {
    console.warn('[conversation-history] Falha ao reidratar do Sheets:', err.message);
    return entry?.messages || [];
  }
}

/**
 * Adiciona mensagem ao histórico. Atualiza cache sincronamente,
 * persiste no Sheets em background (não bloqueia a resposta).
 */
function append(phone, role, content) {
  if (!content || !content.trim()) return;

  const entry = cache.get(phone) || { messages: [], lastActivity: Date.now(), hydrated: false };
  const messages = trimMessages([...entry.messages, { role, content }]);
  cache.set(phone, { messages, lastActivity: Date.now(), hydrated: entry.hydrated });

  // Write-through fire-and-forget — não atrasa a resposta do bot
  sheets.post({
    sheetName: SHEET_HISTORY,
    data: {
      phone,
      role,
      content,
      created_at: new Date().toISOString()
    }
  }).catch(err => console.warn('[conversation-history] Falha ao persistir no Sheets:', err.message));
}

function clear(phone) {
  cache.delete(phone);
  // Linhas no Sheets ficam — limpar manual quando precisar (TTL natural cobre 99% dos casos)
}

module.exports = { get, append, clear };
