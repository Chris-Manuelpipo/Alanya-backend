/**
 * Envoi des courriels : Postmark d'abord, Bird en secours.
 *
 * `fetch` est remplacé : aucun appel réseau, aucun jeton réel.
 */
const assert = require('assert');

process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.BIRD_API_KEY = 'bk_us1_test';
process.env.MAIL_FROM = 'info@alanya.cloud';
process.env.MAIL_FROM_NAME = 'Alanya';
delete process.env.MAIL_PROVIDERS;
delete process.env.SMTP_HOST;

const appels = [];
let reponses = [];
global.fetch = async (url, opts) => {
  appels.push({ url, opts, body: JSON.parse(opts.body) });
  const r = reponses.shift();
  return { ok: r.status < 300, status: r.status, json: async () => r.body };
};

const { sendMail, defaultFrom } = require('./mailService');
const { parseAddress } = require('./mailProviders');

const msg = { to: 'a@b.cm', subject: 'Code', text: 'txt', html: '<p>h</p>' };

(async () => {
  assert.strictEqual(defaultFrom(), '"Alanya" <info@alanya.cloud>');
  assert.deepStrictEqual(parseAddress('"Alanya" <info@alanya.cloud>'), { name: 'Alanya', email: 'info@alanya.cloud' });
  assert.deepStrictEqual(parseAddress('info@alanya.cloud'), { name: '', email: 'info@alanya.cloud' });

  // 1. Postmark accepte : Bird n'est pas appelé.
  reponses = [{ status: 200, body: { ErrorCode: 0, MessageID: 'pm-1' } }];
  let r = await sendMail(msg);
  assert.strictEqual(r.provider, 'postmark');
  assert.strictEqual(appels.length, 1);
  assert.strictEqual(appels[0].url, 'https://api.postmarkapp.com/email');
  assert.strictEqual(appels[0].opts.headers['X-Postmark-Server-Token'], 'pm-test-token');
  assert.strictEqual(appels[0].body.From, '"Alanya" <info@alanya.cloud>');
  assert.strictEqual(appels[0].body.HtmlBody, '<p>h</p>');

  // 2. Postmark refuse : Bird prend le relais.
  appels.length = 0;
  reponses = [
    { status: 422, body: { ErrorCode: 400, Message: 'Sender signature not confirmed' } },
    { status: 202, body: { id: 'em_1', status: 'accepted' } },
  ];
  r = await sendMail(msg);
  assert.strictEqual(r.provider, 'bird');
  assert.strictEqual(appels.length, 2);
  assert.strictEqual(appels[1].url, 'https://us1.platform.bird.com/v1/email/messages');
  assert.strictEqual(appels[1].opts.headers.Authorization, 'Bearer bk_us1_test');
  assert.deepStrictEqual(appels[1].body.from, { email: 'info@alanya.cloud', name: 'Alanya' });
  assert.deepStrictEqual(appels[1].body.to, ['a@b.cm']);
  assert.strictEqual(appels[1].body.category, 'transactional');

  // 3. Postmark répond 200 mais avec une ErrorCode : c'est un échec.
  appels.length = 0;
  reponses = [
    { status: 200, body: { ErrorCode: 406, Message: 'inactive recipient' } },
    { status: 202, body: { id: 'em_2' } },
  ];
  r = await sendMail(msg);
  assert.strictEqual(r.provider, 'bird');

  // 4. Les deux échouent : l'erreur dit pourquoi, pour les deux.
  reponses = [
    { status: 500, body: {} },
    { status: 429, body: { message: 'rate limited' } },
  ];
  await assert.rejects(() => sendMail(msg), (e) =>
    /postmark: HTTP 500/.test(e.message) && /bird: HTTP 429 rate limited/.test(e.message));

  // 5. Rien de configuré : refus net, sans appel.
  appels.length = 0;
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.BIRD_API_KEY;
  await assert.rejects(() => sendMail(msg), /pas configuré/);
  assert.strictEqual(appels.length, 0);

  console.log('mailService.test.js : ok');
})().catch((e) => { console.error(e); process.exit(1); });
