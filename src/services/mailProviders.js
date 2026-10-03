// Fournisseurs d'envoi : un adaptateur par service, tous de la forme
// `async ({ from, to, subject, text, html }) => { id }`. `from` est une chaîne
// `"Nom" <adresse>` ou une adresse seule. Une erreur lève un Error portant
// `status` (HTTP) et `provider`.

const TIMEOUT_MS = Number(process.env.MAIL_HTTP_TIMEOUT_MS || 10000);

// `"Alanya" <info@alanya.cloud>` -> { name: 'Alanya', email: 'info@alanya.cloud' }
const parseAddress = (value) => {
  const raw = String(value || '').trim();
  const m = raw.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: raw };
};

const postJson = async (provider, url, headers, body) => {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = new Error(`${provider}: ${err && err.message ? err.message : err}`);
    e.provider = provider;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
};

const failure = (provider, res, detail) => {
  const e = new Error(`${provider}: HTTP ${res.status} ${detail || ''}`.trim());
  e.provider = provider;
  e.status = res.status;
  return e;
};

const postmark = {
  name: 'postmark',
  isConfigured: () => Boolean(process.env.POSTMARK_SERVER_TOKEN),
  send: async ({ from, to, subject, text, html }) => {
    const { res, data } = await postJson(
      'postmark',
      process.env.POSTMARK_API_URL || 'https://api.postmarkapp.com/email',
      { 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN },
      {
        From: from,
        To: to,
        Subject: subject,
        TextBody: text,
        HtmlBody: html,
        MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
      },
    );
    // Postmark répond 200 avec ErrorCode 0 en cas de succès.
    if (!res.ok || (data.ErrorCode && data.ErrorCode !== 0)) {
      throw failure('postmark', res, `${data.ErrorCode ?? ''} ${data.Message ?? ''}`);
    }
    return { id: data.MessageID };
  },
};

const bird = {
  name: 'bird',
  isConfigured: () => Boolean(process.env.BIRD_API_KEY),
  send: async ({ from, to, subject, text, html }) => {
    // La région suit la clé : bk_us1_... -> us1, bk_eu1_... -> eu1.
    const region = process.env.BIRD_REGION || 'us1';
    const base = process.env.BIRD_API_URL || `https://${region}.platform.bird.com`;
    const sender = parseAddress(from);
    const { res, data } = await postJson(
      'bird',
      `${base}/v1/email/messages`,
      { Authorization: `Bearer ${process.env.BIRD_API_KEY}` },
      {
        from: sender.name ? { email: sender.email, name: sender.name } : { email: sender.email },
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        // Sans ce champ, Bird classe l'envoi en `marketing` : désabonnement,
        // coupe-circuit sur plaintes, et Gmail le range en promotions ou spam.
        category: 'transactional',
      },
    );
    // 202 Accepted : l'envoi est asynchrone.
    if (!res.ok) {
      throw failure('bird', res, data.message || data.error || '');
    }
    return { id: data.id };
  },
};

// Gardé pour revenir en arrière en une ligne de configuration (MAIL_PROVIDERS=smtp).
let smtpTransporter = null;
const smtp = {
  name: 'smtp',
  isConfigured: () => Boolean(process.env.SMTP_HOST),
  send: async ({ from, to, subject, text, html }) => {
    if (!smtpTransporter) {
      smtpTransporter = require('nodemailer').createTransport({
        pool: true,
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
    }
    const info = await smtpTransporter.sendMail({ from, to, subject, text, html });
    return { id: info.messageId };
  },
};

module.exports = { postmark, bird, smtp, parseAddress };
