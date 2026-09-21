/**
 * L'interrupteur du verrouillage d'appareil : cache, repli, écriture.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du service — même
 * procédé que `src/middleware/meetingAuth.test.js`. Aucune base n'est
 * nécessaire, et c'est voulu : la migration 084 s'applique à la main, ce test
 * doit passer sur une base qui ne l'a pas encore reçue.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let requetes = [];
/** 'ok' = la table répond ; 'absente' = migration 084 non jouée. */
let mode = 'ok';
let ligne = { id: 1, device_binding_enabled: 0, updated_at: new Date('2026-09-20T10:00:00Z') };
/** Erreur de la prochaine écriture, le cas échéant. */
let echecEcriture = null;

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    requetes.push({ sql: texte, params });
    if (mode === 'absente') {
      const e = new Error("Table 'security_settings' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    if (/^INSERT INTO security_settings/.test(texte)) {
      if (echecEcriture) throw echecEcriture;
      ligne = {
        ...ligne,
        device_binding_enabled: Number(params[0]),
        updated_at: new Date('2026-09-20T11:00:00Z'),
      };
      return [{ affectedRows: 1 }, []];
    }
    return [[{ ...ligne }], []];
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

const service = require('./securitySettingsService');

async function main() {
  /* ── Table absente : verrou inactif, et le repli est mis en cache ── */
  // Une base incomplète ne doit verrouiller personne dehors, et ne doit pas non
  // plus refaire la requête (ni réécrire l'avertissement) à chaque connexion.
  mode = 'absente';
  requetes = [];
  service.invalidateSecuritySettings();
  assert.strictEqual(await service.isDeviceBindingEnabled(), false, 'table absente ⇒ verrou inerte');
  assert.strictEqual(requetes.length, 1);
  assert.strictEqual(await service.isDeviceBindingEnabled(), false);
  assert.strictEqual(requetes.length, 1, 'le repli est mis en cache comme une vraie lecture');

  /* ── Lecture nominale, et cache ── */
  mode = 'ok';
  ligne = { id: 1, device_binding_enabled: 1, updated_at: new Date('2026-09-20T10:00:00Z') };
  service.invalidateSecuritySettings();
  requetes = [];
  assert.strictEqual(await service.isDeviceBindingEnabled(), true);
  const lu = await service.getSecuritySettings();
  assert.strictEqual(Number(lu.device_binding_enabled), 1);
  assert.strictEqual(requetes.length, 1, 'une seule lecture pour deux appels');
  assert.match(requetes[0].sql, /FROM security_settings WHERE id = 1/);

  /* ── Ligne manquante dans une table présente : 0, pas une explosion ── */
  const vraiExecute = fakePool.execute;
  fakePool.execute = async () => [[], []];
  service.invalidateSecuritySettings();
  assert.strictEqual(await service.isDeviceBindingEnabled(), false, 'pas de ligne ⇒ défaut à 0');
  fakePool.execute = vraiExecute;

  /* ── Écriture : la ligne est posée si elle manque, et le cache tombe ── */
  service.invalidateSecuritySettings();
  await service.getSecuritySettings();            // remplit le cache
  requetes = [];
  const apres = await service.setDeviceBindingEnabled(false);
  assert.match(
    requetes[0].sql,
    /^INSERT INTO security_settings \(id, device_binding_enabled\) VALUES \(1, \?\) ON DUPLICATE KEY UPDATE/,
    'une ligne absente ne doit pas faire échouer un réglage de sécurité en silence',
  );
  assert.deepStrictEqual(requetes[0].params, [0]);
  assert.strictEqual(Number(apres.device_binding_enabled), 0);
  assert.ok(
    requetes.some((r) => /SELECT \* FROM security_settings/.test(r.sql)),
    'le cache est invalidé : la valeur rendue est relue',
  );
  assert.strictEqual(await service.isDeviceBindingEnabled(), false);

  /* ── `true` arme bien le verrou ── */
  await service.setDeviceBindingEnabled(true);
  assert.strictEqual(await service.isDeviceBindingEnabled(), true);

  /* ── Une écriture qui échoue remonte : elle ne se tait pas ── */
  // La lecture est tolérante, l'écriture ne l'est pas : un administrateur qui
  // croit avoir armé le verrou alors que rien n'a été écrit est pire qu'une
  // erreur affichée.
  echecEcriture = new Error('ER_LOCK_WAIT_TIMEOUT');
  await assert.rejects(() => service.setDeviceBindingEnabled(false));
  echecEcriture = null;

  console.log('✓ securitySettingsService : cache 30 s, repli à 0 sans la table, écriture invalidante');
}

main().catch((e) => {
  console.error('securitySettingsService.test.js ÉCHEC :', e);
  process.exit(1);
});
