// Transcrição de áudio via OpenAI Whisper
// Porta a lógica dos nós "Download Audio" e "Whisper Transcricao" do ZE-ROUTER
// Em Node.js não há o bug fetch() do n8n — usa axios + FormData nativamente
'use strict';

const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');
const evolution = require('../clients/evolution');

/**
 * Baixa áudio de uma URL e transcreve com Whisper
 * Estratégia 1: download direto da URL
 * Estratégia 2 (fallback): buscar base64 via Evolution getBase64FromMediaMessage
 * @param {string} audioUrl - URL do áudio (pode ser null)
 * @param {string} [messageId] - ID da mensagem Evolution (para fallback base64)
 * @returns {Promise<string|null>} Texto transcrito ou null em caso de falha
 */
async function transcribe(audioUrl, messageId) {
  try {
    let audioBuffer;

    // Estratégia 1: baixar diretamente da URL
    if (audioUrl) {
      try {
        const response = await axios.get(audioUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });
        audioBuffer = Buffer.from(response.data);
        console.log(`[audio] Download direto OK (${audioBuffer.length} bytes)`);
      } catch (downloadErr) {
        console.warn(`[audio] Download direto falhou: ${downloadErr.message} — tentando fallback base64`);
        audioBuffer = null;
      }
    }

    // Estratégia 2 (fallback): buscar base64 via Evolution API
    if (!audioBuffer && messageId) {
      console.log(`[audio] Tentando getMediaBase64 para messageId=${messageId}`);
      const base64 = await evolution.getMediaBase64(messageId);
      if (base64) {
        audioBuffer = Buffer.from(base64, 'base64');
        console.log(`[audio] Base64 via Evolution OK (${audioBuffer.length} bytes)`);
      } else {
        console.warn('[audio] getMediaBase64 retornou vazio');
      }
    }

    if (!audioBuffer) {
      console.warn('[audio] Nenhuma estratégia funcionou para obter o áudio');
      return null;
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      console.warn('[audio] Buffer vazio após download');
      return null;
    }

    // Enviar para Whisper via FormData multipart
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    form.append('response_format', 'json');

    const whisperResp = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          'Authorization': `Bearer ${config.OPENAI_API_KEY}`,
          ...form.getHeaders()
        },
        timeout: 60000
      }
    );

    return whisperResp.data?.text || null;
  } catch (err) {
    console.error('[audio] Erro na transcrição:', err.message);
    return null;
  }
}

module.exports = { transcribe };
