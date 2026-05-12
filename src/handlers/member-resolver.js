// Resolução de membro da equipe a partir do JID do WhatsApp
// Porta a lógica do nó "Resolver Membro" do ZE-ROUTER
// Resolve dois bugs críticos: formato @lid e 12 vs 13 dígitos BR
'use strict';

const config = require('../config');

/**
 * Normaliza o JID do remetente para número E164 puro
 * Bug @lid: WhatsApp DMs podem chegar com remoteJid = "XXXX@lid" (ID interno)
 * O número real fica em key.senderPn nesse caso
 * @param {object} body - Payload completo do webhook Evolution
 * @returns {string} Número normalizado (somente dígitos)
 */
function normalizeJid(body) {
  const data = body.data || body;
  const key  = data.key || {};
  const rawJid = key.remoteJid || '';
  const isGroup = rawJid.endsWith('@g.us');

  let senderJid = rawJid;

  if (isGroup) {
    // Em grupos: remetente real está em participant
    const participant = key.participant || data.participant || '';
    if (participant) senderJid = participant;
  } else if (rawJid.endsWith('@lid')) {
    // Formato @lid: usar senderPn quando disponível (número E164 real)
    const senderPn = key.senderPn || '';
    if (senderPn) senderJid = senderPn;
  }

  return extractDigits(senderJid);
}

/**
 * Remove sufixo @xxx e caracteres não numéricos de um JID
 * @param {string} jid
 * @returns {string}
 */
function extractDigits(jid) {
  return (jid || '').split('@')[0].replace(/\D/g, '');
}

/**
 * Gera candidatos de lookup para um número recebido
 * Resolve o bug 12 vs 13 dígitos: TEAM_MAP usa 13d (com nono dígito)
 * mas Evolution pode enviar 12d (formato antigo sem nono dígito)
 * @param {string} num - Número bruto
 * @returns {string[]} Lista de candidatos para busca no TEAM_MAP
 */
function getCandidates(num) {
  if (!num) return [];
  let n = String(num).replace(/\D/g, '');
  const candidates = new Set([n]);

  // Adicionar prefixo 55 se ausente e parece número BR
  if (!n.startsWith('55') && n.length >= 10 && n.length <= 11) {
    n = '55' + n;
    candidates.add(n);
  }

  // 12 dígitos (formato antigo sem nono): inserir 9 após DDD
  // Ex: 5561 99393066 → 5561 9 99393066
  if (n.startsWith('55') && n.length === 12) {
    candidates.add(n.slice(0, 4) + '9' + n.slice(4));
  }

  // 13 dígitos (formato moderno com nono): tentar sem o 9
  // Para cobrir TEAM_MAP com 12d e chegada com 13d
  if (n.startsWith('55') && n.length === 13 && n[4] === '9') {
    candidates.add(n.slice(0, 4) + n.slice(5));
  }

  return Array.from(candidates);
}

/**
 * Resolve nome do membro a partir do número do remetente
 * @param {string} senderNumber - Número normalizado (somente dígitos)
 * @returns {{ person: string|null, personFound: boolean }}
 */
function resolveMember(senderNumber) {
  const candidates = getCandidates(senderNumber);
  for (const candidate of candidates) {
    if (config.TEAM_MAP[candidate]) {
      return { person: config.TEAM_MAP[candidate], personFound: true };
    }
  }
  return { person: null, personFound: false };
}

module.exports = { normalizeJid, extractDigits, getCandidates, resolveMember };
