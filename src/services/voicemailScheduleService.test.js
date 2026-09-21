/**
 * Planification du répondeur : cascade de fuseau, règles de créneau, échéance.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du service — même
 * procédé que `src/services/securitySettingsService.test.js`. Aucune base n'est
 * nécessaire, et c'est voulu : la migration 086 s'applique à la main, ce test
 * doit passer sur une base qui ne l'a pas encore reçue.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let requetes = [];
/** 'ok' = la table répond ; 'absente' = migration 086 non jouée. */
let mode = 'ok';
let ligneUser = null;
let membresListe = [];

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    requetes.push({ sql: texte, params });
    if (mode === 'absente') {
      const e = new Error("Table 'user_voicemail_schedule' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    if (/FROM contact_list_member/.test(texte)) {
      const [idList, idFriend] = params;
      const trouve = membresListe.some(
        (m) => Number(m.idList) === Number(idList) && Number(m.idFriend) === Number(idFriend),
      );
      return [trouve ? [{ 1: 1 }] : [], []];
    }
    if (/^INSERT INTO user_voicemail_schedule/.test(texte)) {
      ligneUser = {
        ...ligneUser,
        enabled: Number(params[1]),
        startTime: params[2],
        endTime: params[3],
        daysBitmask: Number(params[4]),
        untilAt: params[5],
        timezone: params[6],
        bypassListId: params[7],
      };
      return [{ affectedRows: 1 }, []];
    }
    return [ligneUser ? [{ ...ligneUser }] : [], []];
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

const s = require('./voicemailScheduleService');

const creneau = (patch = {}) => ({ ...s.DEFAULT_SCHEDULE, ...patch });

async function main() {
  /* ══ Cascade de fuseau ══ */

  assert.strictEqual(s.isValidTimezone('Africa/Douala'), true);
  assert.strictEqual(s.isValidTimezone('Europe/Paris'), true);
  assert.strictEqual(s.isValidTimezone('WAT'), false, 'une abréviation n’est pas un identifiant IANA');
  assert.strictEqual(s.isValidTimezone(''), false);
  assert.strictEqual(s.isValidTimezone(null), false);

  assert.strictEqual(
    s.resolveTimezone({ scheduleTimezone: 'Europe/Paris', countryTimezone: 'Africa/Douala' }),
    'Europe/Paris',
    'ce que l’appareil a posé prime sur le pays du compte',
  );
  assert.strictEqual(
    s.resolveTimezone({ scheduleTimezone: null, countryTimezone: 'Africa/Lagos' }),
    'Africa/Lagos',
    'sans fuseau posé, le pays du compte prend le relais',
  );
  // Un fuseau hérité et illisible ne doit pas faire échouer l'appel : on
  // descend simplement d'un étage.
  assert.strictEqual(
    s.resolveTimezone({ scheduleTimezone: 'Mars/Olympus', countryTimezone: 'Africa/Lagos' }),
    'Africa/Lagos',
  );
  const sansRien = s.resolveTimezone({});
  assert.ok(s.isValidTimezone(sansRien), 'le dernier recours est toujours un fuseau valide');

  /* ══ Heure murale : les deux pièges ══ */

  // Minuit pile. `hour` vaut '24' sur certaines implémentations avec
  // hour12:false ; non ramené modulo 24 il décale d'un jour entier.
  const minuit = new Date('2026-09-21T23:00:00Z'); // 00:00 le 22 à Douala (UTC+1)
  const cMinuit = s.civilPartsInZone(minuit, 'Africa/Douala');
  assert.strictEqual(cMinuit.h, 0, 'minuit doit valoir 0, jamais 24');
  assert.strictEqual(cMinuit.minutes, 0);
  assert.strictEqual(cMinuit.d, 22, 'et le jour doit avoir avancé');

  // bit0 = lundi. Le 21 septembre 2026 est un lundi.
  const lundi = s.civilPartsInZone(new Date('2026-09-21T12:00:00Z'), 'Africa/Douala');
  assert.strictEqual(lundi.dayBit, 0, 'lundi = bit0');
  const dimanche = s.civilPartsInZone(new Date('2026-09-20T12:00:00Z'), 'Africa/Douala');
  assert.strictEqual(dimanche.dayBit, 6, 'dimanche = bit6');

  // Le fuseau change la date civile, donc le jour de la semaine.
  const tardParis = new Date('2026-09-20T23:30:00Z'); // dimanche 23:30 UTC
  assert.strictEqual(s.civilPartsInZone(tardParis, 'Europe/Paris').dayBit, 0, 'déjà lundi à Paris');
  assert.strictEqual(s.civilPartsInZone(tardParis, 'America/Toronto').dayBit, 6, 'encore dimanche à Toronto');

  assert.strictEqual(s.civilDayKey(minuit, 'Africa/Douala'), '2026-09-22');
  assert.strictEqual(
    s.civilDayKey(minuit, 'America/Toronto'),
    '2026-09-21',
    'la clé de journée suit le fuseau : encore le 21 à Toronto',
  );

  /* ══ Activation ponctuelle : un instant absolu, sans fuseau ══ */

  const maintenant = new Date('2026-09-21T12:00:00Z');

  assert.strictEqual(
    s.isUntilActive(creneau({ untilAt: '2026-09-21T13:00:00Z' }), maintenant),
    true,
  );
  assert.strictEqual(
    s.isUntilActive(creneau({ untilAt: '2026-09-21T11:59:59Z' }), maintenant),
    false,
    'une échéance passée vaut inactif — rien ne la purge, et c’est voulu',
  );
  assert.strictEqual(s.isUntilActive(creneau({ untilAt: null }), maintenant), false);
  assert.strictEqual(
    s.isUntilActive(creneau({ untilAt: 'pas une date' }), maintenant),
    false,
    'une valeur illisible ne doit pas intercepter',
  );

  // L'échéance ponctuelle l'emporte sur une règle récurrente éteinte.
  assert.strictEqual(
    s.isVoicemailActive(creneau({ enabled: 0, untilAt: '2026-09-21T13:00:00Z' }), maintenant, 'Africa/Douala'),
    true,
  );
  // Et elle est insensible au fuseau, par construction.
  assert.strictEqual(
    s.isVoicemailActive(creneau({ untilAt: '2026-09-21T13:00:00Z' }), maintenant, 'America/Toronto'),
    true,
  );

  /* ══ Règle récurrente ══ */

  // Fenêtre ordinaire 09:00–17:00, tous les jours.
  const bureau = creneau({ enabled: 1, startTime: '09:00:00', endTime: '17:00:00', daysBitmask: 127 });
  const a = (iso, tz = 'Africa/Douala') => s.isRecurringActive(bureau, new Date(iso), tz);
  assert.strictEqual(a('2026-09-21T09:30:00Z'), true, '10:30 à Douala, dans la fenêtre');
  assert.strictEqual(a('2026-09-21T07:00:00Z'), false, '08:00 à Douala, avant');
  assert.strictEqual(a('2026-09-21T16:30:00Z'), false, '17:30 à Douala, après');
  // La borne haute est exclusive, la borne basse inclusive.
  assert.strictEqual(a('2026-09-21T08:00:00Z'), true, '09:00 pile : dedans');
  assert.strictEqual(a('2026-09-21T16:00:00Z'), false, '17:00 pile : dehors');

  // Le même instant, deux fuseaux, deux verdicts opposés — c'est tout l'objet
  // de cette colonne, et ce que `isDndActive` ne sait pas faire.
  assert.strictEqual(
    a('2026-09-21T16:30:00Z', 'America/Toronto'),
    true,
    '17:30 à Douala (dehors) mais 12:30 à Toronto (dedans)',
  );

  // Fenêtre franchissant minuit, 22:00–07:00.
  const nuit = creneau({ enabled: 1, startTime: '22:00:00', endTime: '07:00:00', daysBitmask: 127 });
  const n = (iso) => s.isRecurringActive(nuit, new Date(iso), 'Africa/Douala');
  assert.strictEqual(n('2026-09-21T22:00:00Z'), true, '23:00 : dedans');
  assert.strictEqual(n('2026-09-21T02:00:00Z'), true, '03:00 : dedans, de l’autre côté de minuit');
  assert.strictEqual(n('2026-09-21T12:00:00Z'), false, '13:00 : dehors');

  // Le bit testé est TOUJOURS celui du jour courant, y compris après minuit.
  // Sémantique reprise telle quelle de `isDndActive` : une fenêtre de nuit
  // réglée du lundi au vendredi s'arrête à minuit le vendredi.
  const semaine = creneau({ enabled: 1, startTime: '22:00:00', endTime: '07:00:00', daysBitmask: 0b0011111 });
  assert.strictEqual(
    s.isRecurringActive(semaine, new Date('2026-09-25T22:00:00Z'), 'Africa/Douala'),
    true,
    'vendredi 23:00 : vendredi est coché',
  );
  assert.strictEqual(
    s.isRecurringActive(semaine, new Date('2026-09-26T02:00:00Z'), 'Africa/Douala'),
    false,
    'samedi 03:00 : samedi n’est pas coché, la fenêtre s’arrête à minuit',
  );

  // Aucun jour coché : la règle ne s'applique jamais.
  assert.strictEqual(
    s.isRecurringActive(creneau({ enabled: 1, daysBitmask: 0 }), maintenant, 'Africa/Douala'),
    false,
  );
  // Interrupteur éteint : la règle ne s'applique jamais non plus.
  assert.strictEqual(
    s.isRecurringActive(creneau({ enabled: 0, startTime: '00:00:00', endTime: '23:59:00' }), maintenant, 'Africa/Douala'),
    false,
  );
  // start === end : journée entière.
  assert.strictEqual(
    s.isRecurringActive(creneau({ enabled: 1, startTime: '08:00:00', endTime: '08:00:00' }), maintenant, 'Africa/Douala'),
    true,
  );

  /* ══ Échéance calculée ══ */

  // Ponctuelle seule.
  assert.strictEqual(
    s.activeUntil(creneau({ untilAt: '2026-09-21T13:00:00Z' }), maintenant, 'Africa/Douala').toISOString(),
    '2026-09-21T13:00:00.000Z',
  );

  // Récurrente seule : la fin de l'occurrence en cours.
  assert.strictEqual(
    s.activeUntil(bureau, new Date('2026-09-21T09:30:00Z'), 'Africa/Douala').toISOString(),
    '2026-09-21T16:00:00.000Z',
    '17:00 à Douala = 16:00 UTC',
  );

  // Récurrente franchissant minuit, abordée avant minuit : la fin est demain.
  assert.strictEqual(
    s.activeUntil(nuit, new Date('2026-09-21T22:00:00Z'), 'Africa/Douala').toISOString(),
    '2026-09-22T06:00:00.000Z',
    '07:00 le 22 à Douala',
  );
  // La même, abordée après minuit : la fin est aujourd'hui.
  assert.strictEqual(
    s.activeUntil(nuit, new Date('2026-09-22T02:00:00Z'), 'Africa/Douala').toISOString(),
    '2026-09-22T06:00:00.000Z',
  );

  // Les deux courent : c'est la plus lointaine qui décide.
  assert.strictEqual(
    s.activeUntil(
      { ...bureau, untilAt: '2026-09-21T20:00:00Z' },
      new Date('2026-09-21T09:30:00Z'),
      'Africa/Douala',
    ).toISOString(),
    '2026-09-21T20:00:00.000Z',
  );

  // Journée entière : actif, mais sans échéance calculable. Le bandeau dira
  // « Répondeur actif » sans heure, plutôt qu'une échéance inventée.
  assert.strictEqual(
    s.activeUntil(creneau({ enabled: 1, startTime: '08:00:00', endTime: '08:00:00' }), maintenant, 'Africa/Douala'),
    null,
  );
  // Inactif : pas d'échéance.
  assert.strictEqual(s.activeUntil(creneau(), maintenant, 'Africa/Douala'), null);

  /* ══ Changement d'heure ══ */

  // Paris passe à l'heure d'été le 29 mars 2026 à 02:00 locale (01:00 UTC).
  // Une fenêtre 22:00–07:00 abordée le 28 au soir doit finir à 07:00 HEURE
  // MURALE le 29, soit 05:00 UTC — et non 06:00, qui serait le résultat d'un
  // calcul fait avec le décalage de la veille.
  assert.strictEqual(
    s.activeUntil(nuit, new Date('2026-03-28T22:00:00Z'), 'Europe/Paris').toISOString(),
    '2026-03-29T05:00:00.000Z',
    'la seconde passe rattrape le passage à l’heure d’été',
  );
  // Et le retour à l'heure d'hiver, le 25 octobre 2026.
  assert.strictEqual(
    s.activeUntil(nuit, new Date('2026-10-24T21:00:00Z'), 'Europe/Paris').toISOString(),
    '2026-10-25T06:00:00.000Z',
    '07:00 murale le 25 = 06:00 UTC, une fois revenu en UTC+1',
  );

  /* ══ Lecture : cascade et table absente ══ */

  mode = 'absente';
  const absent = await s.loadUserVoicemailSchedule(42);
  assert.strictEqual(absent.enabled, 0, 'table absente ⇒ répondeur inerte');
  assert.ok(s.isValidTimezone(absent.resolvedTimezone));
  assert.strictEqual(
    s.isVoicemailActive(absent, maintenant, absent.resolvedTimezone),
    false,
    'une base incomplète ne doit couper aucun appel',
  );

  mode = 'ok';
  // Compte existant, aucune ligne de planification : la jointure rend le
  // fuseau du pays mais des colonnes NULL. C'est un compte sans réglage, pas
  // un réglage vide.
  ligneUser = {
    enabled: null, startTime: null, endTime: null, daysBitmask: null,
    untilAt: null, timezone: null, bypassListId: null,
    countryTimezone: 'Europe/Paris',
  };
  const sansLigne = await s.loadUserVoicemailSchedule(42);
  assert.strictEqual(sansLigne.enabled, 0);
  assert.strictEqual(sansLigne.daysBitmask, 127, 'les défauts du schéma, pas des NULL');
  assert.strictEqual(sansLigne.resolvedTimezone, 'Europe/Paris', 'le pays du compte alimente la cascade');

  /* ══ Écriture : validations ══ */

  ligneUser = {
    enabled: 0, startTime: '22:00:00', endTime: '07:00:00', daysBitmask: 127,
    untilAt: null, timezone: null, bypassListId: null, countryTimezone: 'Africa/Douala',
  };

  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { startTime: '25:00' }),
    /Format horaire invalide/,
  );
  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { daysBitmask: 255 }),
    /daysBitmask/,
  );
  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { untilAt: 'demain' }),
    /untilAt invalide/,
  );
  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { timezone: 'WAT' }),
    /timezone invalide/,
  );

  requetes = [];
  await s.upsertUserVoicemailSchedule(42, { enabled: true, untilAt: '2026-09-21T13:00:00Z' });
  const ecriture = requetes.find((r) => /^INSERT INTO user_voicemail_schedule/.test(r.sql));
  assert.ok(ecriture, 'l’upsert écrit bien');
  assert.strictEqual(ecriture.params[1], 1, 'enabled normalisé en 0/1');
  assert.ok(ecriture.params[5] instanceof Date, 'untilAt part en Date, pas en chaîne');

  /* ══ Liste d'exception ══ */

  assert.strictEqual(await s.isCallerAllowedToRing(null, 7), false, 'aucune liste ⇒ personne ne passe');
  membresListe = [{ idList: 5, idFriend: 7 }];
  assert.strictEqual(await s.isCallerAllowedToRing(5, 7), true);
  assert.strictEqual(await s.isCallerAllowedToRing(5, 8), false);

  /* ══ La décision complète ══ */

  // Répondeur éteint : on n'interroge même pas la liste.
  ligneUser = {
    enabled: 0, startTime: '22:00:00', endTime: '07:00:00', daysBitmask: 127,
    untilAt: null, timezone: null, bypassListId: 5, countryTimezone: 'Africa/Douala',
  };
  requetes = [];
  const repos = await s.shouldInterceptCall(42, 7, maintenant);
  assert.strictEqual(repos.intercept, false);
  assert.strictEqual(
    requetes.some((r) => /contact_list_member/.test(r.sql)),
    false,
    'la liste n’est interrogée que si le répondeur est par ailleurs actif',
  );

  // Répondeur actif, appelant hors liste : on intercepte.
  ligneUser = { ...ligneUser, untilAt: new Date('2026-09-21T13:00:00Z'), bypassListId: 5 };
  membresListe = [{ idList: 5, idFriend: 7 }];
  const intercepte = await s.shouldInterceptCall(42, 8, maintenant);
  assert.strictEqual(intercepte.intercept, true);
  assert.strictEqual(intercepte.activeUntil.toISOString(), '2026-09-21T13:00:00.000Z');

  // Répondeur actif, appelant dans la liste : le téléphone sonne.
  const passe = await s.shouldInterceptCall(42, 7, maintenant);
  assert.strictEqual(passe.intercept, false);
  assert.strictEqual(passe.bypassed, true);

  console.log('✓ voicemailScheduleService : cascade de fuseau, minuit, heure d’été, échéance, exception');
}

main().catch((e) => {
  console.error('voicemailScheduleService.test.js ÉCHEC :', e);
  process.exit(1);
});
