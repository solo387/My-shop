// Settings that differ between your computer and a hosted server.
// Put them in a file called .env next to server.js (see .env.example), or set them as
// environment variables on your hosting provider. Environment variables win over .env.
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const env = process.env;
const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
const bool = (v, d) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v);

const config = {
  root: ROOT,
  port: Number(env.PORT) || 4080,
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  publicUrl,                                             // e.g. https://myshop.onrender.com
  secure: publicUrl.startsWith('https://'),              // HTTPS cookies, HSTS and redirects
  trustProxy: bool(env.TRUST_PROXY, publicUrl.startsWith('https://')),  // behind Render/Railway/Nginx
  paystack: {
    secretKey: env.PAYSTACK_SECRET_KEY || '',
    baseUrl: (env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/+$/, ''),
  },
  backupDays: Number(env.BACKUP_DAYS) || 14,
};
config.paystack.enabled = /^sk_(test|live)_/.test(config.paystack.secretKey);
config.paystack.mode = config.paystack.enabled ? (config.paystack.secretKey.startsWith('sk_live_') ? 'live' : 'test') : 'off';
module.exports = config;
