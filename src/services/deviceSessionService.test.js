/**
 * Registre des appareils : les trois lectures/écritures dont dépend le
 * verrouillage de la connexion.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du service. Ce
 * fichier ne vérifie pas que MySQL sait exécuter ces requêtes — il vérifie ce
 * qu'elles disent : un appareil révoqué n'est pas « connu », un compte sans
 * appareil se compte à zéro, et `revokeAllExcept` refuse d'agir sans savoir qui
 * épargner.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let requetes = [];
let reponses = [];

const fakePool = {
  execute: async (sql, params) => {
    requetes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [reponses.shift() ?? [], []];
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

const service = require('./deviceSessionService');

async function main() {
  /* ── isTrustedDevice : la révocation compte, la troncature aussi ── */
  requetes = [];
  reponses = [[{ id: 12 }]];
  assert.strictEqual(await service.isTrustedDevice(7, 'abc'), true);
  assert.match(
    requetes[0].sql,
    /WHERE alanyaID = \? AND device_id = \? AND revoked_at IS NULL/,
    'un appareil révoqué ne doit jamais être « connu »',
  );

  requetes = [];
  reponses = [[]];
  assert.strictEqual(await service.isTrustedDevice(7, 'abc'), false);

  // Même troncature que `recordLogin` : sans elle, un identifiant plus long que
  // la colonne serait éternellement inconnu de son propre propriétaire.
  requetes = [];
  reponses = [[{ id: 12 }]];
  await service.isTrustedDevice(7, 'x'.repeat(200));
  assert.strictEqual(requetes[0].params[1].length, 128);

  // Aucun identifiant exploitable : pas de requête du tout.
  requetes = [];
  assert.strictEqual(await service.isTrustedDevice(7, 'INDEFINI'), false);
  assert.strictEqual(await service.isTrustedDevice(7, '   '), false);
  assert.strictEqual(await service.isTrustedDevice(null, 'abc'), false);
  assert.strictEqual(requetes.length, 0);

  /* ── countActiveDevices : c'est lui qui évite l'impasse ── */
  requetes = [];
  reponses = [[{ total: 0 }]];
  assert.strictEqual(await service.countActiveDevices(7), 0);
  assert.match(requetes[0].sql, /COUNT\(\*\) AS total FROM appareils WHERE alanyaID = \? AND revoked_at IS NULL/);

  reponses = [[{ total: 3 }]];
  assert.strictEqual(await service.countActiveDevices(7), 3);

  /* ── revokeAllExcept : jamais de révocation totale par omission ── */
  requetes = [];
  assert.deepStrictEqual(await service.revokeAllExcept(7, null), [], 'sans appareil épargné, on n’agit pas');
  assert.deepStrictEqual(await service.revokeAllExcept(7, undefined), []);
  assert.deepStrictEqual(await service.revokeAllExcept(null, 12), []);
  assert.strictEqual(requetes.length, 0, 'aucune requête : le compte reste entier');

  // Rien à révoquer : on ne lance pas d'UPDATE pour rien.
  requetes = [];
  reponses = [[]];
  assert.deepStrictEqual(await service.revokeAllExcept(7, 12), []);
  assert.strictEqual(requetes.length, 1, 'aucun appareil à couper, aucune écriture');

  // Le retour porte les appareils révoqués, et pas seulement leur nombre :
  // c'est ce qui permet de fermer LEURS sockets derrière (disconnectRevoked).
  requetes = [];
  reponses = [[{ id: 3, device_id: 'materiel-3' }, { id: 9, device_id: 'materiel-9' }], { affectedRows: 2 }];
  assert.deepStrictEqual(await service.revokeAllExcept(7, 12), [
    { id: 3, deviceId: 'materiel-3' },
    { id: 9, deviceId: 'materiel-9' },
  ]);
  assert.match(requetes[0].sql, /SELECT id, device_id FROM appareils WHERE alanyaID = \? AND id <> \? AND revoked_at IS NULL/);
  assert.deepStrictEqual(requetes[0].params, [7, 12]);
  assert.match(requetes[1].sql, /UPDATE appareils SET revoked_at = NOW\(\) WHERE alanyaID = \? AND revoked_at IS NULL AND id IN \(\?,\?\)/);
  assert.deepStrictEqual(requetes[1].params, [7, 3, 9], 'l’appareil épargné n’est jamais dans la liste');

  /* ── disconnectRevoked : une révocation qui laisse la socket ouverte n'en
     est pas une. L'événement part AVANT la fermeture, sinon le client voit sa
     socket tomber sans savoir pourquoi. ── */
  const emissions = [];
  const fermetures = [];
  const socket = (appareilId) => ({
    data: { appareilId },
    disconnect: () => fermetures.push(appareilId),
  });
  const fauxIo = {
    to: (room) => ({ emit: (event, payload) => emissions.push({ room, event, payload }) }),
    in: () => ({ fetchSockets: async () => [socket(3), socket(9), socket(12)] }),
  };

  const fermees = await service.disconnectRevoked(fauxIo, 7, [
    { id: 3, deviceId: 'materiel-3' },
    { id: 9, deviceId: 'materiel-9' },
  ]);
  assert.strictEqual(fermees, 2);
  assert.deepStrictEqual(fermetures, [3, 9], 'l’appareil épargné garde sa socket');
  assert.deepStrictEqual(emissions.map((e) => e.event), ['auth:device_revoked', 'auth:device_revoked']);
  assert.deepStrictEqual(emissions[0].payload, { appareilId: 3, deviceId: 'materiel-3' });
  assert.strictEqual(emissions[0].room, 'user_7');

  // Sans io (tests, instance sans socket) ou sans rien à couper : pas d'erreur.
  assert.strictEqual(await service.disconnectRevoked(null, 7, [{ id: 3, deviceId: 'a' }]), 0);
  assert.strictEqual(await service.disconnectRevoked(fauxIo, 7, []), 0);
  assert.strictEqual(await service.disconnectRevoked(fauxIo, 7, undefined), 0);

  /* ── 'recovery' est un enrôlement valide (migration 083) ── */
  requetes = [];
  reponses = [[], { insertId: 55 }];
  const id = await service.recordLogin({
    alanyaID: 7, deviceId: 'abc', deviceName: 'Pixel 8', platform: 'android',
    ipAddress: '10.0.0.1', loginMethod: 'recovery',
  });
  assert.strictEqual(id, 55);
  const insert = requetes.find((r) => /INSERT INTO appareils/.test(r.sql));
  assert.ok(insert, 'un appareil doit avoir été enrôlé');
  assert.strictEqual(insert.params[5], 'recovery', 'la voie de secours reste reconnaissable');

  // Et le vocabulaire reste fermé : une valeur inventée casse bruyamment.
  await assert.rejects(
    () => service.recordLogin({ alanyaID: 7, deviceId: 'abc', loginMethod: 'sms' }),
    /login_method invalide/,
  );

  console.log('✓ deviceSessionService : appareil connu, compte des actifs, révocation sélective + fermeture des sockets, méthode « recovery »');
}

main().catch((e) => {
  console.error('deviceSessionService.test.js ÉCHEC :', e);
  process.exit(1);
});
