/**
 * Verrouillage de la connexion sur les appareils enrôlés : la garde de `login`
 * et la voie de secours de `completePasswordReset`.
 *
 * Faux pool et faux services injectés dans `require.cache` avant le chargement
 * du contrôleur (modèle de `src/controllers/meetingJoinStatus.test.js`). Aucune
 * base : les migrations 083 et 084 s'appliquent à la main, ce test doit passer
 * avant comme après.
 *
 * Ce qu'il prouve, dans l'ordre où ça compte :
 *
 *  1. Interrupteur éteint — rien ne change, y compris pour un appareil inconnu.
 *  2. Appareil connu — passe.
 *  3. Compte sans aucun appareil actif — passe, jamais d'impasse.
 *  4. Appareil inconnu sur un compte qui en a — 403 DEVICE_NOT_TRUSTED, et
 *     surtout : ni `fcm_token`, ni `device_ID`, ni ligne `appareils` touchés.
 *  5. Mot de passe faux — 401 avant même que la garde ne s'exprime.
 *  6. Réinitialisation SANS `hardware_id` — réponse d'avant, au caractère près
 *     (c'est ce que fait l'application déjà publiée).
 *  7. Réinitialisation AVEC `hardware_id` — enrôlement 'recovery', révocation
 *     des autres appareils, session ouverte, `user` de même forme qu'au login.
 */
process.env.JWT_SECRET = 'secret-de-test-authDeviceBinding';

const assert = require('assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/* ── Faux pool : répond selon la requête, pas selon un ordre d'appel ────── */
const dbPath = require.resolve('../config/db');
let requetes = [];
let compteAbsent = false;
let patchCompte = {};

const MOT_DE_PASSE = 'bon-mot-de-passe';
const HACHE = bcrypt.hashSync(MOT_DE_PASSE, 4);

const compte = () => ({
  alanyaID: 7,
  nom: 'Awa',
  pseudo: 'awa',
  alanyaPhone: '12345678',
  email: 'awa@example.com',
  password: HACHE,
  avatar_url: null,
  is_online: 0,
  last_seen: null,
  genre: 'femme',
  age: 30,
  annee_naissance: 1996,
  ville: 'Douala',
  exclus: 0,
  exclude_reason: null,
  delete_scheduled_at: null,
  ...patchCompte,
});

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    requetes.push({ sql: texte, params });
    if (/FROM users u LEFT JOIN user_presence/.test(texte)) {
      return [compteAbsent ? [] : [compte()], []];
    }
    // Compte officiel : il n'y en a pas dans ce scénario.
    if (/SELECT alanyaID FROM users WHERE account_type/.test(texte)) return [[], []];
    if (/INSERT INTO userAccess/.test(texte)) return [{ insertId: 1 }, []];
    return [[], []];
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

/* ── L'interrupteur, piloté par le test ────────────────────────────────── */
const reglagesPath = require.resolve('../services/securitySettingsService');
let verrouArme = false;
require.cache[reglagesPath] = {
  id: reglagesPath, filename: reglagesPath, loaded: true, paths: [], children: [],
  exports: {
    isDeviceBindingEnabled: async () => verrouArme,
    getSecuritySettings: async () => ({ device_binding_enabled: verrouArme ? 1 : 0 }),
    invalidateSecuritySettings: () => {},
    setDeviceBindingEnabled: async () => {},
  },
};

/* ── Le registre des appareils, observé ────────────────────────────────── */
const appareilsPath = require.resolve('../services/deviceSessionService');
let appareilConnu = false;
let appareilsActifs = 0;
let idEnrole = 55;
let journal = [];
let REVOQUES = [
  { id: 3, deviceId: 'materiel-vole' },
  { id: 9, deviceId: 'materiel-tablette' },
];
require.cache[appareilsPath] = {
  id: appareilsPath, filename: appareilsPath, loaded: true, paths: [], children: [],
  exports: {
    isTrustedDevice: async (alanyaID, deviceId) => {
      journal.push({ appel: 'isTrustedDevice', alanyaID, deviceId });
      return appareilConnu;
    },
    countActiveDevices: async (alanyaID) => {
      journal.push({ appel: 'countActiveDevices', alanyaID });
      return appareilsActifs;
    },
    recordLogin: async (args) => {
      journal.push({ appel: 'recordLogin', ...args });
      return idEnrole;
    },
    revokeAllExcept: async (alanyaID, appareilId) => {
      journal.push({ appel: 'revokeAllExcept', alanyaID, appareilId });
      return REVOQUES;
    },
    disconnectRevoked: async (io, alanyaID, appareils) => {
      journal.push({ appel: 'disconnectRevoked', io, alanyaID, appareils });
      return appareils.length;
    },
    touchLastActive: async () => {},
    normalizePlatform: (p) => p || 'unknown',
  },
};

// Le service de courriel ouvre un transporteur au chargement : hors sujet ici.
const mailPath = require.resolve('../services/mailService');
require.cache[mailPath] = {
  id: mailPath, filename: mailPath, loaded: true, paths: [], children: [],
  exports: { sendMail: async () => {}, renderHtmlEmail: () => '', escapeHtml: (s) => s },
};

const { login, completePasswordReset } = require('./authCustomController');

function fausseReponse() {
  return {
    code: 200,
    corps: null,
    status(c) { this.code = c; return this; },
    json(o) { this.corps = o; return this; },
  };
}

// `io` minimal : `login` émet déjà `auth:conflict` par cette voie, et la voie de
// secours doit y faire passer la fermeture des sockets révoquées.
const FAUX_IO = { to: () => ({ emit: () => {} }) };

const requete = (body) => ({
  body,
  headers: { 'user-agent': 'Dart/3.0 (dart:io)' },
  ip: '10.0.0.1',
  app: { get: (cle) => (cle === 'io' ? FAUX_IO : null) },
});

/** Laisse partir les écritures « au mieux » (userAccess) avant d'observer. */
const vidangerAsync = () => new Promise((r) => setImmediate(r));

const appeler = async (handler, body) => {
  requetes = [];
  journal = [];
  const res = fausseReponse();
  await handler(requete(body), res);
  await vidangerAsync();
  return res;
};

const CORPS_LOGIN = {
  alanyaPhone: '12345678',
  password: MOT_DE_PASSE,
  fcm_token: 'jeton-fcm',
  device_ID: 'appareil-1',
  hardware_id: 'materiel-1',
  device_model: 'Pixel 8',
  os_system: 'android',
};

const resetToken = () => jwt.sign(
  { alanyaID: 7, type: 'password_reset' },
  process.env.JWT_SECRET,
  { expiresIn: '15m' },
);

async function main() {
  /* ── 1. Interrupteur éteint : rien ne change ── */
  verrouArme = false;
  appareilConnu = false;
  appareilsActifs = 3;
  let res = await appeler(login, CORPS_LOGIN);
  assert.strictEqual(res.code, 200, 'verrou éteint : un appareil inconnu entre comme avant');
  assert.ok(res.corps.accessToken && res.corps.refreshToken);
  assert.strictEqual(
    journal.some((j) => j.appel === 'isTrustedDevice'), false,
    'verrou éteint : la garde ne doit même pas interroger le registre',
  );
  const formeLogin = Object.keys(res.corps.user).sort();
  assert.ok(!('password' in res.corps.user) && !('exclus' in res.corps.user));

  /* ── 2. Verrou armé, appareil connu : passe ── */
  verrouArme = true;
  appareilConnu = true;
  appareilsActifs = 3;
  res = await appeler(login, CORPS_LOGIN);
  assert.strictEqual(res.code, 200);
  const interroge = journal.find((j) => j.appel === 'isTrustedDevice');
  assert.strictEqual(interroge.deviceId, 'materiel-1', 'c’est le hardware_id qui identifie l’appareil');
  assert.strictEqual(
    journal.some((j) => j.appel === 'countActiveDevices'), false,
    'un appareil connu ne déclenche pas le comptage de secours',
  );

  /* ── 3. Verrou armé, appareil inconnu, compte sans appareil actif ── */
  // Sans cette branche, un compte dont tous les appareils ont été révoqués
  // n'aurait plus aucune porte : ni mot de passe, ni QR à approuver.
  appareilConnu = false;
  appareilsActifs = 0;
  res = await appeler(login, CORPS_LOGIN);
  assert.strictEqual(res.code, 200, 'aucun appareil actif : jamais d’impasse');
  assert.ok(res.corps.accessToken);

  /* ── 4. Verrou armé, appareil inconnu, compte pourvu : refus net ── */
  appareilConnu = false;
  appareilsActifs = 2;
  res = await appeler(login, CORPS_LOGIN);
  assert.strictEqual(res.code, 403);
  assert.strictEqual(res.corps.code, 'DEVICE_NOT_TRUSTED');
  assert.ok(!res.corps.accessToken, 'aucun token ne part avec un refus');

  // Le point le plus important du lot : un refus ne doit RIEN modifier. Un
  // appareil refusé qui aurait réécrit `users.fcm_token` recevrait les
  // notifications du compte — exactement ce que le verrou empêche.
  assert.deepStrictEqual(
    requetes.filter((r) => /^UPDATE users SET/.test(r.sql)), [],
    'un refus ne touche ni fcm_token ni device_ID',
  );
  assert.strictEqual(
    journal.some((j) => j.appel === 'recordLogin'), false,
    'un refus n’enrôle pas l’appareil qu’il vient de refuser',
  );
  // La tentative laisse une trace, distinguable d'une connexion réussie — non
  // par un préfixe dans le libellé, mais par la colonne `origine` (migration
  // 085). Ordre des paramètres : alanyaID, device, ipAdress, os_system, origine.
  const trace = requetes.find((r) => /INSERT INTO userAccess/.test(r.sql));
  assert.ok(trace, 'la tentative refusée est journalisée');
  assert.strictEqual(trace.params[4], 'refus');
  assert.strictEqual(trace.params[1], CORPS_LOGIN.device_model);

  /* ── 5. Mot de passe faux : 401, la garde ne parle pas avant bcrypt ── */
  // Répondre DEVICE_NOT_TRUSTED sans mot de passe valide dirait à un inconnu
  // quels appareils sont enrôlés sur un numéro Alanya, qui est public.
  res = await appeler(login, { ...CORPS_LOGIN, password: 'mauvais' });
  assert.strictEqual(res.code, 401);
  assert.strictEqual(res.corps.code, 'INVALID_CREDENTIALS');
  assert.strictEqual(
    journal.some((j) => j.appel === 'isTrustedDevice'), false,
    'la garde s’exécute APRÈS bcrypt.compare, jamais avant',
  );

  /* ── 6. Réinitialisation sans hardware_id : comportement d'avant ── */
  // C'est ce que fait l'application déjà publiée. La réponse doit rester
  // exactement `{ message }` : ni token, ni user, et aucune révocation.
  res = await appeler(completePasswordReset, {
    resetToken: resetToken(), newPassword: 'nouveau-mdp',
  });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(Object.keys(res.corps), ['message']);
  assert.strictEqual(res.corps.message, 'Password updated successfully');
  assert.deepStrictEqual(journal, [], 'aucun appareil enrôlé ni révoqué sans hardware_id');
  assert.ok(
    requetes.some((r) => /^UPDATE users SET password = \?, reset_otp = NULL/.test(r.sql)),
    'le mot de passe est bien changé, comme avant',
  );

  /* ── 7. Réinitialisation avec hardware_id : la voie de secours ── */
  res = await appeler(completePasswordReset, {
    resetToken: resetToken(),
    newPassword: 'nouveau-mdp',
    hardware_id: 'materiel-neuf',
    device_model: 'Pixel 9',
    os_system: 'android',
  });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.corps.message, 'Password updated successfully');
  assert.ok(res.corps.accessToken && res.corps.refreshToken, 'la session s’ouvre sans repasser par login');

  const enrolement = journal.find((j) => j.appel === 'recordLogin');
  assert.ok(enrolement, 'l’appareil de secours est enrôlé');
  assert.strictEqual(enrolement.loginMethod, 'recovery');
  assert.strictEqual(enrolement.deviceId, 'materiel-neuf');

  const revocation = journal.find((j) => j.appel === 'revokeAllExcept');
  assert.ok(revocation, 'les autres appareils sont révoqués');
  assert.deepStrictEqual([revocation.alanyaID, revocation.appareilId], [7, idEnrole]);
  assert.ok(
    journal.indexOf(enrolement) < journal.indexOf(revocation),
    'on enrôle d’abord, on révoque ensuite : l’inverse couperait l’appareil de secours',
  );

  // Révoquer en base n'arrête un appareil qu'à son prochain appel REST. Dans le
  // scénario du vol, qui est la raison d'être de cette porte, le voleur
  // garderait sa socket ouverte et continuerait de recevoir les messages.
  const coupure = journal.find((j) => j.appel === 'disconnectRevoked');
  assert.ok(coupure, 'les sockets des appareils révoqués sont fermées');
  assert.strictEqual(coupure.io, FAUX_IO, 'l’instance io est bien celle de la requête');
  assert.strictEqual(coupure.alanyaID, 7);
  assert.deepStrictEqual(coupure.appareils, REVOQUES, 'on coupe exactement ce qu’on a révoqué');
  assert.ok(
    journal.indexOf(revocation) < journal.indexOf(coupure),
    'on révoque en base d’abord : fermer avant laisserait l’appareil se reconnecter',
  );

  // Même forme d'utilisateur qu'au login : l'application lit le même objet
  // quelle que soit la porte d'entrée.
  assert.deepStrictEqual(Object.keys(res.corps.user).sort(), formeLogin);
  assert.ok(!('password' in res.corps.user) && !('exclus' in res.corps.user));

  // Le jeton de session porte l'appareil enrôlé, sinon la session serait
  // invisible dans « Appareils connectés » et donc irrévocable.
  const charge = jwt.verify(res.corps.accessToken, process.env.JWT_SECRET);
  assert.strictEqual(charge.appareilId, idEnrole);
  assert.strictEqual(charge.alanyaID, 7);

  /* ── 7 bis. Compte banni : mot de passe changé, mais pas de session ── */
  patchCompte = { exclus: 1, exclude_reason: 'spam' };
  res = await appeler(completePasswordReset, {
    resetToken: resetToken(), newPassword: 'nouveau-mdp', hardware_id: 'materiel-neuf',
  });
  assert.deepStrictEqual(Object.keys(res.corps), ['message'], 'un compte banni n’obtient pas de session par cette porte');
  assert.deepStrictEqual(journal.filter((j) => j.appel === 'recordLogin'), []);
  patchCompte = {};

  /* ── 7 ter. Enrôlement impossible : la réinitialisation reste réussie ── */
  // Le mot de passe est déjà changé ; répondre 500 ferait ressayer avec un OTP
  // désormais consommé.
  idEnrole = null;
  res = await appeler(completePasswordReset, {
    resetToken: resetToken(), newPassword: 'nouveau-mdp', hardware_id: 'materiel-neuf',
  });
  assert.strictEqual(res.code, 200);
  assert.deepStrictEqual(Object.keys(res.corps), ['message']);
  assert.deepStrictEqual(journal.filter((j) => j.appel === 'revokeAllExcept'), [],
    'sans appareil enrôlé, on ne révoque surtout pas les autres');
  assert.deepStrictEqual(journal.filter((j) => j.appel === 'disconnectRevoked'), []);
  idEnrole = 55;

  /* ── 7 quinquies. Aucun autre appareil : rien à couper ── */
  // Cas du compte qui n'avait plus qu'un téléphone, désormais perdu.
  REVOQUES = [];
  res = await appeler(completePasswordReset, {
    resetToken: resetToken(), newPassword: 'nouveau-mdp', hardware_id: 'materiel-neuf',
  });
  assert.ok(res.corps.accessToken, 'la session s’ouvre quand même');
  assert.deepStrictEqual(journal.filter((j) => j.appel === 'disconnectRevoked'), [],
    'aucune socket à fermer, aucun appel');
  REVOQUES = [
    { id: 3, deviceId: 'materiel-vole' },
    { id: 9, deviceId: 'materiel-tablette' },
  ];

  /* ── 7 quater. Token de reset invalide : 401, comme avant ── */
  res = await appeler(completePasswordReset, {
    resetToken: 'pas-un-jeton', newPassword: 'nouveau-mdp', hardware_id: 'materiel-neuf',
  });
  assert.strictEqual(res.code, 401);
  assert.strictEqual(res.corps.code, 'INVALID_TOKEN');

  console.log('✓ authDeviceBinding : 3 branches de la garde, refus sans effet de bord, secours par réinitialisation');
}

main().catch((e) => {
  console.error('authDeviceBinding.test.js ÉCHEC :', e);
  process.exit(1);
});
