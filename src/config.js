// Configuração centralizada do Zé Bot
// Porta a lógica do ZE-CONFIG — único source of truth para todos os módulos
'use strict';

require('dotenv').config();

// Mapeamento número → nome (formato E164 sem +)
const TEAM_MAP = {
  '5561999393066': 'Thiago',
  '5519978092845': 'Alvaro',
  '5519978038392': 'Crissa',
  '5585921701132': 'Luan',
  '5519997867826': 'Lucca',
  '5585989920539': 'Chardson',
  '5519994026556': 'Paula',
  '556191291292':  'Joao'   // João financeiro (12 dígitos — getCandidates testa o 13d automaticamente)
};

// Mapeamento nome → número (para alertas e envios direcionados)
const TEAM_PHONES = {
  'Thiago':   '5561999393066',
  'Alvaro':   '5519978092845',
  'Álvaro':   '5519978092845',
  'Crissa':   '5519978038392',
  'Luan':     '5585921701132',
  'Lucca':    '5519997867826',
  'Chardson': '5585989920539',
  'Paula':    '5519994026556',
  'Joao':     '556191291292',
  'João':     '556191291292'
};

// Projetos válidos para classificação de intenção
const PROJECTS = ['ANMV', 'COMPORT', 'FOCO', 'KING', 'MAP', 'MELANIE', 'SIRIUS', 'VH'];

// System prompt de personalidade do Zé (Sonnet)
const PERSONALITY_PROMPT = `Voce e o Ze, assistente operacional da Sirius Digital no WhatsApp.

PERSONALIDADE:
- Direto e objetivo: responda em no maximo 3 linhas antes das sugestoes
- Humor leve quando apropriado: "Bora! Menos uma pendencia!", "Fechou!", "Eita, esse prazo ja era"
- Girias regionais brasileiras naturais: tranquilo, beleza, bora, fechou, da uma olhada, manda ver
- Use 1-2 emojis por mensagem, maximo. Nada exagerado.
- Trate cada pessoa pelo primeiro nome
- Quando marca tarefa como feita: comemore brevemente ("Bora! Uma a menos!")
- Quando cobra atraso: firme mas amigavel, nunca passivo-agressivo
- NUNCA invente dados — se nao sabe, diga que nao sabe
- Tom geral: como um colega de trabalho eficiente e gente boa

FORMATO:
1. Confirmacao da acao (se houve)
2. Informacao contextual relevante
3. 2-3 sugestoes especificas do que fazer em seguida
4. Se tarefa mencionada, incluir link do dash

FORMATACAO WhatsApp: *negrito*, _italico_, ~riscado~
Responda SOMENTE a mensagem final. Sem JSON, sem markdown complexo.

REGRA CRITICA - menus:
- NUNCA use menus numerados (1/2/3) para perguntar o que o usuario quer fazer. Se precisar de esclarecimento sobre a acao, pergunte com palavras-chave em negrito: "quer *cadastrar*, *atualizar* ou *concluir*?"
- Se o usuario mandar so um numero (1, 2, 3...) sem contexto claro: responda "Nao entendi o que esse numero significa. Pode me dizer com palavras o que quer fazer?"
- Para listar tarefas encontradas e pedir escolha, use letras (a, b, c) em vez de numeros.`;

module.exports = {
  // Credenciais via variáveis de ambiente (nunca hardcoded)
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY:    process.env.OPENAI_API_KEY,

  EVOLUTION_API_URL:  process.env.EVOLUTION_API_URL  || 'https://evolution.siriusagencyad.com',
  EVOLUTION_API_KEY:  process.env.EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || 'sirius',

  SHEETS_PROXY_URL:   process.env.SHEETS_PROXY_URL   || 'https://dashboard-crmrvs.vercel.app/api/sheets-proxy',
  DASHBOARD_URL:      'https://siriuspetvet.com.br/dash/',
  ZE_BOT_PUBLIC_URL:  process.env.ZE_BOT_PUBLIC_URL  || '', // Ex: https://ze-bot.seudominio.com

  /**
   * Gera link direto para uma tarefa específica no dashboard
   * @param {object|string} taskOrId - Objeto tarefa (com campo id) ou string com ID
   * @returns {string} URL com ?task=ID ou URL geral se sem ID
   */
  taskLink(taskOrId) {
    const id = typeof taskOrId === 'string' ? taskOrId : (taskOrId && taskOrId.id);
    if (id) return `https://siriuspetvet.com.br/dash/?task=${encodeURIComponent(id)}`;
    return 'https://siriuspetvet.com.br/dash/';
  },

  ADMIN_GROUP_ID: process.env.ADMIN_GROUP_ID || '120363292789288311@g.us',
  BOT_NUMBER:     process.env.BOT_NUMBER     || '5519991926365',
  ADMIN_PHONE:    process.env.ADMIN_PHONE    || '5561999393066',

  // Comport Ensino — notificações de venda
  COMPORT_GROUP_ID:            process.env.COMPORT_GROUP_ID || '120363407220592822@g.us',
  COMPORT_GESTAO_PRODUCT_NAME: 'Gestão meu Negócio Pet',
  COMPORT_SUPPORT_PHONE:       '5511995417981', // Caio — onboarding

  // Co-gestores: recebem relatórios, escalações e alertas críticos
  // Thiago (CEO) + Chardson (gerente geral em treinamento)
  MANAGERS: [
    process.env.ADMIN_PHONE || '5561999393066',
    '5585989920539'
  ],

  PORT: parseInt(process.env.PORT || '3010', 10),

  // Modelos de IA
  HAIKU_MODEL:  'claude-haiku-4-5',
  SONNET_MODEL: 'claude-sonnet-4-6',

  // Dados do time
  TEAM_MAP,
  TEAM_PHONES,
  PROJECTS,
  PERSONALITY_PROMPT,

  CONFIG_VERSION: '1.1.0'
};
