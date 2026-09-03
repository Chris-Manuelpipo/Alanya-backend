/**
 * Règles d'accès aux réunions. Aucune base : le module testé n'ouvre aucune
 * connexion, donc pas de faux pool, pas de `pool.end()`.
 */
const assert = require('assert');
const {
  verdictLecture,
  verdictOrganisateur,
  verdictEntree,
} = require('./meetingAccessRules');

const organisateur = { existe: true, estOrganisateur: true, estParticipant: true };
const organisateurSansLigne = { existe: true, estOrganisateur: true, estParticipant: false };
const invite = { existe: true, estOrganisateur: false, estParticipant: true };
const etranger = { existe: true, estOrganisateur: false, estParticipant: false };
const inexistante = { existe: false, estOrganisateur: false, estParticipant: false };

/* ── L'organisateur passe partout ── */
assert.strictEqual(verdictLecture(organisateur), 'ok');
assert.strictEqual(verdictOrganisateur(organisateur), 'ok');
assert.strictEqual(verdictEntree(organisateur), 'ok');

/* ── ... même si sa ligne `participant` a disparu ── */
// Son accès ne doit pas dépendre d'une ligne qu'une purge pourrait emporter :
// il serait enfermé dehors de sa propre réunion.
assert.strictEqual(verdictLecture(organisateurSansLigne), 'ok');
assert.strictEqual(verdictOrganisateur(organisateurSansLigne), 'ok');

/* ── L'invité lit et entre, mais ne dispose pas ── */
assert.strictEqual(verdictLecture(invite), 'ok');
assert.strictEqual(verdictEntree(invite), 'ok');
assert.strictEqual(
  verdictOrganisateur(invite),
  'non_organisateur',
  'un invité est bien membre : il a droit à la raison du refus, donc 403',
);

/* ── L'étranger ne sait même pas que la réunion existe ── */
assert.strictEqual(verdictLecture(etranger), 'introuvable');
assert.strictEqual(verdictEntree(etranger), 'introuvable');
assert.strictEqual(
  verdictOrganisateur(etranger),
  'introuvable',
  'jamais non_organisateur pour un étranger : ce code révélerait l’existence',
);

/* ── Une réunion inexistante répond exactement comme un refus ── */
// Les deux corps de réponse doivent être indiscernables, sans quoi la route
// devient un oracle d'existence — c'est ce que permettait `getMeetingByRoom`,
// dont le code de salon (`mtg-<millisecondes>`) est énumérable.
assert.strictEqual(verdictLecture(inexistante), 'introuvable');
assert.strictEqual(verdictOrganisateur(inexistante), 'introuvable');
assert.strictEqual(verdictEntree(inexistante), 'introuvable');

/* ── Champs absents : refus par défaut, jamais d'accès par omission ── */
assert.strictEqual(verdictLecture({}), 'introuvable');
assert.strictEqual(verdictOrganisateur({}), 'introuvable');
assert.strictEqual(verdictEntree({}), 'introuvable');

console.log('✓ meetingAccessRules : verdicts de lecture, d’organisateur et d’entrée');
