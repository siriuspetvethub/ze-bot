/**
 * Sirius frame — envelopa mensagens do Zé com identidade visual padrão.
 *
 * Pattern:
 *   *✦ CONTEXTO · LABEL*
 *   ━━━━━━━━━━━━━━
 *
 *   [body]
 *
 *   ━━━━━━━━━━━━━━
 *   _zé · sirius · ↗ link*
 *   https://siriuspetvet.com.br/dash/
 *
 * Opt-out via env: ZE_FRAME=false retorna o body cru (útil pra rollback rápido).
 */

const DIVIDER = '━━━━━━━━━━━━━━';
const PAINEL_URL = process.env.DASHBOARD_URL || 'https://siriuspetvet.com.br/dash/';
const SIGNATURE = 'zé · sirius';

// Símbolo único Sirius — '✦' (four-pointed star) ecoa o lockup da marca
// e renderiza consistente em qualquer cliente WhatsApp.
const BULLET = '✦';

/**
 * Envolve uma mensagem com header + footer Sirius.
 *
 * @param {object} opts
 * @param {string} opts.contextLabel - rótulo do contexto (ex: "Briefing · 08h", "Alerta · atraso")
 * @param {string} opts.body         - corpo da mensagem (texto já formatado WhatsApp)
 * @param {string} [opts.linkLabel]  - rótulo do link no footer (default: "painel operacional")
 * @param {string} [opts.link]       - URL do link (default: PAINEL_URL)
 * @returns {string}
 */
function frame({ contextLabel, body, linkLabel = 'painel operacional', link = PAINEL_URL }) {
  // Escape hatch: desliga via env
  if (process.env.ZE_FRAME === 'false' || process.env.ZE_FRAME === '0') {
    return body;
  }

  const header = `*${BULLET} ${contextLabel.toUpperCase()}*\n${DIVIDER}`;
  const footer = `${DIVIDER}\n_${SIGNATURE} · ↗ ${linkLabel}_\n${link}`;
  return `${header}\n\n${body}\n\n${footer}`;
}

module.exports = { frame, DIVIDER, PAINEL_URL, SIGNATURE, BULLET };
