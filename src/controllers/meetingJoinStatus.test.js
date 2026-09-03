/**
 * Écritures de `participant.status` : « accepté » devient « a rejoint ».
 *
 * Avant ce lot, `inviteParticipants` insérait `status = 1` — le badge du
 * détail de réunion affichait donc « Accepté » pour tout invité, même
 * n'ayant jamais ouvert l'application. Ce fichier prouve que l'écriture a
 * changé de valeur là où elle compte : à l'invitation, à la création, au
 * premier join réel.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du contrôleur.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let calls = [];
let responses = [];
const fakePool = {
  execute: async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [responses.shift() ?? [], []];
  },
  end: async () => {},
};
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakePool,
  paths: [],
  children: [],
};

// notificationService charge Firebase au premier require : neutralisé, seule
// l'écriture SQL nous intéresse ici.
const notifPath = require.resolve('../services/notificationService');
require.cache[notifPath] = {
  id: notifPath,
  filename: notifPath,
  loaded: true,
  paths: [],
  children: [],
  exports: { notifyMeetingInvite: async () => {} },
};

const {
  createMeeting,
  joinMeeting,
  inviteParticipants,
} = require('./meetingController');

function fausseReponse() {
  return {
    code: null,
    corps: null,
    status(c) { this.code = c; return this; },
    json(o) { this.corps = o; return this; },
  };
}

async function main() {
  /* ── L'invitation n'inscrit plus « accepté » ── */
  calls = [];
  responses = [
    [{ idMeeting: 7, idOrganiser: 42, type_media: 0 }], // SELECT meeting + organiser
    [{ total: 1 }],                                     // COUNT(*) participant
    [],                                                  // SELECT existing
    [],                                                  // INSERT participant
  ];
  await inviteParticipants(
    { params: { id: 7 }, body: { participant_ids: [99] }, user: { alanyaID: 42 } },
    fausseReponse(),
  );
  const insertInvite = calls.find((c) => /INSERT INTO participant/.test(c.sql));
  assert.ok(insertInvite, 'un INSERT doit avoir eu lieu');
  assert.match(
    insertInvite.sql,
    /VALUES \(\?, \?, 0, NOW\(\), 0, 0\)/,
    'status = 0 à l’invitation : « en attente », pas « a rejoint »',
  );

  /* ── L'organisateur est « a rejoint » dès la création, sans être connecté ── */
  calls = [];
  responses = [
    [{ insertId: 7 }],                    // INSERT meeting
    [],                                    // INSERT participant (organisateur)
    [{ idMeeting: 7, organiser_nom: 'Awa' }], // SELECT meeting jointe
    [],                                     // SELECT participants
  ];
  await createMeeting(
    {
      body: { start_time: '2026-09-03T10:00:00Z', duree: 60, objet: 'Point', room: 'r1' },
      user: { alanyaID: 42 },
    },
    fausseReponse(),
  );
  const insertOrga = calls.find((c) => /INSERT INTO participant/.test(c.sql));
  assert.match(
    insertOrga.sql,
    /VALUES \(\?, \?, 1, NOW\(\), 0, 0\)/,
    'organisateur : status = 1 (a rejoint) mais connecte = 0 (pas encore réellement)',
  );

  /* ── Le premier join réel fait passer status à 1 ── */
  calls = [];
  responses = [
    // req.meetingAccess est posé par le middleware ; joinMeeting ne relit plus
    // la réunion — voir meetingAuth.js. La ligne `participant` de l'appelant
    // est en revanche relue ici pour distinguer premier join et retour.
    [{ ID: 1, status: 0 }], // SELECT existing : déjà invité
    [],                      // UPDATE participant
  ];
  await joinMeeting(
    {
      params: { id: 7 },
      user: { alanyaID: 99 },
      meetingAccess: {
        existe: true, idMeeting: 7, idOrganiser: 42, isEnd: false,
        typeMedia: 0, duree: 60, startTime: new Date(), room: 'r1',
        estOrganisateur: false, estParticipant: true, participantStatus: 0,
        echue: false,
      },
    },
    fausseReponse(),
  );
  const update = calls.find((c) => /UPDATE participant/.test(c.sql));
  assert.ok(update, 'un UPDATE doit avoir eu lieu pour un participant déjà invité');
  assert.match(
    update.sql,
    /UPDATE participant SET status = 1, start_time = NOW\(\)/,
    'le premier join réel écrit status = 1',
  );

  console.log('✓ meetingJoinStatus : « a rejoint » écrit à l’invitation (0), à la création (organisateur) et au join (1)');
}

main()
  .then(() => fakePool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
