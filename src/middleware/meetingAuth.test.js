/**
 * Gardes d'autorisation des réunions.
 *
 * Faux pool injecté dans `require.cache` AVANT le chargement du middleware :
 * `meetingAccess` recevra celui-ci au lieu d'ouvrir une connexion (modèle de
 * `src/utils/messageSendPolicy.test.js`). Faux `res` Express sur le modèle de
 * `src/middleware/mediaExpiry.test.js` : on n'observe que ce que la garde décide.
 *
 * Ce fichier est la preuve que la règle pure de `meetingAccessRules.js` est bien
 * celle qui décide en production, et pas seulement une fonction bien testée que
 * personne n'appelle.
 */
const assert = require('assert');
const path = require('path');

const dbPath = require.resolve('../config/db');
let calls = [];
let responses = [];
const fakePool = {
  execute: async (sql, params) => {
    calls.push({ sql, params });
    return [responses.shift() ?? [], []];
  },
};
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakePool,
  paths: [],
  children: [],
};

const {
  requireMeetingParticipant,
  requireMeetingOrganiser,
} = require(path.join(__dirname, 'meetingAuth'));

/** Réponse Express minimale : on n'observe que le code et le corps. */
function fausseReponse() {
  return {
    code: null,
    corps: null,
    status(c) { this.code = c; return this; },
    json(o) { this.corps = o; return this; },
  };
}

/** Ligne rendue par le LEFT JOIN de `loadMeetingAccess`. */
const ligne = ({ organiser, participant }) => ({
  idMeeting: 7,
  idOrganiser: organiser,
  isEnd: 0,
  type_media: 0,
  duree: 60,
  start_time: new Date('2026-09-03T10:00:00Z'),
  room: 'mtg-1756890000000',
  participantStatus: participant ? 1 : null,
  estParticipant: participant ? 1 : 0,
});

/** Joue une chaîne de middlewares ; s'arrête dès que l'un répond. */
async function jouer(chaine, req) {
  const res = fausseReponse();
  let atteintLeControleur = false;
  const maillons = Array.isArray(chaine) ? chaine : [chaine];
  for (let i = 0; i < maillons.length; i += 1) {
    let suivant = false;
    // eslint-disable-next-line no-await-in-loop
    await maillons[i](req, res, (err) => {
      if (err) throw err;
      suivant = true;
    });
    if (!suivant) return { res, atteintLeControleur };
    if (i === maillons.length - 1) atteintLeControleur = true;
  }
  return { res, atteintLeControleur };
}

const requete = (id, alanyaID) => ({ params: { id: String(id) }, user: { alanyaID } });

async function main() {
  /* ── Un étranger ne sait pas que la réunion existe ── */
  calls = [];
  responses = [[ligne({ organiser: 99, participant: false })]];
  let r = await jouer(requireMeetingParticipant, requete(7, 42));
  assert.strictEqual(r.res.code, 404, 'un non-membre reçoit 404');
  assert.strictEqual(r.atteintLeControleur, false, 'le contrôleur n’est pas atteint');
  assert.strictEqual(calls.length, 1, 'la garde ne coûte qu’un aller-retour SQL');

  /* ── Une réunion inexistante répond exactement pareil ── */
  // Corps identiques, sinon la route redevient un oracle d'existence.
  const corpsEtranger = r.res.corps;
  calls = [];
  responses = [[]];
  r = await jouer(requireMeetingParticipant, requete(7, 42));
  assert.strictEqual(r.res.code, 404);
  assert.deepStrictEqual(
    r.res.corps,
    corpsEtranger,
    'refus et inexistence doivent être indiscernables',
  );

  /* ── L'invité lit ── */
  calls = [];
  responses = [[ligne({ organiser: 99, participant: true })]];
  r = await jouer(requireMeetingParticipant, requete(7, 42));
  assert.strictEqual(r.res.code, null, 'aucun refus pour un invité');
  assert.strictEqual(r.atteintLeControleur, true);

  /* ── ... mais ne supprime pas : 403, et le DELETE n'est jamais atteint ── */
  // C'est le cœur de B3 : la route supprimait les lignes `participant` avant
  // tout contrôle, puis répondait 200. Ici le contrôleur ne tourne pas du tout.
  calls = [];
  responses = [[ligne({ organiser: 99, participant: true })]];
  r = await jouer(requireMeetingOrganiser, requete(7, 42));
  assert.strictEqual(r.res.code, 403, 'un membre non organisateur reçoit 403');
  assert.strictEqual(r.res.corps.code, 'MEETING_ORGANISER_REQUIRED');
  assert.strictEqual(r.atteintLeControleur, false, 'aucune suppression n’est atteinte');
  assert.ok(
    !calls.some((c) => /DELETE/i.test(c.sql)),
    'aucun DELETE ne doit avoir été émis',
  );

  /* ── Un étranger visant une suppression tombe sur le 404, pas sur le 403 ── */
  calls = [];
  responses = [[ligne({ organiser: 99, participant: false })]];
  r = await jouer(requireMeetingOrganiser, requete(7, 42));
  assert.strictEqual(r.res.code, 404, 'le 403 révélerait l’existence de la réunion');

  /* ── L'organisateur passe les deux maillons ── */
  calls = [];
  responses = [[ligne({ organiser: 42, participant: true })]];
  r = await jouer(requireMeetingOrganiser, requete(7, 42));
  assert.strictEqual(r.res.code, null);
  assert.strictEqual(r.atteintLeControleur, true, 'l’organisateur atteint le contrôleur');

  /* ── ... même sans ligne `participant` ── */
  // Une purge ne doit pas l'enfermer dehors de sa propre réunion.
  calls = [];
  responses = [[ligne({ organiser: 42, participant: false })]];
  r = await jouer(requireMeetingOrganiser, requete(7, 42));
  assert.strictEqual(r.res.code, null);
  assert.strictEqual(r.atteintLeControleur, true);

  /* ── Identifiant invalide : refus avant toute requête ── */
  calls = [];
  responses = [];
  r = await jouer(requireMeetingParticipant, requete('abc', 42));
  assert.strictEqual(r.res.code, 400);
  assert.strictEqual(calls.length, 0, 'un identifiant invalide n’interroge pas la base');

  console.log('✓ meetingAuth : 404 indifférencié, 403 entre membres, aucune écriture avant contrôle');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
