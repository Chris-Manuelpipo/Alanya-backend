/**
 * Le parcours du numéro choisi, contre la base.
 *
 * Exige la migration 089. Crée trois comptes jetables (`exclus = 1` : absents
 * des recherches le temps du test) et les supprime à la fin — la suppression
 * emporte par cascade leurs paiements, commandes et historique. Aucun compte
 * réel n'est touché.
 *
 * Le simulateur est appelé avec un numéro mobile money finissant par 03
 * (« aucune réponse ») : il ne pose aucun job dans la file partagée, qu'un
 * serveur en marche pourrait exécuter pendant le test. Les confirmations sont
 * rendues ici, par `settlePayment` — le chemin qu'emprunte tout webhook.
 */
const assert = require('assert');
const pool = require('../config/db');
const purchase = require('./alanyaPhonePurchase');
const { settlePayment } = require('./payments/paymentService');
const { generateUniquePhone } = require('./alanyaPhoneService');
const { PHONE_ORDER_STATUS: O } = require('../constants/billing');

const SANS_REPONSE = '699000003';
const comptes = [];

async function creerCompte(nom) {
  const phone = await generateUniquePhone(8);
  const [r] = await pool.execute(
    `INSERT INTO users (nom, pseudo, alanyaPhone, password, idPays, exclus, created_at)
     VALUES (?, ?, ?, 'test-sans-connexion', 10, 1, NOW())`,
    [nom, nom, phone],
  );
  comptes.push(r.insertId);
  return { id: r.insertId, phone };
}

const numeroDe = async (id) => {
  const [[u]] = await pool.execute('SELECT alanyaPhone FROM users WHERE alanyaID = ?', [id]);
  return u.alanyaPhone;
};

const commande = async (id) => {
  const [[o]] = await pool.execute('SELECT * FROM alanya_phone_order WHERE id = ?', [id]);
  return o;
};

const attendreCode = async (fn, code) => {
  try {
    await fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `attendu ${code}, reçu ${e.code} (${e.message})`);
    return e;
  }
  throw new Error(`aurait dû échouer : ${code}`);
};

(async () => {
  try {
    const a = await creerCompte('test-numero-a');
    const b = await creerCompte('test-numero-b');
    const c = await creerCompte('test-numero-c');

    /* ── Le cas nominal ──────────────────────────────────────────────── */
    const x = await generateUniquePhone(8);
    assert.deepStrictEqual(
      (({ available, reason }) => ({ available, reason }))(await purchase.check(a.id, x)),
      { available: true, reason: null },
    );
    const { order } = await purchase.hold(a.id, x);
    assert.strictEqual(order.status, 'held');

    // Un autre compte le voit retenu, et ne peut pas le retenir.
    assert.strictEqual((await purchase.check(b.id, x)).reason, 'held');
    const refus = await attendreCode(() => purchase.hold(b.id, x), 'PHONE_UNAVAILABLE');
    assert.strictEqual(refus.extra.reason, 'held');

    const paiement = await purchase.checkout(a.id, { orderId: order.id, channel: 'orange_money', msisdn: SANS_REPONSE });
    assert.strictEqual(paiement.product, 'phone');
    assert.strictEqual(paiement.amount, 1000);
    assert.strictEqual(Number((await commande(order.id)).status), O.PAYING);
    // Retenu pendant le paiement, même au-delà des 15 minutes.
    assert.strictEqual((await purchase.check(b.id, x, new Date(Date.now() + 60 * 60_000))).reason, 'held');
    // Un second paiement pour la même commande reprend l'attente.
    await attendreCode(
      () => purchase.checkout(a.id, { orderId: order.id, channel: 'orange_money', msisdn: SANS_REPONSE }),
      'PAYMENT_PENDING',
    );

    const r1 = await settlePayment(paiement.paymentId, { outcome: 'succeeded' });
    assert.deepStrictEqual(r1, { status: 'succeeded', changed: true });
    assert.strictEqual(await numeroDe(a.id), x, 'le numéro est posé');
    assert.strictEqual(Number((await commande(order.id)).status), O.APPLIED);
    const [hist] = await pool.execute('SELECT * FROM alanya_phone_history WHERE alanyaID = ?', [a.id]);
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(hist[0].old_phone, a.phone);

    // Confirmation rejouée : sans effet.
    assert.deepStrictEqual(await settlePayment(paiement.paymentId, { outcome: 'succeeded' }), { status: 'succeeded', changed: false });

    /* ── Quarantaine ─────────────────────────────────────────────────── */
    assert.strictEqual((await purchase.check(b.id, a.phone)).reason, 'quarantine', 'un autre attend 90 jours');
    assert.strictEqual((await purchase.check(a.id, a.phone)).available, true, 'l\'ancien titulaire peut le reprendre');
    assert.strictEqual((await purchase.check(a.id, x)).reason, 'same');
    assert.strictEqual((await purchase.check(b.id, x)).reason, 'taken');

    /* ── Paiement refusé : la commande est abandonnée ────────────────── */
    const y = await generateUniquePhone(8);
    const holdY = await purchase.hold(b.id, y);
    const payY = await purchase.checkout(b.id, { orderId: holdY.order.id, channel: 'mtn_momo', msisdn: SANS_REPONSE });
    await settlePayment(payY.paymentId, { outcome: 'failed', failureCode: 'USER_DECLINED' });
    assert.strictEqual(Number((await commande(holdY.order.id)).status), O.ABANDONED);
    assert.strictEqual(await numeroDe(b.id), b.phone, 'numéro inchangé');
    assert.strictEqual((await purchase.check(a.id, y)).available, true, 'le numéro est rendu');

    /* ── Mise de côté échue : un autre peut le prendre ───────────────── */
    const z = await generateUniquePhone(8);
    const holdZ = await purchase.hold(b.id, z, new Date(Date.now() - 20 * 60_000));
    assert.strictEqual((await purchase.check(a.id, z)).available, true);
    await purchase.hold(a.id, z);
    assert.strictEqual(Number((await commande(holdZ.order.id)).status), O.ABANDONED);
    await attendreCode(
      () => purchase.checkout(b.id, { orderId: holdZ.order.id, channel: 'orange_money', msisdn: SANS_REPONSE }),
      'PHONE_HOLD_EXPIRED',
    );
    assert.deepStrictEqual(await purchase.release(a.id), { released: true });

    /* ── Deux comptes, le même numéro, au même instant ───────────────── */
    const w = await generateUniquePhone(8);
    const courses = await Promise.allSettled([purchase.hold(a.id, w), purchase.hold(b.id, w)]);
    assert.strictEqual(courses.filter((p) => p.status === 'fulfilled').length, 1, 'un seul gagne');
    assert.strictEqual(courses.find((p) => p.status === 'rejected').reason.code, 'PHONE_UNAVAILABLE');
    await purchase.release(a.id);
    await purchase.release(b.id);

    /* ── Le filet : numéro pris entre-temps → crédit ─────────────────── */
    const v = await generateUniquePhone(8);
    const holdV = await purchase.hold(b.id, v);
    const payV = await purchase.checkout(b.id, { orderId: holdV.order.id, channel: 'orange_money', msisdn: SANS_REPONSE });
    // La course théorique, provoquée : un autre compte reçoit ce numéro.
    await pool.execute('UPDATE users SET alanyaPhone = ? WHERE alanyaID = ?', [v, c.id]);
    const r2 = await settlePayment(payV.paymentId, { outcome: 'succeeded' });
    assert.strictEqual(r2.status, 'succeeded', 'le paiement reste acquis');
    assert.strictEqual(Number((await commande(holdV.order.id)).status), O.CREDIT);
    assert.strictEqual(await numeroDe(b.id), b.phone);
    const offre = await purchase.offer(b.id);
    assert.strictEqual(offre.credit, true);

    // Le crédit pose le numéro suivant sans paiement.
    const u = await generateUniquePhone(8);
    const applique = await purchase.hold(b.id, u);
    assert.deepStrictEqual(applique, { order: null, applied: true, credit: false, phone: u });
    assert.strictEqual(await numeroDe(b.id), u);
    assert.strictEqual(Number((await commande(holdV.order.id)).status), O.APPLIED);
    const [paiementsB] = await pool.execute('SELECT id FROM payment WHERE alanyaID = ? AND status = 2', [b.id]);
    assert.strictEqual(paiementsB.length, 1, 'un seul paiement réussi pour B');

    console.log('alanyaPhonePurchase.db.test.js OK');
  } catch (err) {
    console.error('ÉCHEC', err);
    process.exitCode = 1;
  } finally {
    if (comptes.length) {
      const [d] = await pool.query('DELETE FROM users WHERE alanyaID IN (?)', [comptes]);
      console.log(`nettoyage : ${d.affectedRows} compte(s) jetable(s) supprimé(s)`);
    }
    await pool.end();
  }
})();
