const assert = require('assert');
const jwt = require('jsonwebtoken');
const pool = require('../../config/db');
const { adminOps, notifyAdmins, ADMIN_ROOM } = require('./adminOps');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';

/** Socket minimale : on n'observe que ce que le handler en fait. */
function fakeSocket() {
  const s = {
    data: {},
    rooms: [],
    emitted: [],
    handlers: {},
    on: (event, fn) => { s.handlers[event] = fn; },
    join: (room) => s.rooms.push(room),
    emit: (event, payload) => s.emitted.push({ event, payload }),
  };
  return s;
}

const login = async (socket, token) => {
  await socket.handlers['admin:login']({ token });
};

const token = (payload) => jwt.sign({ type: 'access', ...payload }, JWT_SECRET, { expiresIn: '5m' });

(async () => {
  try {
    const [[admin]] = await pool.execute(
      'SELECT alanyaID FROM users WHERE type_compte >= 1 AND exclus = 0 LIMIT 1',
    );
    const [[simple]] = await pool.execute(
      'SELECT alanyaID FROM users WHERE type_compte = 0 AND exclus = 0 LIMIT 1',
    );
    assert.ok(admin && simple, 'il faut un compte admin et un compte ordinaire');

    /* ── Un administrateur rejoint le salon ──────────────────────────── */
    let s = fakeSocket();
    adminOps(null, s);
    await login(s, token({ alanyaID: admin.alanyaID }));
    assert.deepStrictEqual(s.rooms, [ADMIN_ROOM], 'l’admin doit rejoindre admin_ops');
    assert.strictEqual(s.emitted[0].event, 'admin:ready');
    assert.strictEqual(s.data.adminId, admin.alanyaID);

    /* ── Un compte ordinaire est refusé ──────────────────────────────── */
    // Le rôle est relu en base et jamais tiré du jeton : c'est ce qui ferme la
    // fenêtre pendant laquelle un compte rétrogradé garde un token valide.
    s = fakeSocket();
    adminOps(null, s);
    await login(s, token({ alanyaID: simple.alanyaID }));
    assert.deepStrictEqual(s.rooms, [], 'un compte ordinaire ne rejoint rien');
    assert.strictEqual(s.emitted[0].event, 'admin:error');

    /* ── Un jeton forgé prétendant un rôle ne sert à rien ────────────── */
    s = fakeSocket();
    adminOps(null, s);
    await login(s, token({ alanyaID: simple.alanyaID, typeCompte: 2, type_compte: 2 }));
    assert.deepStrictEqual(s.rooms, [], 'le rôle du jeton est ignoré');

    /* ── Jetons invalides ────────────────────────────────────────────── */
    s = fakeSocket();
    adminOps(null, s);
    await login(s, 'pas-un-jeton');
    assert.strictEqual(s.emitted[0].payload.message, 'Token invalide');

    s = fakeSocket();
    adminOps(null, s);
    await login(s, undefined);
    assert.strictEqual(s.emitted[0].payload.message, 'Token requis');

    // Un jeton de rafraîchissement ne doit pas ouvrir le canal.
    s = fakeSocket();
    adminOps(null, s);
    await login(s, jwt.sign({ type: 'refresh', alanyaID: admin.alanyaID }, JWT_SECRET));
    assert.strictEqual(s.emitted[0].payload.message, 'Type de token invalide');

    /* ── L'émission ne fait jamais échouer son appelant ──────────────── */
    // Un trajet qui bascule ne doit pas échouer parce qu'aucun administrateur
    // n'a le panneau ouvert, ni parce que le serveur socket est absent.
    assert.doesNotThrow(() => notifyAdmins(null, 'admin:trip_alert', { state: 'sos' }));
    const envoyes = [];
    const io = { to: () => ({ emit: (e, p) => envoyes.push({ e, p }) }) };
    notifyAdmins(io, 'admin:trip_alert', { state: 'sos', kind: 'taxi' });
    assert.strictEqual(envoyes.length, 1);
    assert.strictEqual(envoyes[0].p.kind, 'taxi');
    assert.ok(envoyes[0].p.at, 'l’horodatage est ajouté par le canal');
    // Ce que le canal ne transporte pas, et qui est le cœur de la décision.
    for (const interdit of ['tripId', 'ownerId', 'lat', 'lng', 'alanyaID']) {
      assert.ok(!(interdit in envoyes[0].p), `${interdit} ne doit pas circuler`);
    }

    console.log('adminOps.test.js OK');
  } catch (e) {
    console.error('ÉCHEC :', e.message);
    process.exitCode = 1;
  } finally {
    process.exit();
  }
})();
