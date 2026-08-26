/**
 * File de modération : la remontée et la prise de décision.
 *
 * Écrit dans `report` et `report_action`, puis retire ses lignes — la cascade
 * de `report_action` suit la suppression du signalement.
 */
const assert = require('assert');
const pool = require('../../config/db');
const { createReport } = require('../../services/reportService');
const { getReports, getReportActions, postReportAction } = require('./reports');

const cree = [];

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

(async () => {
  try {
    const [comptes] = await pool.execute(
      'SELECT alanyaID FROM users WHERE exclus = 0 ORDER BY alanyaID LIMIT 2',
    );
    const [[a]] = await pool.execute(
      'SELECT alanyaID FROM users WHERE type_compte >= 1 AND exclus = 0 LIMIT 1',
    );
    assert.ok(comptes.length >= 2 && a, 'il faut deux comptes et un administrateur');
    const auteur = comptes[0].alanyaID;
    const cible = comptes[1].alanyaID;
    const admin = a.alanyaID;
    const user = { alanyaID: admin };

    const { id } = await createReport(auteur, {
      targetType: 'user', targetId: cible, reason: 'harassment', note: 'pour le test',
    });
    cree.push(id);

    /* ── La file le remonte, avec ce qu'il faut pour décider ─────────── */
    let res = await appel(getReports, { query: { state: 'open' } });
    const ligne = res.body.items.find((r) => r.id === id);
    assert.ok(ligne, 'le signalement ouvert doit apparaître dans la file');
    assert.strictEqual(ligne.reason, 'harassment');
    assert.strictEqual(ligne.state, 'open');
    assert.ok('reporter_nom' in ligne, 'le nom de l’auteur est joint');
    assert.ok('target_nom' in ligne, 'le nom de la cible est joint');
    assert.strictEqual(Number(ligne.actions), 0);
    assert.strictEqual(res.body.page, 1);
    assert.strictEqual(res.body.limit, 20);
    assert.ok(res.body.total >= 1, 'le total accompagne la page');

    /* ── Le filtre d'état est réel, pas décoratif ────────────────────── */
    res = await appel(getReports, { query: { state: 'dismissed' } });
    assert.ok(!res.body.items.some((r) => r.id === id), 'un ouvert ne doit pas sortir en « classé »');
    // Le bandeau « n en attente » n'aurait aucun sens s'il ne comptait que
    // l'onglet affiché : le décompte des ouverts ignore le filtre d'état.
    assert.ok(res.body.open >= 1, 'le décompte des ouverts ignore le filtre d’état');

    /* ── La recherche ────────────────────────────────────────────────── */
    // La précision laissée par le plaignant fait partie de ce qu'on retape.
    res = await appel(getReports, { query: { search: 'pour le test' } });
    assert.ok(res.body.items.some((r) => r.id === id), 'la recherche doit retrouver la note');

    // Une recherche sans résultat rend une file vide *et* des compteurs à
    // zéro. Un total figé sur l'ensemble de la table ferait afficher une
    // pagination pour des lignes que personne ne peut atteindre.
    res = await appel(getReports, { query: { search: 'zzq-introuvable-zzq' } });
    assert.strictEqual(res.body.items.length, 0);
    assert.strictEqual(res.body.total, 0, 'le total suit la recherche');
    assert.strictEqual(res.body.open, 0, 'le bandeau ne compte pas hors recherche');

    /* ── La pagination ───────────────────────────────────────────────── */
    // Une page d'une ligne rend une ligne, mais compte tout ce qui correspond.
    res = await appel(getReports, { query: { limit: 1 } });
    assert.strictEqual(res.body.items.length, 1);
    assert.strictEqual(res.body.limit, 1);
    assert.ok(res.body.total >= 1, 'le total dépasse la page, c’est tout son intérêt');

    // La page 2 ne redonne pas la ligne de la page 1 — c'est ce que le
    // départage par `r.id` garantit quand deux signalements partagent leur
    // seconde de dépôt.
    if (res.body.total >= 2) {
      const premier = res.body.items[0].id;
      res = await appel(getReports, { query: { limit: 1, page: 2 } });
      assert.strictEqual(res.body.page, 2);
      assert.notStrictEqual(res.body.items[0].id, premier, 'les pages ne se recouvrent pas');
    }

    /* ── Les décisions s'empilent, elles ne s'écrasent pas ───────────── */
    // Sans cela, « ce compte a déjà été signalé trois fois » et « ces trois
    // signalements ont été jugés infondés » resteraient indiscernables.
    res = await appel(postReportAction, { params: { id }, body: { action: 'reviewing' }, user });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.state, 'reviewing');

    res = await appel(postReportAction, {
      params: { id }, body: { action: 'dismissed', note: 'rien de probant' }, user,
    });
    assert.strictEqual(res.body.state, 'dismissed');

    res = await appel(getReportActions, { params: { id } });
    assert.strictEqual(res.body.length, 2, 'les deux décisions sont conservées');
    assert.deepStrictEqual(res.body.map((x) => x.action), ['reviewing', 'dismissed']);
    assert.strictEqual(res.body[1].note, 'rien de probant');
    assert.strictEqual(res.body[1].admin_id, admin, 'la décision porte son auteur');

    const [[etat]] = await pool.execute('SELECT state FROM report WHERE id = ?', [id]);
    assert.strictEqual(etat.state, 'dismissed', 'l’état suit la dernière décision');

    /* ── Ce qui doit être refusé, sans rien écrire ───────────────────── */
    const [[avant]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM report_action WHERE report_id = ?', [id],
    );

    res = await appel(postReportAction, { params: { id }, body: { action: 'bannir' }, user });
    assert.strictEqual(res.statusCode, 400, 'bannir ne se fait pas depuis la file');
    assert.ok(Array.isArray(res.body.accepted), 'la réponse dit ce qui est accepté');

    res = await appel(postReportAction, { params: { id }, body: {}, user });
    assert.strictEqual(res.statusCode, 400);

    res = await appel(postReportAction, {
      params: { id: 2147483000 }, body: { action: 'dismissed' }, user,
    });
    assert.strictEqual(res.statusCode, 404);

    const [[apres]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM report_action WHERE report_id = ?', [id],
    );
    assert.strictEqual(apres.n, avant.n, 'un refus n’écrit aucune décision');

    console.log('admin/reports.test.js OK');
  } catch (err) {
    console.error('ÉCHEC :', err.message);
    process.exitCode = 1;
  } finally {
    if (cree.length) {
      const [d] = await pool.query('DELETE FROM report WHERE id IN (?)', [cree]);
      const [[reste]] = await pool.query(
        'SELECT COUNT(*) AS n FROM report_action WHERE report_id IN (?)', [cree],
      );
      if (d.affectedRows !== cree.length || reste.n !== 0) {
        console.error(`⚠ nettoyage incomplet : ${d.affectedRows}/${cree.length}, ${reste.n} décision(s) restante(s)`);
        process.exitCode = 1;
      }
    }
    process.exit();
  }
})();
