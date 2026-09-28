const assert = require('assert');

const { mediaExpiryGuard, GONE_MAX_AGE } = require('./mediaExpiry');

const MAINTENANT = Date.parse('2026-08-25T12:00:00Z');
const RETENTION = 30;

/** Réponse Express minimale : on n'observe que ce que le middleware décide. */
function fausseReponse() {
  const res = {
    code: null,
    entetes: {},
    corps: null,
    envoye: null,
    headersSent: false,
    status(c) { this.code = c; return this; },
    set(k, v) { this.entetes[k] = v; return this; },
    setHeader(k, v) { this.entetes[k] = v; },
    json(o) { this.corps = o; return this; },
    sendFile(p) { this.envoye = p; return this; },
  };
  return res;
}

function passer(chemin, { now = MAINTENANT, relayLegacy = true } = {}) {
  const guard = mediaExpiryGuard({ retentionDays: RETENTION, now: () => now, relayLegacy });
  const res = fausseReponse();
  const req = { path: chemin };
  let suivant = false;
  guard(req, res, () => { suivant = true; });
  return { res, suivant, req };
}

// ── Partition échue : 410, sans jamais appeler le stockage ──────────
{
  const { res, suivant } = passer('/media/2026-07-20/images/media_1_1753000000000.jpg');
  assert.strictEqual(suivant, false, 'la requête ne doit pas atteindre mediaRead');
  assert.strictEqual(res.code, 410);
  assert.strictEqual(res.corps.error, 'MEDIA_EXPIRED');
  assert.strictEqual(res.corps.partition, '2026-07-20');
  // La rétention annoncée est celle RÉELLEMENT appliquée à la décision, pas
  // celle de la politique globale : les deux divergent dès qu'un appelant en
  // injecte une autre (surcharge admin, réglage de mise en service).
  assert.strictEqual(res.corps.retentionDays, RETENTION);
  // Un média expiré le reste : le 410 est cachable.
  assert.strictEqual(res.entetes['Cache-Control'], `public, max-age=${GONE_MAX_AGE}`);
}

// ── Partition vivante : on laisse passer ────────────────────────────
{
  const { res, suivant } = passer('/media/2026-08-24/video/media_2_1756000000000.mp4');
  assert.strictEqual(suivant, true);
  assert.strictEqual(res.code, null);
}

// ── La frontière est celle de la partition, pas celle du fichier ────
{
  // Échéance de la partition du 2026-07-20 avec 30 jours : 2026-08-20T00:00Z.
  const veille = passer('/media/2026-07-20/images/x.jpg', {
    now: Date.parse('2026-08-19T23:59:59Z'),
  });
  assert.strictEqual(veille.suivant, true, 'une seconde avant, elle tient encore');

  const pile = passer('/media/2026-07-20/images/x.jpg', {
    now: Date.parse('2026-08-20T00:00:00Z'),
  });
  assert.strictEqual(pile.res.code, 410, "à l'instant pile, elle est expirée");
}

// ── Un avatar n'est jamais concerné ─────────────────────────────────
{
  const { res, suivant } = passer('/images/img_1_1753000000000.jpg');
  assert.strictEqual(suivant, true);
  assert.strictEqual(res.code, null);
}

// ── Chemin hérité encore vivant → relayé vers sa clé de partition ──
{
  // Le nom porte l'horodatage : la partition se recalcule sans rien lire, et
  // `mediaRead` signera le lien de la clé où le fichier a été rangé.
  const recent = Date.parse('2026-08-24T10:00:00Z');
  const { res, suivant, req } = passer(`/media/images/media_1_${recent}.jpg`);
  assert.strictEqual(suivant, true);
  assert.strictEqual(res.code, null);
  assert.strictEqual(req.mediaKey, `media/2026-08-24/images/media_1_${recent}.jpg`);
}

// ── Chemin hérité dont la partition dérivée est échue → 410, pas 404 ──
{
  // Le fichier a été déplacé par la migration, puis sa partition est tombée.
  // Le client doit lire « expiré » et cesser de réessayer, pas « introuvable »
  // qui laisse croire à une panne passagère. La date se lit dans le nom, donc
  // ce verdict ne coûte ni appel au stockage ni requête en base.
  const vieux = Date.parse('2026-07-20T10:00:00Z');
  const { res, suivant } = passer(`/media/images/media_1_${vieux}.jpg`);
  assert.strictEqual(suivant, false);
  assert.strictEqual(res.code, 410);
  assert.strictEqual(res.corps.error, 'MEDIA_EXPIRED');
  assert.strictEqual(res.corps.partition, '2026-07-20');
}

// ── Un nom hors convention n'est jamais relayé ──────────────────────
{
  const { suivant } = passer('/media/images/photo-vacances.jpg');
  assert.strictEqual(suivant, true);
}

// ── Aucune remontée de répertoire ne peut passer par le relais ──────
{
  const { res, suivant, req } = passer('/media/images/..%2F..%2Fetc%2Fpasswd');
  assert.strictEqual(suivant, true);
  assert.strictEqual(res.envoye, null, 'aucun fichier ne doit être servi');
  assert.strictEqual(req.mediaKey, undefined, 'aucune clé fabriquée');
}

// ── Le relais ne dépend PAS de l'interrupteur des partitions ──
{
  // Régression du 25/08/2026 : le relais avait été conditionné à
  // `MEDIA_PARTITIONS_ENABLED`. Le script de migration a déplacé les fichiers,
  // la base pointait toujours vers l'ancien chemin, l'interrupteur était
  // éteint — plus personne ne faisait le pont et TOUS les médias renvoyaient
  // 404 en production.
  //
  // Le relais répond à « ce fichier a-t-il bougé ? », pas à « les partitions
  // sont-elles activées ? ». C'est la migration qui déplace les fichiers, pas
  // l'interrupteur : lier les deux rouvrirait la même fenêtre.
  const vieux = Date.parse('2026-07-20T10:00:00Z');
  const { mediaExpiryGuard: guardParDefaut } = require('./mediaExpiry');
  const guard = guardParDefaut({ retentionDays: RETENTION, now: () => MAINTENANT });
  const res = fausseReponse();
  let suivant = false;
  guard({ path: `/media/images/media_1_${vieux}.jpg` }, res, () => { suivant = true; });

  // Sans option explicite, le relais est actif : il tranche au lieu de laisser
  // filer vers un 404 muet.
  assert.strictEqual(suivant, false, 'le relais doit être actif par défaut');
  assert.strictEqual(res.code, 410);
}

// Un chemin PARTITIONNÉ reste jugé sur son URL en toutes circonstances : une
// extinction de l'interrupteur ne doit pas ressusciter en 404 muets des médias
// déjà supprimés du disque.
{
  const { res } = passer('/media/2026-07-20/images/x.jpg', { relayLegacy: false });
  assert.strictEqual(res.code, 410);
}

// ── Une durée relue à chaque requête ────────────────────────────────
// En service, la durée est le plafond de conservation : il passe à la durée
// Alanya Plus quand l'offre payante s'active, sans redémarrage.
{
  let plafond = RETENTION;
  const guard = mediaExpiryGuard({ retentionDays: () => plafond, now: () => MAINTENANT });
  const demander = () => {
    const res = fausseReponse();
    let suivant = false;
    guard({ path: '/media/2026-07-20/images/x.jpg' }, res, () => { suivant = true; });
    return { res, suivant };
  };

  const avant = demander();
  assert.strictEqual(avant.res.code, 410);
  assert.strictEqual(avant.res.corps.retentionDays, RETENTION);

  plafond = 365;
  const apres = demander();
  assert.strictEqual(apres.suivant, true, 'un abonné peut encore en avoir besoin');
  assert.strictEqual(apres.res.code, null);

}

console.log('mediaExpiry: OK');
