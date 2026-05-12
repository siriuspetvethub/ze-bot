// Base de conhecimento — porta a lógica do ZE-KNOWLEDGE
// Busca contexto na aba ZE_KB para enriquecer respostas sobre projetos/decisões
'use strict';

const sheets = require('../clients/sheets');

const SHEET_KB = 'ZE_KB';

/**
 * Busca contexto relevante na base de conhecimento
 * @param {object} ctx - { intent, person, userMessage }
 * @returns {Promise<{ actionResult, actionMessage, knowledgeContext? }>}
 */
async function handle(ctx) {
  const { intent, userMessage } = ctx;
  const query = (intent?.task || userMessage || '').toLowerCase();

  try {
    const data = await sheets.get({ sheetName: SHEET_KB });
    const entries = data.rows || data.tasks || [];

    if (entries.length === 0) {
      return {
        actionResult: 'knowledge',
        actionMessage: 'Base de conhecimento ainda vazia. Processa uma reunião para começar a popular!'
      };
    }

    // Filtrar entradas relevantes por palavras-chave da consulta
    const terms = query.split(/\s+/).filter(w => w.length > 2);
    const relevant = entries.filter(entry => {
      const content = [entry.project, entry.category, entry.content, entry.source]
        .join(' ').toLowerCase();
      return terms.some(t => content.includes(t));
    });

    if (relevant.length === 0) {
      return {
        actionResult: 'knowledge',
        actionMessage: 'Não encontrei nada relacionado na base de conhecimento.',
        knowledgeContext: null
      };
    }

    // Formatar contexto para o Sonnet
    const knowledgeContext = relevant.slice(0, 5).map(e =>
      `[${e.project || 'GERAL'}] ${e.content || ''} (fonte: ${e.source || 'desconhecida'})`
    ).join('\n');

    return {
      actionResult: 'knowledge',
      actionMessage: null, // Sonnet vai usar knowledgeContext para gerar resposta
      knowledgeContext
    };
  } catch (err) {
    console.error('[knowledge] Erro:', err.message);
    return { actionResult: 'error', actionMessage: 'Erro ao consultar base de conhecimento: ' + err.message };
  }
}

module.exports = { handle };
