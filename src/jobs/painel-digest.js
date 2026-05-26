// Agregador de atualizações "silenciosas" do painel operacional.
//
// Ações LOUD (mention, task_created, blocked, task_done_for_requester) continuam
// disparando no grupo em tempo real via server.js. Tudo que não exige reação imediata
// (status_change, person_change, field_change, note_added, task_deleted, reschedule)
// é empurrado pra cá e sai num único digest horário em horário comercial.
//
// Buffer em memória — restart do container perde até 1h de eventos, que é aceitável.
// Persistir num JSON dá durabilidade mas custa complexidade; pode ser feito depois.

const evolution = require('../clients/evolution');
const config    = require('../config');

let buffer = [];
let windowStart = new Date();

function enqueue(event) {
  buffer.push({ ...event, ts: new Date() });
}

function size() {
  return buffer.length;
}

// Trunca string longa pra não estourar mensagem do WhatsApp.
function trim(s, n = 50) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// Resumo curto de cada evento, sem repetir nome da pessoa (vai no agrupamento por autor).
function formatEvent(ev) {
  const projTag = `*[${ev.project || '?'}]*`;
  const taskStr = trim(ev.task, 50);
  switch (ev.action) {
    case 'status_change':
      return `${projTag} ${taskStr} → *${ev.newStatus || '?'}*`;
    case 'person_change': {
      const dest = ev.target || ev.newValue || '';
      if (!dest) return `${projTag} ${taskStr} → desatribuiu`;
      return `${projTag} ${taskStr} → atribuiu *${dest}*`;
    }
    case 'note_added':
      return `${projTag} ${taskStr} · 💬 _${trim(ev.note, 60)}_`;
    case 'field_change': {
      const FIELD_LABELS = {
        task: 'título', notes: 'notas', deadline: 'prazo',
        startDate: 'data início', priority: 'prioridade', subproject: 'sub-projeto',
        nextAction: 'próxima ação', blocker: 'bloqueio', requester: 'solicitante',
        miroLink: 'link Miro', comments: 'comentários',
      };
      const f = FIELD_LABELS[ev.field] || ev.field || 'campo';
      const nv = trim(ev.newValue, 40);
      if (nv) return `${projTag} ${taskStr} · ${f}: *${nv}*`;
      return `${projTag} ${taskStr} · ${f} (limpo)`;
    }
    case 'task_deleted':
      return `${projTag} 🗑️ ${taskStr}`;
    case 'reschedule':
      return `${projTag} ${taskStr} · 📅 ${ev.deadline || '?'}`;
    default:
      return `${projTag} ${taskStr} (${ev.action})`;
  }
}

function buildDigest(events, windowFrom, windowTo) {
  const fmtHora = d => String(d.getHours()).padStart(2, '0') + 'h' + String(d.getMinutes()).padStart(2, '0');
  const header = `📋 *Mexidas no painel · ${fmtHora(windowFrom)}–${fmtHora(windowTo)}*\n`;

  // Agrupa por autor
  const byAuthor = new Map();
  for (const ev of events) {
    const author = (ev.editedBy && ev.editedBy.trim()) || 'Alguém';
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author).push(ev);
  }

  // Ordena autores por volume (mais ativo primeiro), com Thiago/Álvaro estáveis se empate
  const authors = [...byAuthor.keys()].sort((a, b) => {
    const va = byAuthor.get(a).length, vb = byAuthor.get(b).length;
    if (va !== vb) return vb - va;
    return a.localeCompare(b);
  });

  const blocks = [];
  for (const author of authors) {
    const evs = byAuthor.get(author);
    const lines = evs.slice(0, 8).map(formatEvent).map(l => `  • ${l}`);
    if (evs.length > 8) lines.push(`  • _…mais ${evs.length - 8}_`);
    blocks.push(`*${author}* (${evs.length})\n${lines.join('\n')}`);
  }

  const footer = `\n🔗 https://siriuspetvet.com.br/dash/`;
  return header + '\n' + blocks.join('\n\n') + footer;
}

async function flush() {
  const windowTo = new Date();
  const windowFrom = windowStart;
  windowStart = windowTo;

  if (buffer.length === 0) {
    return { sent: false, count: 0 };
  }

  const events = buffer;
  buffer = [];

  const msg = buildDigest(events, windowFrom, windowTo);
  const groupId = config.ADMIN_GROUP_ID.replace('@g.us', '');

  try {
    await evolution.sendText(groupId, msg);
    console.log(`[painel-digest] enviado: ${events.length} eventos em ${[...new Set(events.map(e => e.editedBy || 'Alguém'))].length} autor(es)`);
    return { sent: true, count: events.length };
  } catch (err) {
    console.error('[painel-digest] falha ao enviar:', err.message);
    // Devolve eventos pro buffer pra não perder
    buffer = events.concat(buffer);
    return { sent: false, error: err.message, count: events.length };
  }
}

module.exports = { enqueue, flush, size };
