/**
 * Chemins de `createReport` qui passent par la base.
 *
 * Séparé de `reportService.test.js`, qui ne teste que les normalisations et
 * tourne sans connexion : celui-ci écrit dans `report` et nettoie derrière lui.
 * Il ne supprime que les lignes dont il a l'identifiant — jamais un `DELETE`
 * large qui emporterait un vrai signalement.
 */
const assert = require('assert');
const pool = require('../config/db');
const { createReport } = require('./reportService');

const cree = [];

async function nettoyer() {
  if (!cree.length) return 0;
  const [d] = await pool.query('DELETE FROM report WHERE id IN (?)', [cree]);
  return d.affectedRows;
}

const attendreErreur = async (fn, motif) => {
  try {
    await fn();
    assert.fail(`aurait dû échouer : ${motif}`);
  } catch (e) {
    assert.ok(e.status, `erreur sans statut HTTP (${e.message})`);
    assert.match(e.message, motif);
    return e;
  }
};

(async () => {
  try {
    const [comptes] = await pool.execute(
      'SELECT alanyaID FROM users WHERE exclus = 0 ORDER BY alanyaID LIMIT 3',
    );
    assert.ok(comptes.length >= 3, 'il faut trois comptes pour ce test');
    const [auteur, cibleA, cibleB] = comptes.map((u) => u.alanyaID);

    /* ── Le cas nominal ──────────────────────────────────────────────── */
    const premier = await createReport(auteur, {
      targetType: 'user', targetId: cibleA, reason: 'harassment', note: '  test  ',
    });
    assert.ok(premier.id > 0);
    assert.strictEqual(premier.duplicate, false);
    cree.push(premier.id);

    const [[ligne]] = await pool.execute(
      'SELECT target_type, target_user_id, target_msg_id, reason, note, state FROM report WHERE id = ?',
      [premier.id],
    );
    assert.strictEqual(ligne.target_type, 'user');
    assert.strictEqual(ligne.target_user_id, cibleA);
    assert.strictEqual(ligne.target_msg_id, null, 'une cible et une seule');
    assert.strictEqual(ligne.note, 'test', 'la note est élaguée');
    assert.strictEqual(ligne.state, 'open');

    /* ── Le doublon est un succès, pas une erreur ────────────────────── */
    // L'index unique (reporter_id, target_user_id) mord. L'utilisateur a
    // signalé, sa plainte est enregistrée : lui répondre par une erreur
    // l'inviterait à recommencer.
    const doublon = await createReport(auteur, {
      targetType: 'user', targetId: cibleA, reason: 'spam',
    });
    assert.deepStrictEqual(doublon, { id: null, duplicate: true });

    /* ── Deux cibles différentes ne se heurtent pas ──────────────────── */
    const autre = await createReport(auteur, {
      targetType: 'user', targetId: cibleB, reason: 'scam',
    });
    assert.strictEqual(autre.duplicate, false);
    cree.push(autre.id);

    /* ── Deux messages distincts non plus ────────────────────────────── */
    // `target_user_id` vaut NULL sur les deux lignes, et MySQL autorise les
    // NULL répétés dans un index unique. C'est ce qui rend le schéma viable.
    const [messages] = await pool.execute(
      'SELECT msgID FROM message WHERE senderID <> ? AND isDeleted = 0 ORDER BY msgID DESC LIMIT 2',
      [auteur],
    );
    if (messages.length === 2) {
      const m1 = await createReport(auteur, {
        targetType: 'message', targetId: messages[0].msgID, reason: 'hate',
      });
      const m2 = await createReport(auteur, {
        targetType: 'message', targetId: messages[1].msgID, reason: 'violence',
      });
      assert.strictEqual(m1.duplicate, false);
      assert.strictEqual(m2.duplicate, false, 'deux NULL ne se heurtent pas');
      cree.push(m1.id, m2.id);

      // Mais le même message deux fois, si.
      const rejoue = await createReport(auteur, {
        targetType: 'message', targetId: messages[0].msgID, reason: 'spam',
      });
      assert.strictEqual(rejoue.duplicate, true);
    } else {
      console.log('  (deux messages distincts : ignoré, pas assez de messages)');
    }

    /* ── Ce qui doit être refusé ─────────────────────────────────────── */
    await attendreErreur(
      () => createReport(auteur, { targetType: 'user', targetId: auteur, reason: 'spam' }),
      /soi-même/,
    );

    const [[mien]] = await pool.execute(
      'SELECT msgID FROM message WHERE senderID = ? LIMIT 1', [auteur],
    );
    if (mien) {
      await attendreErreur(
        () => createReport(auteur, { targetType: 'message', targetId: mien.msgID, reason: 'spam' }),
        /son propre message/,
      );
    }

    const e = await attendreErreur(
      () => createReport(auteur, { targetType: 'message', targetId: 2147483000, reason: 'spam' }),
      /introuvable/,
    );
    assert.strictEqual(e.status, 404);

    console.log(`reportService.db.test.js OK — ${cree.length} lignes créées puis retirées`);
  } catch (err) {
    console.error('ÉCHEC :', err.message);
    process.exitCode = 1;
  } finally {
    const n = await nettoyer();
    if (n !== cree.length) {
      console.error(`⚠ nettoyage incomplet : ${n}/${cree.length}`);
      process.exitCode = 1;
    }
    process.exit();
  }
})();
