/**
 * Les codes d'activation, contre la base.
 *
 * Exige la migration 090. Crée des comptes jetables (`exclus = 1`) et leurs
 * codes, et les supprime à la fin. Il MODIFIE `billing_settings` (régime,
 * interrupteur, essai) : il ne tourne donc que contre une base locale, et
 * refuse de démarrer sinon — le `.env` du dépôt pointe sur la production.
 *
 *   DB_HOST=127.0.0.1 DB_PORT=3399 DB_NAME=alanya_test DB_USER=root DB_PASSWORD= \
 *     NODE_ENV=test node src/services/billing/activationCodes.db.test.js
 *
 * Ce qu'il éprouve : le rachat (période d'un an, essai respecté), le rachat
 * rejoué, deux comptes qui se disputent un code, un compte qui le saisit deux
 * fois à la fois, le verrou des tentatives, l'expiration, la révocation,
 * l'émission rejouée d'une même commande du site, et que le code n'est jamais
 * lisible en base.
 */
const assert = require('assert');

const host = String(process.env.DB_HOST || '');
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(
    `activationCodes.db.test.js : refusé, DB_HOST=${host || '(vide)'} n'est pas une base locale. `
    + 'Ce test modifie billing_settings.',
  );
  process.exit(2);
}
process.env.ACTIVATION_CODE_SECRET = process.env.ACTIVATION_CODE_SECRET || 'secret-de-test-'.repeat(3);

const pool = require('../../config/db');
const { invalidateBillingSettings } = require('./settings');
const codes = require('./activationCodes');
const { generateCode, formatCode } = require('./codeFormat');
const { entitlementsFor } = require('./entitlements');
const { PERIOD_SOURCE } = require('../../constants/billing');

const DAY = 86_400_000;
const comptes = [];
const codeIds = [];

async function setSettings(fields) {
  const keys = Object.keys(fields);
  await pool.execute(
    `UPDATE billing_settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`,
    keys.map((k) => fields[k]),
  );
  invalidateBillingSettings();
}

async function creerCompte(nom, ageJours) {
  const created = new Date(Date.now() - ageJours * DAY);
  const [r] = await pool.execute(
    `INSERT INTO users (nom, pseudo, alanyaPhone, password, idPays, exclus, created_at)
     VALUES (?, ?, ?, 'test-sans-connexion', 10, 1, ?)`,
    [nom, nom, String(90000000 + Math.floor(Math.random() * 9999999)), created],
  );
  comptes.push(r.insertId);
  return r.insertId;
}

async function lot(count = 1, extra = {}) {
  const made = await codes.issueBatch({ count, adminId: null, ...extra });
  codeIds.push(...made.map((m) => m.id));
  return made;
}

const periodesDe = async (id) => {
  const [rows] = await pool.execute(
    'SELECT * FROM subscription_period WHERE alanyaID = ? ORDER BY starts_at ASC', [id],
  );
  return rows;
};

const echec = async (promesse, code) => {
  try {
    await promesse;
  } catch (e) {
    assert.strictEqual(e.code, code, `attendu ${code}, reçu ${e.code} (${e.message})`);
    return e;
  }
  throw new Error(`aurait dû échouer : ${code}`);
};

const dansMois = (from, n) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};

(async () => {
  try {
    // Régime essai, payant allumé, grâce passée : l'essai de chacun dépend de son inscription.
    await setSettings({
      model: 2, paid_enabled: 1, grace_until: new Date(Date.now() - 30 * DAY), trial_days: 90,
    });
    const ancien = await creerCompte('test-code-ancien', 200); // essai fini depuis 110 jours
    const recent = await creerCompte('test-code-recent', 10); // essai fini dans 80 jours

    /* ── Le code n'est jamais lisible en base ────────────────────────── */
    const [c1, c2, c3] = await lot(3, { label: 'test-lot' });
    assert.ok(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(c1.code));
    {
      const [[row]] = await pool.execute('SELECT * FROM activation_code WHERE id = ?', [c1.id]);
      const canonical = c1.code.replace(/-/g, '');
      assert.ok(!JSON.stringify(row).includes(canonical), 'le code en clair n\'est pas stocké');
      assert.ok(/^[0-9a-f]{64}$/.test(row.code_hash));
      assert.strictEqual(row.code_hint, canonical.slice(-4));
      assert.strictEqual(Number(row.duration_months), 12, 'durée du plan recopiée');
      assert.strictEqual(Number(row.status), 0);
    }

    /* ── Un ancien compte : l'année commence maintenant ──────────────── */
    const avant = Date.now();
    const r1 = await codes.redeemCode({ alanyaID: ancien, rawCode: c1.code });
    assert.strictEqual(r1.alreadyApplied, false);
    assert.ok(Math.abs(new Date(r1.startsAt).getTime() - avant) < 5000, 'essai fini : commence maintenant');
    assert.strictEqual(
      new Date(r1.endsAt).toISOString().slice(0, 10),
      dansMois(r1.startsAt, 12).toISOString().slice(0, 10),
      'un an',
    );
    {
      const periodes = await periodesDe(ancien);
      assert.strictEqual(periodes.length, 1);
      assert.strictEqual(Number(periodes[0].source), PERIOD_SOURCE.CODE);
      assert.strictEqual(Number(periodes[0].grants_badge), 1);
      assert.strictEqual(periodes[0].reason, `code:${c1.id}`);
      const [[code]] = await pool.execute('SELECT * FROM activation_code WHERE id = ?', [c1.id]);
      assert.strictEqual(Number(code.status), 1);
      assert.strictEqual(Number(code.redeemed_by), ancien);
      assert.strictEqual(Number(code.period_id), Number(periodes[0].id));
    }

    /* ── Rejouer son propre code : même succès, aucune seconde période ── */
    const r1bis = await codes.redeemCode({ alanyaID: ancien, rawCode: c1.code.toLowerCase().replace(/-/g, ' ') });
    assert.strictEqual(r1bis.alreadyApplied, true);
    assert.strictEqual(new Date(r1bis.endsAt).getTime(), new Date(r1.endsAt).getTime());
    assert.strictEqual((await periodesDe(ancien)).length, 1);

    /* ── Le code d'un autre : refusé ─────────────────────────────────── */
    await echec(codes.redeemCode({ alanyaID: recent, rawCode: c1.code }), 'CODE_ALREADY_USED');

    /* ── Payer pendant l'essai : l'année commence à la fin de l'essai ── */
    const r2 = await codes.redeemCode({ alanyaID: recent, rawCode: c2.code });
    {
      const finEssai = Date.now() + 80 * DAY;
      assert.ok(Math.abs(new Date(r2.startsAt).getTime() - finEssai) < 10_000,
        `commence à la fin de l'essai (${r2.startsAt})`);
      assert.strictEqual(
        new Date(r2.endsAt).toISOString().slice(0, 10),
        dansMois(r2.startsAt, 12).toISOString().slice(0, 10),
      );
    }

    /* ── Deuxième code sur un compte déjà abonné : à la suite ────────── */
    const r3 = await codes.redeemCode({ alanyaID: recent, rawCode: c3.code });
    assert.strictEqual(new Date(r3.startsAt).getTime(), new Date(r2.endsAt).getTime(), 'chaîne contiguë');
    assert.strictEqual((await periodesDe(recent)).length, 2);

    /* ── Droits : l'ancien peut émettre, un autre compte ancien non ──── */
    const sansAbo = await creerCompte('test-code-sans-abonnement', 300);
    try {
      const avecAbo = await entitlementsFor(ancien);
      assert.strictEqual(avecAbo.model, 2);
      assert.strictEqual(avecAbo.features.outgoing, true);
      assert.strictEqual(avecAbo.period.source, PERIOD_SOURCE.CODE);
      const ferme = await entitlementsFor(sansAbo);
      assert.strictEqual(ferme.features.outgoing, false, 'essai fini, aucun abonnement : réception seule');
      assert.strictEqual(ferme.trial.active, false);
      const enEssai = await entitlementsFor(await creerCompte('test-code-essai', 5));
      assert.strictEqual(enEssai.features.outgoing, true);
      assert.strictEqual(enEssai.trial.active, true);
      const paye = await entitlementsFor(recent);
      assert.strictEqual(paye.period, null, 'la période payée pendant l\'essai n\'a pas commencé');
      assert.strictEqual(paye.upcoming.plan, 'plus_annuel');
      assert.strictEqual(paye.features.outgoing, true, 'l\'essai court encore');
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      console.warn(`(droits non éprouvés : ${e.message})`);
    }

    /* ── Deux comptes se disputent un code : un seul l'obtient ───────── */
    {
      const [duel] = await lot(1);
      const a = await creerCompte('test-duel-a', 300);
      const b = await creerCompte('test-duel-b', 300);
      const res = await Promise.allSettled([
        codes.redeemCode({ alanyaID: a, rawCode: duel.code }),
        codes.redeemCode({ alanyaID: b, rawCode: duel.code }),
      ]);
      const ok = res.filter((r) => r.status === 'fulfilled');
      const ko = res.filter((r) => r.status === 'rejected');
      assert.strictEqual(ok.length, 1, 'un seul gagnant');
      assert.strictEqual(ko.length, 1);
      assert.strictEqual(ko[0].reason.code, 'CODE_ALREADY_USED');
      assert.strictEqual((await periodesDe(a)).length + (await periodesDe(b)).length, 1, 'une seule période');
    }

    /* ── Un compte saisit deux fois le même code à la fois ───────────── */
    {
      const [double] = await lot(1);
      const d = await creerCompte('test-double', 300);
      const res = await Promise.all([
        codes.redeemCode({ alanyaID: d, rawCode: double.code }),
        codes.redeemCode({ alanyaID: d, rawCode: double.code }),
      ]);
      assert.deepStrictEqual(res.map((r) => r.alreadyApplied).sort(), [false, true]);
      assert.strictEqual((await periodesDe(d)).length, 1, 'jamais deux périodes pour un code');
    }

    /* ── Faute de frappe : refusée sans compter comme un essai ───────── */
    {
      const e = await creerCompte('test-essais', 300);
      for (let i = 0; i < 8; i++) {
        await echec(codes.redeemCode({ alanyaID: e, rawCode: 'ABC' }), 'INVALID_CODE_FORMAT');
      }
      const [[att]] = await pool.execute('SELECT * FROM code_attempt WHERE alanyaID = ?', [e]);
      assert.strictEqual(att, undefined, 'les saisies malformées ne comptent pas');

      /* ── Cinq codes inconnus : le sixième essai est verrouillé ─────── */
      for (let i = 0; i < 5; i++) {
        await echec(codes.redeemCode({ alanyaID: e, rawCode: generateCode() }), 'INVALID_CODE');
      }
      const verrou = await echec(codes.redeemCode({ alanyaID: e, rawCode: generateCode() }), 'CODE_LOCKED');
      // 15 minutes, à une seconde près : la base arrondit la fin du verrou.
      assert.ok(verrou.extra.retryAfterSeconds > 14 * 60 && verrou.extra.retryAfterSeconds <= 15 * 60 + 1);
      // Même un BON code est refusé pendant le verrou.
      const [bon] = await lot(1);
      await echec(codes.redeemCode({ alanyaID: e, rawCode: bon.code }), 'CODE_LOCKED');
      // Le verrou tombe : le bon code passe, et les échecs sont remis à zéro.
      await pool.execute('UPDATE code_attempt SET locked_until = ? WHERE alanyaID = ?', [new Date(Date.now() - 1000), e]);
      const ok = await codes.redeemCode({ alanyaID: e, rawCode: bon.code });
      assert.strictEqual(ok.alreadyApplied, false);
      const [[apres]] = await pool.execute('SELECT * FROM code_attempt WHERE alanyaID = ?', [e]);
      assert.strictEqual(apres, undefined, 'un succès efface les échecs');
    }

    /* ── Un code utilisé ou expiré ne compte pas comme un essai ──────── */
    {
      const f = await creerCompte('test-expire', 300);
      const [vieux] = await lot(1);
      await pool.execute('UPDATE activation_code SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000), vieux.id]);
      await echec(codes.redeemCode({ alanyaID: f, rawCode: vieux.code }), 'CODE_EXPIRED');
      const [[att]] = await pool.execute('SELECT * FROM code_attempt WHERE alanyaID = ?', [f]);
      assert.strictEqual(att, undefined);
      assert.strictEqual((await periodesDe(f)).length, 0, 'un code expiré ne crée rien');
    }

    /* ── Révocation ──────────────────────────────────────────────────── */
    {
      const g = await creerCompte('test-revoque', 300);
      const [r, utilise] = await lot(2);
      await echec(codes.revokeCode({ id: r.id, adminId: null, reason: 'x' }), 'REASON_REQUIRED');
      await codes.revokeCode({ id: r.id, adminId: null, reason: 'erreur de lot' });
      await echec(codes.redeemCode({ alanyaID: g, rawCode: r.code }), 'CODE_REVOKED');
      await echec(codes.revokeCode({ id: r.id, adminId: null, reason: 'encore' }), 'CODE_REVOKED');
      await codes.redeemCode({ alanyaID: g, rawCode: utilise.code });
      await echec(codes.revokeCode({ id: utilise.id, adminId: null, reason: 'trop tard' }), 'CODE_ALREADY_USED');
      await echec(codes.revokeCode({ id: 999999999, adminId: null, reason: 'inconnu' }), 'CODE_NOT_FOUND');
    }

    /* ── Liste ───────────────────────────────────────────────────────── */
    {
      const tout = await codes.listCodes({ search: 'test-lot', limit: 200 });
      assert.ok(tout.total >= 3);
      assert.ok(tout.rows.every((r) => !('code' in r) && !('hash' in r)), 'jamais le code ni son empreinte');
      const utilises = await codes.listCodes({ status: 'redeemed', search: 'test-lot', limit: 200 });
      assert.ok(utilises.rows.length >= 3);
      assert.ok(utilises.rows.every((r) => r.status === 'redeemed' && r.redeemedBy));
      const expires = await codes.listCodes({ status: 'expired', limit: 200 });
      assert.ok(expires.rows.some((r) => r.status === 'expired'));
      await echec(codes.listCodes({ status: 'nimporte' }), 'INVALID_CODE_FILTER');
    }

    /* ── Émission d'une commande du site : rejouable sans doublon ────── */
    {
      const ref = `test-commande-${Date.now()}`;
      const un = await codes.issueActivationCode({ amountPaid: 1000, orderRef: ref, buyerContact: 'client@example.com' });
      codeIds.push(un.id);
      assert.strictEqual(un.created, true);
      assert.ok(un.code);
      const [[row]] = await pool.execute('SELECT * FROM activation_code WHERE id = ?', [un.id]);
      assert.strictEqual(Number(row.amount_paid), 1000);
      assert.strictEqual(Number(row.source), 0);
      assert.strictEqual(row.buyer_contact, 'client@example.com');

      const deux = await codes.issueActivationCode({ amountPaid: 1000, orderRef: ref });
      assert.strictEqual(deux.created, false, 'webhook rejoué : aucun second code');
      assert.strictEqual(deux.code, null, 'le clair n\'est jamais redonné');
      assert.strictEqual(deux.id, un.id);

      const ref2 = `test-commande-course-${Date.now()}`;
      const course = await Promise.all([
        codes.issueActivationCode({ amountPaid: 1000, orderRef: ref2 }),
        codes.issueActivationCode({ amountPaid: 1000, orderRef: ref2 }),
        codes.issueActivationCode({ amountPaid: 1000, orderRef: ref2 }),
      ]);
      codeIds.push(...course.filter((c) => c.id).map((c) => c.id));
      assert.strictEqual(course.filter((c) => c.created).length, 1, 'trois webhooks simultanés : un code');
      const [[{ n }]] = await pool.execute('SELECT COUNT(*) AS n FROM activation_code WHERE order_ref = ?', [ref2]);
      assert.strictEqual(Number(n), 1);

      // Le prix du plan change : le code déjà vendu garde le sien.
      await pool.execute('UPDATE plan SET price_amount = 1500 WHERE code = ?', ['plus_annuel']);
      const [[vieux]] = await pool.execute('SELECT amount_paid FROM activation_code WHERE id = ?', [un.id]);
      assert.strictEqual(Number(vieux.amount_paid), 1000);
      await pool.execute('UPDATE plan SET price_amount = 1000 WHERE code = ?', ['plus_annuel']);

      await echec(codes.issueActivationCode({ amountPaid: -1, orderRef: 'x' }), 'INVALID_CODE_ORDER');
      await echec(codes.issueActivationCode({ amountPaid: 1000, orderRef: '' }), 'INVALID_CODE_ORDER');
    }

    /* ── Lot : bornes ────────────────────────────────────────────────── */
    await echec(codes.issueBatch({ count: 0, adminId: null }), 'INVALID_CODE_BATCH');
    await echec(codes.issueBatch({ count: 201, adminId: null }), 'INVALID_CODE_BATCH');
    await echec(codes.issueBatch({ count: 1, validityDays: 0, adminId: null }), 'INVALID_CODE_BATCH');

    /* ── Hors phase payante : rien à activer (sauf compte testeur) ───── */
    {
      await setSettings({ paid_enabled: 0 });
      const h = await creerCompte('test-gratuit', 300);
      const [libre] = await lot(1);
      await echec(codes.redeemCode({ alanyaID: h, rawCode: libre.code }), 'BILLING_NOT_ACTIVE');
      const [[code]] = await pool.execute('SELECT status FROM activation_code WHERE id = ?', [libre.id]);
      assert.strictEqual(Number(code.status), 0, 'le code reste disponible');
    }

    /* ── Sans secret, on n'émet rien ─────────────────────────────────── */
    {
      const gardé = process.env.ACTIVATION_CODE_SECRET;
      process.env.ACTIVATION_CODE_SECRET = 'trop-court';
      await echec(codes.issueBatch({ count: 1, adminId: null }), 'BILLING_CODE_SECRET_MISSING');
      process.env.ACTIVATION_CODE_SECRET = gardé;
    }

    // Un code fabriqué de toutes pièces (bien formé) reste inconnu.
    await setSettings({ paid_enabled: 1, grace_until: new Date(Date.now() - 30 * DAY) });
    {
      const i = await creerCompte('test-inconnu', 300);
      await echec(codes.redeemCode({ alanyaID: i, rawCode: formatCode(generateCode()) }), 'INVALID_CODE');
    }

    console.log('activationCodes.db.test.js OK');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      if (codeIds.length) await pool.query('DELETE FROM activation_code WHERE id IN (?)', [codeIds]);
      if (comptes.length) await pool.query('DELETE FROM users WHERE alanyaID IN (?)', [comptes]);
      await pool.execute('DELETE FROM activation_code WHERE label = ?', ['test-lot']);
    } catch (e) {
      console.error('nettoyage :', e.message);
    }
    await pool.end();
    process.exit(process.exitCode || 0);
  }
})();
