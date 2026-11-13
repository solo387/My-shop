// Paystack: customers pay the MoMo amount on Paystack's secure page; Paystack tells us when it succeeds.
const crypto = require('crypto');
const config = require('./config');

async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch(config.paystack.baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${config.paystack.secretKey}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) throw new Error(j.message ? `Paystack: ${j.message}` : `Paystack did not respond (${r.status})`);
  return j.data;
}

// amount is in pesewas, which is what Paystack expects for GHS.
const initialize = ({ email, amount, reference, callbackUrl, metadata }) => call('/transaction/initialize', {
  method: 'POST',
  body: { email, amount: String(amount), currency: 'GHS', reference, callback_url: callbackUrl, channels: ['mobile_money'], metadata: JSON.stringify(metadata || {}) },
});
const verify = reference => call(`/transaction/verify/${encodeURIComponent(reference)}`);

// Webhooks are signed with HMAC-SHA512 of the raw request body using the secret key.
function validSignature(rawBody, signature) {
  if (!config.paystack.enabled || typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha512', config.paystack.secretKey).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()));
}

module.exports = { initialize, verify, validSignature };
