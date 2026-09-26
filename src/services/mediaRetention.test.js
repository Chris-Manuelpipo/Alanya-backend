const assert = require('assert');

const {
  BATCH_SIZE,
  PurgeSuspendue,
  lireContexte,
  plafondDe,
  plafondServi,
  dernierPlafondApplique,
  expiredMediaWhere,
  purgeExpiredMediaBatch,
  runNightlyMediaPurge,
  seuilDeLaNuit,
} = require('./mediaRetention');
const policy = require('../constants/mediaRetentionPolicy');

// ── Le prédicat, sans paliers ───────────────────────────────────────
const echu = expiredMediaWhere();
assert.ok(echu.sql.includes('m.mediaUrl IS NOT NULL'));
assert.ok(echu.sql.includes("m.mediaUrl <> ''"));
assert.ok(echu.sql.includes('INTERVAL ? DAY'));
assert.deepStrictEqual(echu.params, [policy.RETENTION.mediaDays]);
// L'ancienne forme d'appel reste valable.
assert.deepStrictEqual(expiredMediaWhere({ mediaDays: 12 }).params, [12]);

// La rétention par défaut est celle annoncée par la politique.
//
// ⚠ 365 et non 30 depuis le 25/08/2026 : valeur TEMPORAIRE, posée le temps de
// vérifier la mise en service du stockage partitionné sans qu'aucune purge ne
// supprime quoi que ce soit. Voir le commentaire de `mediaRetentionPolicy.js`.
// Cette assertion est volontairement exacte plutôt que bornée : elle force à
// repasser ici — donc à se poser la question — le jour où l'on rétablit 30.
assert.strictEqual(policy.RETENTION.mediaDays, 365);

// Une valeur d'environnement absurde ne doit pas pouvoir désactiver la purge
// ni la rendre instantanée : `readInt` borne, il n'y a jamais de NaN.
assert.ok(policy.RETENTION.mediaDays >= 1 && policy.RETENTION.mediaDays <= 365);
// La durée longue ne dépasse pas le filet du bucket (366 jours).
assert.ok(policy.RETENTION.plusDays >= 1 && policy.RETENTION.plusDays <= 365);

// ── Le prédicat, avec paliers ───────────────────────────────────────
{
  const ctx = { standardDays: 30, plusDays: 365, paliers: 'tous', testeurs: [] };
  const w = expiredMediaWhere(ctx);
  // Au-delà de la durée longue, tout tombe ; entre les deux, seulement si
  // personne de la discussion n'est couvert — ni l'expéditeur, ni un membre.
  assert.ok(w.sql.includes('m.sendAt < DATE_SUB(NOW(), INTERVAL ? DAY)'));
  assert.ok(/u\.alanyaID = m\.senderID/.test(w.sql), "l'expéditeur compte");
  assert.ok(/cp\.conversID = m\.conversationID/.test(w.sql), 'les membres de la discussion comptent');
  assert.strictEqual((w.sql.match(/NOT EXISTS/g) || []).length, 2);
  // Recopie de `mediaRetentionCovered` : exempté, ou abonné jusqu'à la purge.
  assert.ok(w.sql.includes('u.type_compte >= 1'));
  assert.ok(w.sql.includes('s.purged_at IS NULL'));
  assert.ok(w.sql.includes('s.purge_after IS NULL OR s.purge_after > NOW()'));
  // Paramètres : standard, longue, puis le compte officiel pour chaque sous-requête.
  assert.deepStrictEqual(w.params, [30, 365, 2, 2]);
  // Autant de `?` que de paramètres, sinon MySQL refuse la requête.
  assert.strictEqual((w.sql.match(/\?/g) || []).length, w.params.length);
}
{
  // Phase gratuite avec testeurs : eux seuls peuvent être couverts.
  const ctx = { standardDays: 30, plusDays: 365, paliers: 'testeurs', testeurs: [12, 34] };
  const w = expiredMediaWhere(ctx);
  assert.ok(w.sql.includes('u.alanyaID IN (?,?) AND'));
  assert.deepStrictEqual(w.params, [30, 365, 12, 34, 2, 12, 34, 2]);
  assert.strictEqual((w.sql.match(/\?/g) || []).length, w.params.length);
}
{
  // Sans paliers, la forme d'avant, à l'identique.
  const w = expiredMediaWhere({ standardDays: 30, plusDays: 365, paliers: 'aucun', testeurs: [] });
  assert.deepStrictEqual(w.params, [30]);
  assert.ok(!w.sql.includes('NOT EXISTS'));
}

async function main() {
  // ── Le contexte ─────────────────────────────────────────────────────
  {
    const reglages = (r) => async () => r;
    const OFF = { paid_enabled: 0, grace_until: null };
    const GRACE = { paid_enabled: 1, grace_until: new Date(Date.now() + 86_400_000) };
    const PAID = { paid_enabled: 1, grace_until: null };
    const durees = { standardDays: 30, plusDays: 365 };
    const lire = (r, env = {}) => lireContexte(durees, { lireReglages: reglages(r), env });

    // Phase gratuite : tout le monde à la durée standard.
    let ctx = await lire(OFF);
    assert.strictEqual(ctx.paliers, 'aucun');
    assert.strictEqual(plafondDe(ctx), 30);
    // Grâce : pareil.
    assert.strictEqual((await lire(GRACE)).paliers, 'aucun');
    // Phase payante : la règle s'applique à chacun, le plafond passe à la durée longue.
    ctx = await lire(PAID);
    assert.strictEqual(ctx.paliers, 'tous');
    assert.strictEqual(plafondDe(ctx), 365);
    // Phase gratuite avec testeurs : eux seuls, et le plafond reste standard.
    ctx = await lire(OFF, { BILLING_TEST_USERS: '12, 34' });
    assert.strictEqual(ctx.paliers, 'testeurs');
    assert.deepStrictEqual(ctx.testeurs, [12, 34]);
    assert.strictEqual(plafondDe(ctx), 30);
    // Durée longue mal réglée sous la standard : ramenée, et plus de paliers.
    ctx = await lireContexte({ standardDays: 60, plusDays: 30 }, { lireReglages: reglages(PAID), env: {} });
    assert.strictEqual(ctx.plusDays, 60);
    assert.strictEqual(ctx.paliers, 'aucun');

    // Module d'abonnement absent : personne n'est abonné, la purge continue.
    const absente = Object.assign(new Error("Table 'billing_settings' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    ctx = await lireContexte(durees, {
      lireReglages: async () => { throw absente; },
      env: { BILLING_TEST_USERS: '12' },
    });
    assert.strictEqual(ctx.paliers, 'aucun');

    // État illisible : la lecture échoue, donc la purge — rien n'est supprimé.
    const panne = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    await assert.rejects(
      lireContexte(durees, { lireReglages: async () => { throw panne; }, env: {} }),
      /Connection lost/,
    );
  }

  /**
   * Base factice : rend les résultats dans l'ordre, et enregistre chaque appel.
   * Les requêtes au journal des purges sont servies à part, pour ne pas
   * dépendre de leur place dans la séquence.
   */
  function recordingDb(results, { nuits = [] } = {}) {
    const calls = [];
    let i = 0;
    return {
      calls,
      execute: async (sql, params) => {
        calls.push({ sql, params: params || [] });
        if (sql.includes('FROM purge_runs')) {
          return [nuits.map((files) => ({ result: JSON.stringify({ files }) }))];
        }
        return results[i++] ?? [[]];
      },
    };
  }

  // Les fichiers ne sont jamais supprimés pour de vrai : le `.env` de
  // développement donne accès au bucket de production.
  const supprimes = [];
  const supprimerFichier = (url) => supprimes.push(url);

  const ligne = (msgID) => ({
    msgID,
    mediaUrl: `https://exemple.test/uploads/media/images/inexistant_${msgID}.jpg`,
  });
  const SANS_PALIERS = { standardDays: 30, plusDays: 365, paliers: 'aucun', testeurs: [] };
  const compte = (n) => [[{ fichiers: n, octets: 0, plusAncien: null }]];

  // ── Un lot ──────────────────────────────────────────────────────────
  {
    supprimes.length = 0;
    const db = recordingDb([
      [[ligne(1), ligne(2)]],
      [{ affectedRows: 2 }],
    ]);
    const n = await purgeExpiredMediaBatch(db, SANS_PALIERS, { supprimerFichier });
    assert.strictEqual(n, 2);
    assert.strictEqual(db.calls.length, 2);
    assert.deepStrictEqual(supprimes, [ligne(1).mediaUrl, ligne(2).mediaUrl]);

    const [sel, upd] = db.calls;
    // L'alias `m` doit être déclaré dans le FROM : le prédicat qualifie ses
    // colonnes (`m.mediaUrl`, `m.sendAt`). Sans lui, MySQL rejette la requête
    // (« Unknown column 'm.mediaUrl' ») et la purge n'a jamais lieu — ce test,
    // qui n'enregistre le SQL sans jamais l'exécuter, l'avait laissé passer.
    assert.ok(sel.sql.startsWith('SELECT m.msgID, m.mediaUrl FROM message m'));
    assert.ok(
      /FROM message m\b/.test(sel.sql),
      'le FROM doit aliaser la table en `m` pour que le prédicat soit résoluble',
    );
    assert.deepStrictEqual(sel.params, [30]);

    // Le message lui-même n'est JAMAIS supprimé : seule mediaUrl est vidée.
    assert.ok(upd.sql.startsWith('UPDATE message SET mediaUrl = NULL'));
    assert.ok(!upd.sql.includes('DELETE'));
    assert.ok(!upd.sql.includes('isDeleted'));
    assert.deepStrictEqual(upd.params, [1, 2]);
  }

  // Rien d'expiré : aucune écriture, pas même un UPDATE à vide.
  {
    const db = recordingDb([[[]]]);
    const n = await purgeExpiredMediaBatch(db, SANS_PALIERS, { supprimerFichier });
    assert.strictEqual(n, 0);
    assert.strictEqual(db.calls.length, 1, 'un SELECT seul, aucun UPDATE');
  }

  // ── La purge nocturne ───────────────────────────────────────────────
  // Elle doit vider TOUS les lots, pas seulement le premier : sinon un
  // arriéré ne se résorberait qu'à raison d'un lot par nuit.
  {
    const plein = Array.from({ length: BATCH_SIZE }, (_, i) => ligne(i + 1));
    const db = recordingDb([
      compte(1001),
      [plein], [{ affectedRows: 500 }],
      [plein], [{ affectedRows: 500 }],
      [[ligne(1001)]], [{ affectedRows: 1 }],
    ], { nuits: [400, 400] });
    const res = await runNightlyMediaPurge(db, { contexte: SANS_PALIERS, supprimerFichier });
    assert.strictEqual(res.files, 1001);
    assert.strictEqual(res.paliers, 'aucun');
    // Seuil : trois fois la moyenne des nuits (400) l'emporte sur le plancher.
    assert.strictEqual(res.seuil, 1200);
    // 1 comptage + 1 lecture du journal + 3 SELECT + 3 UPDATE : la boucle
    // s'arrête sur le lot incomplet.
    assert.strictEqual(db.calls.length, 8);
  }

  // Base sans média expiré : un comptage, le journal, un SELECT.
  {
    const db = recordingDb([compte(0), [[]]]);
    const res = await runNightlyMediaPurge(db, { contexte: SANS_PALIERS, supprimerFichier });
    assert.strictEqual(res.files, 0);
    assert.strictEqual(db.calls.length, 3);
  }

  // ── Le garde-fou de volume ──────────────────────────────────────────
  {
    // Nuit anormale : rien n'est supprimé, la purge s'arrête en le disant.
    supprimes.length = 0;
    const db = recordingDb([compte(5000)], { nuits: [12, 15, 9] });
    await assert.rejects(
      runNightlyMediaPurge(db, { contexte: SANS_PALIERS, alertFloor: 1000, supprimerFichier }),
      (e) => e instanceof PurgeSuspendue && e.aSupprimer === 5000 && e.seuil === 1000,
    );
    assert.strictEqual(supprimes.length, 0, 'aucun fichier supprimé');
    assert.ok(!db.calls.some((c) => c.sql.startsWith('UPDATE')), 'aucun message touché');
    assert.ok(!db.calls.some((c) => c.sql.startsWith('SELECT m.msgID')), 'aucun lot lu');
  }
  {
    // À la main, le super-admin confirme : pas de comptage, pas de seuil.
    const db = recordingDb([[[ligne(1)]], [{ affectedRows: 1 }]]);
    const res = await runNightlyMediaPurge(db, {
      contexte: SANS_PALIERS, alertFloor: 1, trigger: 'manual', supprimerFichier,
    });
    assert.strictEqual(res.files, 1);
    assert.strictEqual(res.seuil, undefined);
    assert.ok(!db.calls.some((c) => c.sql.includes('COUNT(*)')));
  }
  {
    // Le plafond servi par le garde 410 ne descend qu'après une purge menée à
    // terme : interrupteur payant éteint par erreur, purge suspendue — les
    // médias d'abonnés restent servis au lieu de répondre 410.
    const GRATUIT = { standardDays: 30, plusDays: 365, paliers: 'aucun', testeurs: [] };
    const PAYANT = { ...GRATUIT, paliers: 'tous' };
    const journal = (resultats) => ({
      execute: async () => [resultats.map((r) => ({ result: JSON.stringify(r) }))],
    });
    assert.strictEqual(plafondServi(GRATUIT, await dernierPlafondApplique(journal([{ files: 3, plafondJours: 365 }]))), 365);
    // Une fois la purge confirmée à 30 jours, le plafond descend.
    assert.strictEqual(plafondServi(GRATUIT, await dernierPlafondApplique(journal([{ files: 900, plafondJours: 30 }]))), 30);
    // Il monte, lui, sans attendre : passage en phase payante.
    assert.strictEqual(plafondServi(PAYANT, await dernierPlafondApplique(journal([{ files: 3, plafondJours: 30 }]))), 365);
    // Anciennes exécutions sans plafond, journal vide ou illisible : la règle courante.
    assert.strictEqual(plafondServi(GRATUIT, await dernierPlafondApplique(journal([{ files: 3 }]))), 30);
    assert.strictEqual(plafondServi(GRATUIT, await dernierPlafondApplique(journal([]))), 30);
    const casse = { execute: async () => { throw new Error('Connection lost'); } };
    assert.strictEqual(plafondServi(GRATUIT, await dernierPlafondApplique(casse)), 30);

    // Chaque purge menée à terme enregistre son plafond.
    const db = recordingDb([compte(0), [[]]]);
    const res = await runNightlyMediaPurge(db, { contexte: PAYANT, supprimerFichier });
    assert.strictEqual(res.plafondJours, 365);
  }
  {
    // Le seuil : plancher sans historique, trois fois la moyenne sinon.
    assert.strictEqual(await seuilDeLaNuit(recordingDb([]), 1000), 1000);
    assert.strictEqual(await seuilDeLaNuit(recordingDb([], { nuits: [1000, 2000] }), 1000), 4500);
    // Journal illisible : le plancher seul, la purge n'est pas bloquée pour autant.
    const casse = { execute: async () => { throw new Error("Table 'purge_runs' doesn't exist"); } };
    assert.strictEqual(await seuilDeLaNuit(casse, 800), 800);
  }

  console.log('mediaRetention.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
