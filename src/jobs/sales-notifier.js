// Notificador de vendas — porta o ZE-SALES
// Recebe webhook de Hotmart/Eduzz e posta no grupo admin
// Exposto como handler Express (não cron) — chamado pelo server.js
'use strict';

const evolution = require('../clients/evolution');
const sheets    = require('../clients/sheets');
const config    = require('../config');

const CAIO_JID = `${config.COMPORT_SUPPORT_PHONE}@s.whatsapp.net`;

const SHEET_LOG = 'ZE_LOG';

// Taxas de câmbio aproximadas para conversão para BRL
const FX_RATES = { USD: 5.8, EUR: 6.3, MXN: 0.29, CLP: 0.006, COP: 0.0015, ARS: 0.006 };

// Emojis por país
const COUNTRY_EMOJI = {
  BR: '🇧🇷', MX: '🇲🇽', CO: '🇨🇴', AR: '🇦🇷', CL: '🇨🇱',
  PE: '🇵🇪', EC: '🇪🇨', VE: '🇻🇪', UY: '🇺🇾', PY: '🇵🇾'
};

/**
 * Normaliza payload de Hotmart ou Eduzz para formato padrão
 * @param {object} body - Payload bruto do webhook
 * @param {object} headers - Headers da requisição
 * @returns {object} Dados normalizados da venda
 */
function normalizePayload(body, headers) {
  // HOTMART: header x-hotmart-hottok ou campo data.purchase
  if (headers['x-hotmart-hottok'] || body.hottok || body.data?.purchase) {
    const d = body.data || body;
    const purchase = d.purchase || {};
    const buyer    = d.buyer    || {};
    const product  = d.product  || {};
    return {
      platform:         'HOTMART',
      status:           (purchase.status || '').toLowerCase(),
      orderId:          purchase.transaction || purchase.order_id || '',
      productName:      product.name || '',
      buyerName:        buyer.name || '',
      buyerEmail:       buyer.email || '',
      buyerCountry:     buyer.address?.country_iso || '',
      value:            purchase.price?.value || 0,
      currency:         purchase.price?.currency_value || 'BRL',
      commissionValue:  purchase.commission?.value || 0,
      paymentMethod:    purchase.payment?.type || '',
      eventType:        body.event || 'PURCHASE_COMPLETE'
    };
  }

  // EDUZZ: campo trans_status ou sale_id
  if (body.trans_status !== undefined || body.sale_id || body.NUT !== undefined) {
    return {
      platform:        'EDUZZ',
      status:          String(body.trans_status || '').toLowerCase(),
      orderId:         String(body.sale_id || body.trans_cod || ''),
      productName:     body.NomeconteudoNutror || body.content_title || '',
      buyerName:       body.NomeclienteNutror  || body.cus_name || '',
      buyerEmail:      body.EmailclienteNutror || body.cus_email || '',
      buyerCountry:    body.cus_address_country || 'BR',
      value:           parseFloat(body.VendasalidaNutror || body.net_amount || 0),
      currency:        'BRL',
      commissionValue: 0,
      paymentMethod:   body.payment_method || '',
      eventType:       String(body.trans_status || '')
    };
  }

  // Payload genérico
  return {
    platform:        'GENERIC',
    status:          (body.status || body.event || 'unknown').toLowerCase(),
    orderId:         body.order_id || body.transaction_id || body.id || '',
    productName:     body.product_name || body.product || '',
    buyerName:       body.buyer_name || body.name || '',
    buyerEmail:      body.buyer_email || body.email || '',
    buyerCountry:    body.country || 'BR',
    value:           parseFloat(body.value || body.amount || body.price || 0),
    currency:        body.currency || 'BRL',
    commissionValue: 0,
    paymentMethod:   body.payment || '',
    eventType:       body.event || body.type || ''
  };
}

/**
 * Formata valor monetário com conversão para BRL
 */
function formatValue(value, currency) {
  const num = parseFloat(value);
  if (!value || isNaN(num)) return 'R$ --';
  if (currency === 'BRL') return `R$ ${num.toFixed(2)}`;
  const brl = num * (FX_RATES[currency] || 1);
  return `${currency} ${num.toFixed(2)} (~R$ ${brl.toFixed(2)})`;
}

/**
 * Processa evento de venda — chamado pelo endpoint POST /webhook/ze-sale-event
 * @param {object} body - Payload bruto
 * @param {object} headers - Headers da requisição
 * @returns {Promise<void>}
 */
async function handleSaleEvent(body, headers) {
  const sale = normalizePayload(body, headers);

  // Processar apenas vendas aprovadas
  if (sale.status !== 'approved') {
    console.log(`[sales-notifier] Venda ignorada (status: ${sale.status})`);
    return;
  }

  // Formatar mensagem
  const platformEmoji = { HOTMART: '🔥', EDUZZ: '⚡', GENERIC: '💰' };
  const emoji         = platformEmoji[sale.platform] || '💰';
  const flagEmoji     = COUNTRY_EMOJI[(sale.buyerCountry || '').toUpperCase()] || '🌎';
  const productShort  = (sale.productName || '').length > 40 ? sale.productName.slice(0, 37) + '...' : sale.productName;
  const buyerFirst    = sale.buyerName ? sale.buyerName.split(' ')[0] : 'Cliente';

  const msg = `${emoji} *NOVA VENDA!*\n\n` +
    `📦 ${productShort}\n` +
    `👤 ${buyerFirst} ${flagEmoji} ${sale.buyerCountry || ''}\n` +
    `💵 ${formatValue(sale.value, sale.currency)}` +
    (sale.commissionValue > 0 ? ` (comissão: R$ ${parseFloat(sale.commissionValue).toFixed(2)})` : '') + '\n' +
    (sale.paymentMethod ? `💳 ${sale.paymentMethod}\n` : '') +
    `\n🎉 Bora, time!`;

  // Postar no grupo admin (Sirius)
  await evolution.sendText(config.ADMIN_GROUP_ID, msg);

  // Se for venda do Gestão meu Negócio Pet → avisar grupo Comport com menção ao Caio
  const isGestao = sale.productName.includes(config.COMPORT_GESTAO_PRODUCT_NAME);

  if (isGestao) {
    const comportMsg =
      `🎉 *VENDA GESTÃO MEU NEGÓCIO PET!*\n\n` +
      `👤 ${buyerFirst} ${flagEmoji} acaba de comprar!\n\n` +
      `@${config.COMPORT_SUPPORT_PHONE} — favor fazer o onboarding o quanto antes! 🚀`;

    await evolution.sendTextWithMentions(
      config.COMPORT_GROUP_ID,
      comportMsg,
      [CAIO_JID]
    );
    console.log(`[sales-notifier] Notificação Comport enviada para ${config.COMPORT_GROUP_ID}`);
  }

  // Log da venda
  sheets.post({
    sheetName: SHEET_LOG,
    values: [
      new Date().toISOString(), 'system', 'sale_event',
      sale.platform, sale.orderId, sale.productName,
      sale.buyerName, `${sale.value} ${sale.currency}`, sale.buyerCountry
    ]
  }).catch(e => console.warn('[sales-notifier] Erro ao logar venda:', e.message));

  console.log(`[sales-notifier] Venda ${sale.platform} ${sale.orderId} processada`);
}

module.exports = { handleSaleEvent };
