/**
 * Journal des délivrances de clé de sauvegarde : écriture et relecture.
 *
 * Écrit dans `backup_key_access` puis retire ses lignes. Le test touche la
 * vraie base parce que c'est là que se joue ce qui compte — la clé étrangère,
 * les colonnes bornées, et l'ordre de relecture.
 */
const assert = require('assert');
const pool = require('./../config/db');
const { recordKeyAccess } = require('./backupKeyAudit');
const {
  getBackupKeyAccess,
  getBackupKeyAccessSummary,
} = require('../controllers/admin/backupAccess');

const ecrites = [];

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const appel = async (handler, req) => {
  const res = fakeRes();
  await handler(req, res);
  return res;
};

/** Requête minimale telle que l'aurait construite Express. */
const req = (alanyaID, extra = {}) => ({
  user: { alanyaID, appareilId: 'appareil-test' },
  ip: '203.0.113.7',
  get: (h) => (h.toLowerCase() === 'user-agent' ? 'Alanya/test' : undefined),
  ...extra,
});

(async () => {
  try {
    const [comptes] = await pool.execute(
      'SELECT alanyaID FROM users WHERE exclus = 0 ORDER BY alanyaID LIMIT 1',
    );
    assert.ok(comptes.length === 1, 'il faut au moins un compte');
    const compte = comptes[0].alanyaID;

    // Repère sur l'IDENTIFIANT, pas sur la date. `created_at` est un `DATETIME`
    // — précision à la seconde — tandis qu'un `new Date()` porte des
    // millisecondes : une ligne écrite à 17:00:28.000 est alors « antérieure »
    // à un repère pris à 17:00:28.400, et disparaît du filtre. Le premier
    // enregistrement du test s'y perdait.
    const [[{ maxId }]] = await pool.execute(
      'SELECT COALESCE(MAX(id), 0) AS maxId FROM backup_key_access',
    );

    // ── Une délivrance et un refus ─────────────────────────────────────────
    await recordKeyAccess(req(compte), 1, 'servie');
    await recordKeyAccess(req(compte), 3, 'refusee', 'secret non déployé');

    const [lignes] = await pool.execute(
      `SELECT id, alanya_id, kid, outcome, reason, ip, device_id, user_agent
         FROM backup_key_access
        WHERE alanya_id = ? AND id > ?
        ORDER BY id DESC`,
      [compte, maxId],
    );
    assert.strictEqual(lignes.length, 2, 'deux accès enregistrés');
    ecrites.push(...lignes.map((l) => l.id));

    const refus = lignes.find((l) => l.outcome === 'refusee');
    assert.strictEqual(refus.kid, 3);
    assert.strictEqual(refus.reason, 'secret non déployé');
    assert.strictEqual(refus.ip, '203.0.113.7');
    assert.strictEqual(refus.device_id, 'appareil-test');
    assert.strictEqual(refus.user_agent, 'Alanya/test');

    // ── La version courante n'a pas de `kid` demandé ────────────────────────
    const servie = lignes.find((l) => l.outcome === 'servie');
    assert.strictEqual(servie.kid, 1, 'le kid réellement servi est consigné');

    // ── Une écriture ne doit JAMAIS faire échouer la requête ────────────────
    //
    // Un compte inexistant viole la clé étrangère. L'inscrit doit malgré tout
    // obtenir sa clé : lui refuser sa sauvegarde parce qu'un journal est en
    // panne serait un remède pire que le mal.
    await recordKeyAccess(req(0), 1, 'servie');

    // ── Relecture par l'admin ──────────────────────────────────────────────
    const liste = await appel(getBackupKeyAccess, {
      query: { alanyaId: String(compte), limit: '10' },
    });
    assert.strictEqual(liste.statusCode, 200);
    assert.ok(liste.body.length >= 2, 'les deux lignes remontent');
    assert.ok(
      liste.body[0].id > liste.body[1].id,
      'du plus récent au plus ancien',
    );

    // Le filtre le plus utile de cet écran : une série de refus signale un
    // secret mal déployé avant que les inscrits ne se plaignent.
    const refuses = await appel(getBackupKeyAccess, {
      query: { alanyaId: String(compte), outcome: 'refusee' },
    });
    assert.ok(
      refuses.body.every((l) => l.outcome === 'refusee'),
      'le filtre sur l\'issue ne laisse rien passer',
    );

    // ── Vue d'ensemble ─────────────────────────────────────────────────────
    const vue = await appel(getBackupKeyAccessSummary, { query: { days: '1' } });
    assert.strictEqual(vue.statusCode, 200);
    assert.ok(vue.body.total >= 2, 'le volume compte nos deux lignes');
    assert.ok(vue.body.refus >= 1, 'le refus est compté à part');
    assert.strictEqual(vue.body.days, 1);

    // La fenêtre est bornée : 999 jours ne doit pas ouvrir la table entière.
    const borne = await appel(getBackupKeyAccessSummary, { query: { days: '999' } });
    assert.strictEqual(borne.body.days, 90, 'la fenêtre est plafonnée à 90 jours');

    console.log(`backupKeyAudit.test.js OK — ${ecrites.length} lignes écrites puis retirées`);
  } catch (e) {
    console.error('backupKeyAudit.test.js ÉCHEC :', e.message);
    process.exitCode = 1;
  } finally {
    if (ecrites.length) {
      await pool.query('DELETE FROM backup_key_access WHERE id IN (?)', [ecrites]);
    }
    await pool.end();
  }
})();
