/**
 * Journalisation de l'approbation par QR dans `userAccess`.
 *
 * Faux pool et faux services injectés dans `require.cache` avant le chargement
 * du contrôleur (modèle de `src/controllers/authDeviceBinding.test.js`).
 *
 * Ce qu'il prouve, et pourquoi ça vaut un test à soi :
 *
 *  1. Une approbation laisse une trace, `origine = 'qr'`. Elle n'en laissait
 *     aucune : sept appareils s'étaient enrôlés par QR sans apparaître ni dans
 *     l'historique des connexions, ni dans les analytics.
 *  2. La trace décrit le téléphone DEMANDEUR — celui qui a affiché le QR — et
 *     non celui qui approuve. C'est le piège du chemin : la requête HTTP est
 *     émise par l'approbateur, donc `req.ip` et son User-Agent sont ceux du
 *     mauvais appareil. Le test leur donne exprès des valeurs reconnaissables
 *     et vérifie qu'aucune ne ressort.
 *  3. Une session expirée pendant la confirmation ne journalise rien : rien ne
 *     s'est ouvert, la ligne `appareils` est même supprimée.
 */
process.env.JWT_SECRET = 'secret-de-test-qrAuthAccessLog';

const assert = require('assert');

/* ── Le demandeur et l'approbateur, volontairement dissemblables ────────── */

const DEMANDEUR = {
  deviceId: 'hw-demandeur-001',
  deviceName: 'Pixel 8',
  platform: 'android',
  ipAddress: '41.202.0.7',
};

const APPROBATEUR = {
  ip: '10.0.0.1',
  userAgent: 'Dart/3.0 (dart:io)',
  deviceName: 'iPhone 15',
};

/* ── Faux pool : répond selon la requête, pas selon un ordre d'appel ────── */
const dbPath = require.resolve('../config/db');
let requetes = [];

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    requetes.push({ sql: texte, params });
    if (/FROM users u LEFT JOIN user_presence/.test(texte)) {
      return [[{ alanyaID: 7, nom: 'Awa', pseudo: 'awa', alanyaPhone: '12345678',
                 email: 'awa@example.com', avatar_url: null, is_online: 0 }], []];
    }
    if (/INSERT INTO userAccess/.test(texte)) return [{ insertId: 1 }, []];
    return [[], []];
  },
};
const poser = (chemin, exports) => {
  require.cache[chemin] = {
    id: chemin, filename: chemin, loaded: true, exports, paths: [], children: [],
  };
};
poser(dbPath, fakePool);

/* ── La session QR, pilotée par le test ─────────────────────────────────── */
let sessionApprouvee = true;   // `approve` rend-elle vrai ? (faux = expirée)
let journal = [];

poser(require.resolve('../socket/state/qrLoginSessions'), {
  get: async () => ({
    sessionId: 'sess-1',
    scanSecret: 'secret',
    status: 'scanned',
    ...DEMANDEUR,
  }),
  beginApproval: async (sessionId) => ({ sessionId }),
  abortApproval: async () => { journal.push({ appel: 'abortApproval' }); },
  approve: async () => sessionApprouvee,
});

poser(require.resolve('../services/deviceSessionService'), {
  recordLogin: async (args) => { journal.push({ appel: 'recordLogin', args }); return 42; },
  normalizePlatform: (p) => String(p || 'unknown').toLowerCase(),
});

poser(require.resolve('../utils/userSocketRegistry'), {
  emitToUser: () => {},
  disconnectAppareilSockets: async () => 0,
});

poser(require.resolve('../utils/qrToken'), {
  loginPayload: () => 'payload',
  secretMatches: () => true,
});

poser(require.resolve('../services/ipGeoService'), {
  lookupLocation: async () => null,
});

poser(require.resolve('../middleware/authCustom'), {
  generateAccessToken: () => 'access',
  generateRefreshToken: () => 'refresh',
  JWT_REFRESH_SECRET: 'refresh-secret',
});

const { approveQrSession } = require('./qrAuthController');

/* ── Plomberie Express ──────────────────────────────────────────────────── */

const fausseReponse = () => {
  const res = { code: 200, corps: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (c) => { res.corps = c; return res; };
  return res;
};

const requete = () => ({
  params: { sessionId: 'sess-1' },
  body: { scanSecret: 'secret', deviceName: APPROBATEUR.deviceName },
  user: { alanyaID: 7 },
  ip: APPROBATEUR.ip,
  headers: { 'user-agent': APPROBATEUR.userAgent },
  connection: {},
  app: { get: () => null },
});

/** Laisse partir les écritures « au mieux » (userAccess) avant d'observer. */
const vidangerAsync = () => new Promise((r) => setImmediate(r));

const approuver = async () => {
  requetes = []; journal = [];
  const res = fausseReponse();
  await approveQrSession(requete(), res);
  await vidangerAsync();
  return res;
};

const traceAcces = () => requetes.find((r) => /INSERT INTO userAccess/.test(r.sql));

(async () => {
  /* ── 1. L'approbation est journalisée ─────────────────────────────────── */
  let res = await approuver();
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(res.corps, { ok: true });

  const trace = traceAcces();
  assert.ok(trace, 'une approbation par QR laisse une trace dans userAccess');

  // Ordre des paramètres : alanyaID, device, ipAdress, os_system, origine.
  const [alanyaID, device, ip, os, origine] = trace.params;
  assert.strictEqual(alanyaID, 7);
  assert.strictEqual(origine, 'qr');

  /* ── 2. C'est le DEMANDEUR qui est décrit, pas l'approbateur ──────────── */
  assert.strictEqual(device, DEMANDEUR.deviceName);
  assert.strictEqual(ip, DEMANDEUR.ipAddress);
  assert.notStrictEqual(ip, APPROBATEUR.ip);
  assert.notStrictEqual(device, APPROBATEUR.deviceName);

  // 'android' est capitalisé en 'Android' : le camembert des analytics range
  // les valeurs inconnues telles quelles, deux casses feraient deux parts.
  assert.strictEqual(os, 'Android');

  // Et l'appareil enrôlé est bien le même que celui qu'on vient de décrire.
  const enrolement = journal.find((j) => j.appel === 'recordLogin');
  assert.strictEqual(enrolement.args.deviceId, DEMANDEUR.deviceId);
  assert.strictEqual(enrolement.args.loginMethod, 'qr');

  /* ── 3. Session expirée pendant la confirmation : aucune trace ────────── */
  sessionApprouvee = false;
  res = await approuver();
  assert.strictEqual(res.code, 410);
  assert.strictEqual(res.corps.code, 'QR_SESSION_EXPIRED');
  assert.strictEqual(
    traceAcces(), undefined,
    'une session expirée n’ouvre rien, donc ne journalise aucune connexion',
  );
  assert.ok(
    requetes.some((r) => /DELETE FROM appareils/.test(r.sql)),
    'la ligne appareils orpheline est bien supprimée',
  );

  console.log('✓ qrAuthAccessLog : approbation tracée, appareil demandeur et non approbateur, session expirée muette');
})().catch((e) => { console.error(e); process.exit(1); });
