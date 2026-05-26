// Handler do intent update_contexto — atualiza CONTEXTO_VIVO via WhatsApp
// Fluxo: handle() valida + propõe confirmação · execute() aplica após "sim"
// Permissão: sender precisa estar em algum role de responsaveis[] do slug
'use strict';

const sheets = require('../clients/sheets');
const taskConfirm = require('./task-confirm');

// Projeto (do Haiku) → slug (chave da aba CONTEXTO_VIVO)
const PROJECT_TO_SLUG = {
  MELANIE: 'mel', COMPORT: 'comport', FOCO: 'foco-vet', MAP: 'map',
  VH: 'vh', KING: 'king', ANMV: 'anmv', SIRIUS: 'sirius',
  NAVES: 'naves', 'LT-PNEUS': 'lt-pneus',
};

// Por campo: default de modo (append vs replace) + label legível pra mensagem
const FIELD_CONFIG = {
  contexto:        { mode: 'replace', label: 'contexto',         array: false },
  proximas_acoes:  { mode: 'append',  label: 'próxima ação',     array: true  },
  decisoes:        { mode: 'append',  label: 'decisão',          array: true  },
  blockers:        { mode: 'append',  label: 'blocker',          array: true  },
  alertas:         { mode: 'append',  label: 'alerta',           array: true  },
  entregaveis:     { mode: 'replace', label: 'entregáveis',      array: true  },
  foraDoEscopo:    { mode: 'replace', label: 'fora do escopo',   array: true  },
  contatos:        { mode: 'replace', label: 'contatos',         array: true  },
  ofertaPrincipal: { mode: 'replace', label: 'oferta principal', array: false },
};

const VALID_FIELDS = Object.keys(FIELD_CONFIG);

// Pessoa do TEAM_MAP (ex "Thiago") pode aparecer no responsaveis como "Thiago Pastana"
function isResponsavel(person, responsaveis) {
  if (!person || !responsaveis) return false;
  const p = String(person).toLowerCase();
  return Object.values(responsaveis).some(name =>
    String(name || '').toLowerCase().includes(p)
  );
}

/**
 * Propõe a alteração ao usuário (salva pending + retorna mensagem de confirmação)
 */
async function handle(ctx) {
  const { intent, person, senderNumber } = ctx;
  const project = (intent.project || '').toUpperCase();
  const slug = PROJECT_TO_SLUG[project];

  if (!slug) {
    return {
      actionResult: 'project_unknown',
      actionMessage: `Qual projeto? Diga assim: "blocker no FOCO: <texto>".\n\nProjetos: ${Object.keys(PROJECT_TO_SLUG).join(', ')}`
    };
  }

  const field = intent.contextField;
  const value = String(intent.contextValue || '').trim();
  const explicitMode = intent.contextMode;

  if (!field || !VALID_FIELDS.includes(field)) {
    return {
      actionResult: 'field_unknown',
      actionMessage: `Não entendi qual campo do contexto atualizar. Campos: ${VALID_FIELDS.join(', ')}.`
    };
  }
  if (!value) {
    return {
      actionResult: 'value_missing',
      actionMessage: `Faltou o conteúdo. Ex: "blocker no ${project}: <descrição>".`
    };
  }

  let map;
  try {
    map = await sheets.getContextoVivo();
  } catch (err) {
    console.error('[update-contexto] Erro ao ler contexto:', err.message);
    return {
      actionResult: 'read_error',
      actionMessage: 'Não consegui ler o Contexto Vivo agora. Tenta de novo em 1 min?'
    };
  }

  const current = map[slug];
  if (!current) {
    return {
      actionResult: 'slug_not_found',
      actionMessage: `Não achei *${project}* no Contexto Vivo. Cria primeiro pelo painel.`
    };
  }

  if (!isResponsavel(person, current.responsaveis)) {
    const resps = Object.entries(current.responsaveis || {})
      .map(([role, name]) => `${role}: ${name}`).join(' · ');
    return {
      actionResult: 'forbidden',
      actionMessage: `Só responsáveis podem atualizar contexto de *${project}*.\n\nResponsáveis: ${resps || '(nenhum cadastrado)'}.`
    };
  }

  const mode = (explicitMode === 'replace' || explicitMode === 'append')
    ? explicitMode
    : FIELD_CONFIG[field].mode;

  await taskConfirm.savePendingContexto(senderNumber, {
    slug, project, field, value, mode, cliente: current.cliente
  });

  const label = FIELD_CONFIG[field].label;
  const verb = mode === 'append' ? 'adicionar em' : 'substituir';
  const preview = value.length > 120 ? value.slice(0, 120) + '…' : value;

  return {
    actionResult: 'confirm_required',
    actionMessage: `Vou *${verb} ${label}* de *${project}*:\n\n_"${preview}"_\n\nConfirma? *sim* ou *não*`
  };
}

/**
 * Executa o update após o "sim". Re-lê estado atual (upsertContexto sobrescreve linha inteira).
 * @param {object} data - { slug, project, field, value, mode }
 */
async function execute(data) {
  const { slug, project, field, value, mode } = data;

  const map = await sheets.getContextoVivo();
  const current = map[slug];
  if (!current) {
    return {
      actionResult: 'slug_not_found',
      actionMessage: `Contexto de *${project}* sumiu. Tenta de novo?`
    };
  }

  const cfg = FIELD_CONFIG[field];
  if (!cfg) {
    return {
      actionResult: 'field_unknown',
      actionMessage: `Campo inválido: ${field}`
    };
  }

  const payload = {
    slug,
    cliente: current.cliente,
    data_reuniao: current.data_reuniao,
    proximas_acoes: current.proximas_acoes,
    decisoes: current.decisoes,
    blockers: current.blockers,
    contexto: current.contexto,
    alertas: current.alertas,
    entregaveis: current.entregaveis,
    foraDoEscopo: current.foraDoEscopo,
    contatos: current.contatos,
    ofertaPrincipal: current.ofertaPrincipal,
    responsaveis: current.responsaveis,
    status: current.status,
  };

  if (cfg.array) {
    const arr = Array.isArray(payload[field]) ? payload[field] : [];
    payload[field] = mode === 'append' ? [...arr, value] : [value];
  } else {
    payload[field] = value;
  }

  await sheets.upsertContexto(payload);

  return {
    actionResult: 'contexto_updated',
    actionMessage: `✅ Contexto de *${project}* atualizado (${cfg.label}).`,
    groupNotification: {
      project,
      field,
      fieldLabel: cfg.label,
      value,
      mode,
    }
  };
}

module.exports = { handle, execute, PROJECT_TO_SLUG, FIELD_CONFIG, VALID_FIELDS, isResponsavel };
