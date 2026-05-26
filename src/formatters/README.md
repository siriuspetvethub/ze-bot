# Zé Bot — Formatters

Utilities pra envelopar mensagens do Zé com identidade visual Sirius padronizada.

## `sirius-frame.js`

Centraliza o frame visual (header + footer) das mensagens enviadas pelo Zé pra grupos e DMs.

### Uso

```js
const { frame } = require('../formatters/sirius-frame');

const msg = frame({
  contextLabel: 'Briefing · 08h',     // rótulo do contexto (vai virar CAIXA-ALTA no header)
  body: 'Oi, *Thiago*. ...',          // corpo já em sintaxe WhatsApp (*bold*, _italic_)
  linkLabel: 'painel operacional',    // (opcional) rótulo do link no footer
  link: config.DASHBOARD_URL,         // (opcional) URL do link
});

await evolution.sendText(phone, msg);
```

### Output

```
*✦ BRIEFING · 08H*
━━━━━━━━━━━━━━

Oi, *Thiago*. Acabei de subir as tarefas da daily de hoje.
[...]

━━━━━━━━━━━━━━
_zé · sirius · ↗ painel operacional_
https://siriuspetvet.com.br/dash/
```

### Opt-out via env

Em emergência (mensagem quebrando, fallback urgente):

```bash
ZE_FRAME=false
```

Com o flag, `frame()` retorna só o `body` cru — sem header/footer. Pode ser ativado sem deploy nem mudança de código.

### Convenções de contextLabel

| Contexto | contextLabel | linkLabel sugerido |
|---|---|---|
| Briefing matinal pós-daily | `Briefing · 08h` | `painel operacional` |
| Alerta matinal individual | `Alerta matinal · 08h` | `painel operacional` |
| Relatório diário 19h | `Relatório · 19h` | `painel operacional` |
| Tarefa travada urgente | `Alerta · travada` | `abrir tarefa` |
| Alerta de atraso | `Alerta · atraso` | `abrir tarefa` |
| Venda nova | `Venda · novo lead` | `abrir lead` |
| Watchdog/reconexão | `Sistema · status` | (sem link) |

### Quem está usando

Atualizado em 2026-05-19:
- `src/jobs/daily-briefing.js` — briefing pós-daily
- `src/jobs/alert-engine.js` — runMorning (alerta matinal 08h)
- `src/jobs/report.js` — buildReportMessage (relatório 19h)

Outros handlers do `alert-engine.js` (watchdog, project inactivity, no-owner, stalled approvals, etc) **ainda não usam** o frame. Podem migrar incrementalmente.

### Risco de mudança

`sirius-frame.js` só monta string — não toca em URLs internas (`config.taskLink(t)`), prioridade, deadline ou parsing downstream. Mudanças no frame **não quebram** o handler de confirmação (task-confirm.js) porque ele lê o body do usuário, não as mensagens enviadas pelo Zé.

Para rollback rápido sem deploy: `ZE_FRAME=false` no env do EasyPanel.
