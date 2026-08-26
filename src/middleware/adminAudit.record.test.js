/**
 * Ce que le journal d'audit écrit réellement.
 *
 * `adminAudit.test.js` vérifie la carte route → action et l'extraction du
 * motif, sans base. Celui-ci fait passer de vraies requêtes par le middleware
 * et lit ce qui atterrit dans `admin_audit`, puis retire ses lignes.
 *
 * Les deux garanties qui comptent ici ne se voient qu'à l'écriture : le corps
 * de la requête ne fuit pas, et une route mutante inconnue laisse une trace
 * exploitable au lieu d'un silence.
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const pool = require('../config/db');
const { adminAudit } = require('./adminAudit');

const ecrites = [];

function fakeReq({ method, path, params = {}, body = {}, user }) {
  return {
    method,
    route: { path },
    params,
    body,
    user,
    ip: '198.51.100.7',
    get: (h) => (h.toLowerCase() === 'user-agent' ? 'test-agent' : undefined),
  };
}

/** Rejoue le cycle d'Express : middleware, puis `finish` une fois la réponse partie. */
function passer(req, statusCode) {
  return new Promise((resolve) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    adminAudit(req, res, () => {});
    res.emit('finish');
    // L'écriture est détachée à dessein — elle ne doit pas retarder la réponse.
    setTimeout(resolve, 400);
  });
}

(async () => {
  let admin;
  try {
    const [[a]] = await pool.execute(
      'SELECT alanyaID FROM users WHERE type_compte >= 1 AND exclus = 0 ORDER BY alanyaID LIMIT 1',
    );
    assert.ok(a, 'il faut un compte administrateur');
    admin = a.alanyaID;
    const user = { alanyaID: admin };

    const [[avant]] = await pool.execute(
      'SELECT COALESCE(MAX(id), 0) AS max FROM admin_audit',
    );

    /* ── Une route cartographiée, avec son motif ─────────────────────── */
    await passer(fakeReq({
      method: 'POST', path: '/users/:id/ban', params: { id: '4242' },
      body: { reason: 'motif de test' }, user,
    }), 200);

    /* ── Une route mutante que la carte ne décrit pas ────────────────── */
    await passer(fakeReq({
      method: 'PUT', path: '/route/:id/inconnue', params: { id: '7' }, user,
    }), 200);

    /* ── Un mot de passe ne doit laisser aucune trace ────────────────── */
    await passer(fakeReq({
      method: 'PUT', path: '/me/password',
      body: { currentPassword: 'tres-secret', newPassword: 'encore-plus-secret' }, user,
    }), 200);

    /* ── Ce qui ne doit RIEN écrire ──────────────────────────────────── */
    // Une action refusée n'a rien modifié ; la journaliser noierait les vraies
    // sous les tentatives malformées.
    await passer(fakeReq({ method: 'DELETE', path: '/users/:id', params: { id: '1' }, user }), 403);
    await passer(fakeReq({ method: 'POST', path: '/users/:id/ban', params: { id: '1' }, user }), 500);
    // Une lecture n'est pas une action.
    await passer(fakeReq({ method: 'GET', path: '/users', user }), 200);
    // Une route explicitement écartée non plus.
    await passer(fakeReq({ method: 'POST', path: '/broadcasts/estimate', user }), 200);
    // Et sans administrateur identifié, rien ne s'écrit.
    await passer(fakeReq({ method: 'POST', path: '/users', user: undefined }), 200);

    const [lignes] = await pool.execute(
      `SELECT id, action, route, target_type, target_id, reason, ip, user_agent, status_code
       FROM admin_audit WHERE id > ? ORDER BY id`,
      [avant.max],
    );
    ecrites.push(...lignes.map((l) => l.id));

    assert.strictEqual(lignes.length, 3, `3 lignes attendues, ${lignes.length} écrites`);

    const parAction = Object.fromEntries(lignes.map((l) => [l.action, l]));

    const ban = parAction['users.ban'];
    assert.ok(ban, 'la route cartographiée doit produire son verbe métier');
    assert.strictEqual(ban.target_type, 'user');
    assert.strictEqual(ban.target_id, '4242');
    assert.strictEqual(ban.reason, 'motif de test');
    assert.strictEqual(ban.ip, '198.51.100.7');
    assert.strictEqual(ban.user_agent, 'test-agent');
    assert.strictEqual(ban.status_code, 200);

    const inconnue = parAction.unmapped;
    assert.ok(inconnue, 'une route mutante inconnue doit laisser une trace');
    assert.strictEqual(
      inconnue.route,
      'PUT /route/:id/inconnue',
      'sans le chemin, une ligne `unmapped` ne mène nulle part',
    );
    assert.strictEqual(inconnue.target_type, null);

    const motdepasse = parAction['profile.password'];
    assert.ok(motdepasse);
    assert.strictEqual(motdepasse.reason, null, 'le corps ne doit pas être recopié');

    // Le filet : aucun secret nulle part dans ce qui a été écrit.
    const tout = JSON.stringify(lignes);
    for (const secret of ['tres-secret', 'encore-plus-secret', 'currentPassword']) {
      assert.ok(!tout.includes(secret), `« ${secret} » ne doit pas apparaître dans le journal`);
    }

    console.log(`adminAudit.record.test.js OK — 3 lignes écrites sur 8 requêtes`);
  } catch (err) {
    console.error('ÉCHEC :', err.message);
    process.exitCode = 1;
  } finally {
    if (ecrites.length) {
      const [d] = await pool.query('DELETE FROM admin_audit WHERE id IN (?)', [ecrites]);
      if (d.affectedRows !== ecrites.length) {
        console.error(`⚠ nettoyage incomplet : ${d.affectedRows}/${ecrites.length}`);
        process.exitCode = 1;
      }
    }
    process.exit();
  }
})();
