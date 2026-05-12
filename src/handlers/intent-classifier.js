// Classificador de intenção — wraps o cliente Anthropic com lógica de fallback
'use strict';

const anthropic = require('../clients/anthropic');

/**
 * Classifica a intenção de uma mensagem
 * Retorna objeto normalizado mesmo em caso de falha da API
 * @param {string} userMessage
 * @param {Array<{role,content}>} [history] - Histórico da conversa para contexto
 * @returns {Promise<object>} Objeto intent com campos: intent, project, task, etc.
 */
async function classify(userMessage, history = []) {
  try {
    return await anthropic.classifyIntent(userMessage, history);
  } catch (err) {
    console.error('[intent-classifier] Erro na classificação:', err.message);
    // Fallback seguro — não bloquear o fluxo por falha de classificação
    return {
      intent: 'unclear',
      confidence: 0,
      classifyError: err.message
    };
  }
}

module.exports = { classify };
