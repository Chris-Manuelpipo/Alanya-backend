/**
 * Rotation et retrait des versions de clé de sauvegarde.
 *
 * ── Précaution ──
 *
 * Ce test touche `backup_key_secrets`, la table qui contient le VRAI secret de
 * cette base. Il ne supprime donc jamais une ligne préexistante et ne réécrit
 * aucun `secret` : il ne retire que les versions qu'il a lui-même créées, et
 * rétablit le `retired_at` de celles qui existaient avant. Même interrompu en
 * plein milieu, il ne peut pas rendre une sauvegarde illisible.
 */
const assert = require('assert');
const pool = require('../../config/db');
const { getKeys, rotateKey, retireKey } = require('./backupKeys');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const appel = async (handler, req = {}) => {
  const res = fakeRes();
  await handler({ user: { alanyaID: 0 }, params: {}, ...req }, res);
  return res;
};

let kidAvant = 0;
let activesAvant = [];

(async () => {
  try {
    const [[{ maxKid }]] = await pool.query(
      'SELECT COALESCE(MAX(kid), 0) AS maxKid FROM backup_key_secrets',
    );
    kidAvant = Number(maxKid);
    const [act] = await pool.query(
      'SELECT kid FROM backup_key_secrets WHERE retired_at IS NULL',
    );
    activesAvant = act.map((r) => Number(r.kid));
    assert.ok(kidAvant > 0, 'la migration 078 doit avoir posé une version');

    // ── Le secret ne sort jamais ─────────────────────────────────────────────
    const vue = await appel(getKeys);
    assert.strictEqual(vue.statusCode, 200);
    const brut = JSON.stringify(vue.body);
    assert.ok(!/"secret"/.test(brut), 'aucune réponse ne contient le secret');
    assert.ok(
      vue.body.versions.every((v) => !('secret' in v)),
      'pas même sous un autre nom',
    );
    assert.strictEqual(typeof vue.body.courante, 'number');

    // ── Rotation : nouvelle version, anciennes retirées ─────────────────────
    const rot = await appel(rotateKey);
    assert.strictEqual(rot.statusCode, 200);
    assert.strictEqual(rot.body.kid, kidAvant + 1, 'la version suivante');
    assert.ok(rot.body.retirees >= 1, 'les précédentes sortent du service');
    assert.ok(!/"secret"/.test(JSON.stringify(rot.body)));

    const apres = await appel(getKeys);
    assert.strictEqual(apres.body.courante, kidAvant + 1);
    assert.strictEqual(
      apres.body.versions.filter((v) => v.active).length, 1,
      'une seule version active après rotation',
    );
    // La rotation engendre un vrai secret : la nouvelle version doit être
    // utilisable, sans quoi plus aucune sauvegarde ne pourrait être écrite.
    assert.strictEqual(apres.body.utilisable, true);

    // ── L'ancienne reste LISIBLE, jamais supprimée ──────────────────────────
    const ancienne = apres.body.versions.find((v) => v.kid === kidAvant);
    assert.ok(ancienne, 'la version précédente existe toujours');
    assert.ok(ancienne.retiredAt != null, 'elle est retirée');

    // ── Retirer la dernière active est refusé ───────────────────────────────
    const refus = await appel(retireKey, { params: { kid: String(kidAvant + 1) } });
    assert.strictEqual(refus.statusCode, 409, 'refusé, pas exécuté');
    assert.strictEqual(refus.body.code, 'BACKUP_KEY_LAST_ACTIVE');

    const inchange = await appel(getKeys);
    assert.strictEqual(
      inchange.body.courante, kidAvant + 1,
      'le refus ne laisse aucun effet de bord',
    );

    // ── Retirer une version déjà retirée : refus net ────────────────────────
    const deja = await appel(retireKey, { params: { kid: String(kidAvant) } });
    assert.strictEqual(deja.statusCode, 404);

    // ── Une version invalide ne passe pas ───────────────────────────────────
    const invalide = await appel(retireKey, { params: { kid: 'abc' } });
    assert.strictEqual(invalide.statusCode, 400);

    console.log(
      `backupKeys.test.js OK — rotation ${kidAvant} → ${kidAvant + 1}, puis état rétabli`,
    );
  } catch (e) {
    console.error('backupKeys.test.js ÉCHEC :', e.message);
    process.exitCode = 1;
  } finally {
    // Ne supprime QUE ce que le test a créé, ne réécrit aucun `secret`.
    if (kidAvant > 0) {
      await pool.execute('DELETE FROM backup_key_secrets WHERE kid > ?', [kidAvant]);
      if (activesAvant.length) {
        await pool.query(
          'UPDATE backup_key_secrets SET retired_at = NULL WHERE kid IN (?)',
          [activesAvant],
        );
      }
    }
    await pool.end();
  }
})();
