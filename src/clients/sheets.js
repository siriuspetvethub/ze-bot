// Cliente Google Sheets via proxy Vercel
// Regra crítica: GET para leitura, POST para criação, PATCH para atualização
// Credenciais ficam SOMENTE no Vercel — nunca passar tokens aqui
'use strict';

const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.SHEETS_PROXY_URL,
  timeout: 20000
});

// Schema fixo das abas Ze Bot (ordem das colunas, 0-indexed)
// Deve corresponder ao cabeçalho real criado no Google Sheets
const ZE_SCHEMAS = {
  ZE_REMINDERS:     ['task_id', 'person', 'phone', 'project', 'task_name', 'last_reminder_at', 'reminder_count', 'escalated', 'resolved'],
  ZE_LOG:           ['timestamp', 'sender', 'intent', 'action', 'result', 'duration_ms', 'extra1', 'extra2', 'extra3'],
  ZE_KB:            ['project', 'category', 'content', 'source', 'created_at'],
  ZE_PENDING_CONFIRM: ['phone', 'task_row', 'task_sheet', 'task', 'project', 'person', 'task_status', 'deadline', 'intended_action', 'intent_json', 'status', 'created_at'],
};
const GENERIC_SHEETS = new Set(Object.keys(ZE_SCHEMAS));

/**
 * Lê dados de uma aba do Sheets.
 * Abas genéricas (ZE_REMINDERS, ZE_LOG, ZE_KB): retorna { tasks[], count } com objetos mapeados.
 * Abas de tarefa (BACKEND DASH): retorna objeto com campo tasks[] original do proxy.
 */
async function get(params = {}) {
  const { sheetName } = params;

  if (sheetName && GENERIC_SHEETS.has(sheetName)) {
    // Abas genéricas usam ?sheet= e retornam entries (arrays crus sem header)
    const resp = await client.get(`?sheet=${encodeURIComponent(sheetName)}`);
    const schema = ZE_SCHEMAS[sheetName] || [];
    const entries = resp.data.entries || [];
    const tasks = entries.map((row, i) => {
      const obj = { _row: i + 2 }; // linha 1 = header, dados começam na linha 2
      schema.forEach((col, j) => { obj[col] = (row[j] || '').trim(); });
      return obj;
    });
    return { tasks, count: tasks.length };
  }

  const query = new URLSearchParams();
  if (sheetName) query.set('sheetName', sheetName);
  const resp = await client.get(`?${query.toString()}`);
  return resp.data;
}

/**
 * Cria uma nova linha no Sheets.
 * Abas genéricas: converte data:{} → values:[] usando ZE_SCHEMAS.
 */
async function post(params) {
  const { sheetName } = params;

  if (sheetName && GENERIC_SHEETS.has(sheetName)) {
    let values;
    if (params.values && Array.isArray(params.values)) {
      values = params.values;
    } else if (params.data) {
      const schema = ZE_SCHEMAS[sheetName] || [];
      values = schema.map(col => params.data[col] ?? '');
    } else {
      throw new Error(`post() genérico requer data:{} ou values:[]`);
    }
    const resp = await client.post('', { sheetName, values });
    return resp.data;
  }

  const resp = await client.post('', {
    sheetName,
    ...(params.data   ? { data:   params.data   } : {}),
    ...(params.values ? { values: params.values } : {})
  });
  return resp.data;
}

/**
 * Atualiza colunas específicas de uma linha existente.
 * Abas genéricas: aceita col como string (nome da coluna) e converte para índice numérico.
 */
async function patch(params) {
  const { sheetName, row } = params;
  let updates = params.updates || [];

  if (sheetName && GENERIC_SHEETS.has(sheetName)) {
    const schema = ZE_SCHEMAS[sheetName] || [];
    updates = updates
      .map(u => ({ col: typeof u.col === 'string' ? schema.indexOf(u.col) : u.col, value: u.value }))
      .filter(u => u.col >= 0);
  }

  const resp = await client.patch('', { sheetName, row, updates });
  return resp.data;
}

/**
 * Apaga uma linha do Sheets.
 */
async function remove(params) {
  const resp = await client.delete('', {
    data: { sheetName: params.sheetName, row: params.row }
  });
  return resp.data;
}

/**
 * Retorna mapa de contexto vivo por cliente.
 * { slug: { contexto, proximas_acoes, decisoes, blockers, alertas, responsaveis, atualizado_em, ... } }
 */
async function getContextoVivo() {
  const resp = await client.get('?action=contextoVivo');
  return resp.data.contexto || {};
}

module.exports = { get, post, patch, remove, getContextoVivo };
