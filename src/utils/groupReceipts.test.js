const assert = require('assert');
const {
  statutPourLecteur,
  appliquerStatutLecteur,
  classerAccuses,
} = require('./groupReceipts');

// Accusés par membre dans les groupes (migration 096, groupe 3GI 2029).
// Fonctions pures : aucune base.

// ── Statut vu par le lecteur (bug A6) ──
{
  const lecteur = { lecteurID: 10, isGroup: true, lastReadMsgID: 100 };

  // Lu par un autre membre (status 3), mais pas par moi : au plus « reçu ».
  assert.strictEqual(statutPourLecteur({ status: 3, senderID: 2, msgID: 150 }, lecteur), 2);
  // Sous mon repère : lu.
  assert.strictEqual(statutPourLecteur({ status: 2, senderID: 2, msgID: 100 }, lecteur), 3);
  // Encore « envoyé » côté serveur : reste 1.
  assert.strictEqual(statutPourLecteur({ status: 1, senderID: 2, msgID: 150 }, lecteur), 1);
  // Mes propres messages : statut global (coches bleues dès le premier lecteur).
  assert.strictEqual(statutPourLecteur({ status: 3, senderID: 10, msgID: 150 }, lecteur), 3);
  // Discussion à deux : inchangé.
  assert.strictEqual(
    statutPourLecteur({ status: 3, senderID: 2, msgID: 150 }, { ...lecteur, isGroup: false }),
    3,
  );
  // Repère inconnu : statut brut, comme avant la migration.
  assert.strictEqual(
    statutPourLecteur({ status: 3, senderID: 2, msgID: 150 }, { ...lecteur, lastReadMsgID: null }),
    3,
  );
}

// appliquerStatutLecteur lit les champs techniques de la requête et les retire.
{
  const rows = [
    { msgID: 150, senderID: 2, status: 3, _isGroup: 1, _lastReadMsgID: 100 },
    { msgID: 90, senderID: 2, status: 3, _isGroup: 1, _lastReadMsgID: 100 },
  ];
  appliquerStatutLecteur(rows, 10);
  assert.deepStrictEqual(rows.map((r) => r.status), [2, 3]);
  assert.ok(!('_isGroup' in rows[0]) && !('_lastReadMsgID' in rows[0]), 'champs techniques retirés');

  // Valeurs fournies par l'appelant (getMessages : une seule conversation).
  const page = [{ msgID: 150, senderID: 2, status: 3, _lastReadMsgID: 100 }];
  appliquerStatutLecteur(page, 10, { isGroup: true });
  assert.strictEqual(page[0].status, 2);
}

// ── Classement lu / reçu / en attente (« Infos du message ») ──
{
  const message = { msgID: 200, senderID: 1, sendAt: '2026-10-09T10:00:00Z' };
  const membres = [
    { alanyaID: 1, nom: 'Moi', lastReadMsgID: 200, lastDeliveredMsgID: 200 },
    { alanyaID: 2, nom: 'Aaron', lastReadMsgID: 250, lastDeliveredMsgID: 250 },
    { alanyaID: 3, nom: 'Lys', lastReadMsgID: 199, lastDeliveredMsgID: 210 },
    { alanyaID: 4, nom: 'Richy', lastReadMsgID: 150, lastDeliveredMsgID: 150 },
    { alanyaID: 5, nom: 'Epsilon', lastReadMsgID: null, lastDeliveredMsgID: null },
    // Arrivé après l'envoi : exclu.
    { alanyaID: 6, nom: 'Nouveau', joinedAt: '2026-10-09T11:00:00Z', lastReadMsgID: 300 },
    // Historique masqué au-delà de l'envoi : exclu.
    { alanyaID: 7, nom: 'Masqué', historyCutoffAt: '2026-10-09T10:30:00Z', lastReadMsgID: 300 },
    // Lu, mais avant la migration : pas d'heure.
    { alanyaID: 8, nom: 'Ancien', lastReadMsgID: 220, lastDeliveredMsgID: 220 },
  ];
  const r = classerAccuses({
    message,
    membres,
    heuresLecture: new Map([[2, '2026-10-09T10:05:00Z']]),
    heuresReception: new Map([[3, '2026-10-09T10:01:00Z']]),
  });

  assert.deepStrictEqual(r.read.map((m) => m.alanyaID), [2, 8], 'lus, heure inconnue en dernier');
  assert.strictEqual(r.read[0].at, '2026-10-09T10:05:00.000Z');
  assert.strictEqual(r.read[1].at, null);
  assert.deepStrictEqual(r.delivered.map((m) => m.alanyaID), [3]);
  assert.strictEqual(r.delivered[0].at, '2026-10-09T10:01:00.000Z');
  assert.deepStrictEqual(r.pending.map((m) => m.alanyaID).sort(), [4, 5]);
  assert.strictEqual(r.total, 5, 'expéditeur et arrivés après exclus');
  assert.strictEqual(r.readCount, 2);
  assert.strictEqual(r.deliveredCount, 3, 'reçu par = lus + reçus');
  assert.strictEqual(r.sentAt, '2026-10-09T10:00:00.000Z');
}

console.log('groupReceipts.test.js OK');
