// Gerador de respostas em linguagem natural usando Sonnet
// Recebe o contexto completo do fluxo e gera mensagem final para o usuário
'use strict';

const anthropic = require('../clients/anthropic');

/**
 * Gera resposta final do Zé usando Sonnet
 * @param {object} ctx
 * @param {string} ctx.person - Nome do membro
 * @param {string} ctx.userMessage - Mensagem original
 * @param {object} ctx.intent - Resultado do Haiku
 * @param {string} ctx.actionResult - Resultado da ação executada
 * @param {string} ctx.actionMessage - Mensagem formatada da ação
 * @param {string} [ctx.knowledgeContext] - Contexto adicional da base de conhecimento
 * @param {Array<{role,content}>} [history] - Histórico da conversa para contexto
 * @returns {Promise<string>} Texto para enviar via WhatsApp
 */
async function respond(ctx, history = []) {
  try {
    return await anthropic.generateResponse(ctx, history);
  } catch (err) {
    console.error('[sonnet-responder] Erro ao gerar resposta:', err.message);
    // Fallback: usar actionMessage diretamente se Sonnet falhar
    return ctx.actionMessage || 'Opa, tive um probleminha aqui. Tenta de novo?';
  }
}

module.exports = { respond };
