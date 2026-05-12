// Watchdog — porta o ZE-WATCHDOG
// Verifica estado da conexão da Evolution API a cada 10 minutos
// Alerta imediatamente na primeira desconexão detectada
// Avisa também quando reconectar
'use strict';

const evolution = require('../clients/evolution');
const config    = require('../config');

// Estado binário: false = estava conectado, true = estava desconectado
// Garante alerta apenas na transição (sem spam em cada ciclo)
let wasDisconnected = false;

/**
 * Executa verificação de saúde da Evolution API
 * - Alerta na PRIMEIRA detecção de desconexão (sem esperar N falhas)
 * - Avisa quando reconectar
 * - Silencioso enquanto tudo está ok
 */
async function run() {
  try {
    const state = await evolution.getConnectionState();
    console.log(`[watchdog] Evolution state: ${state}`);

    if (state === 'open') {
      if (wasDisconnected) {
        // Transição: desconectado → conectado
        wasDisconnected = false;
        await evolution.sendText(config.ADMIN_PHONE,
          `✅ *Zé Bot — Evolution Reconectou*\n\nInstância *${config.EVOLUTION_INSTANCE}* voltou a ficar *online*.`
        );
      }
      return; // Tudo ok — silencioso
    }

    // Instância offline
    console.warn(`[watchdog] Instância offline: ${state}`);
    if (!wasDisconnected) {
      // Transição: conectado → desconectado (primeira detecção)
      wasDisconnected = true;
      await evolution.sendText(config.ADMIN_PHONE,
        `⚠️ *Zé Bot — Evolution Desconectou*\n\nInstância *${config.EVOLUTION_INSTANCE}* está *${state}*.\n\nVerificar: ${config.EVOLUTION_API_URL}`
      );
    }
  } catch (err) {
    console.error(`[watchdog] Erro ao verificar estado: ${err.message}`);
    if (!wasDisconnected) {
      // Tratar erro como desconexão na primeira ocorrência
      wasDisconnected = true;
      evolution.sendText(config.ADMIN_PHONE,
        `⚠️ *Zé Bot — Watchdog Error*\n\nErro ao verificar Evolution API: ${err.message}`
      ).catch(() => {});
    }
  }
}

module.exports = { run };
