/**
 * L'interrupteur du chiffrement : repli fermé, cohorte, mises à jour.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du service — même
 * procédé que `securitySettingsService.test.js`. Aucune base n'est nécessaire :
 * la migration 094 s'applique à la main, et ce test doit passer sur une base
 * qui ne l'a pas encore reçue.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let requetes = [];
/** 'ok' = la table répond ; 'absente' = migration 094 non jouée. */
let mode = 'ok';
let ligne = {
  id: 1, enrol_enabled: 0, activate_enabled: 0, cohort_percent: 0, cohort_ids: null,
};

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    requetes.push({ sql: texte, params });
    if (mode === 'absente') {
      const e = new Error("Table 'e2ee_settings' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    if (/^INSERT INTO e2ee_settings/.test(texte)) {
      const [enrol, activate, percent, ids] = params;
      ligne = {
        ...ligne,
        enrol_enabled: enrol,
        activate_enabled: activate,
        cohort_percent: percent,
        cohort_ids: ids,
      };
      return [{ affectedRows: 1 }, []];
    }
    return [[{ ...ligne }], []];
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

const s = require('./e2eeSettingsService');

/** Pose la ligne et vide le cache. */
function poser(valeurs) {
  mode = 'ok';
  ligne = {
    id: 1, enrol_enabled: 0, activate_enabled: 0, cohort_percent: 0, cohort_ids: null,
    ...valeurs,
  };
  s.invalidateE2eeSettings();
}

/** Un compte dont le seau est sous `seuil`, et un autre au-dessus. */
function comptesDeSeau(seuil) {
  let dedans = null;
  let dehors = null;
  for (let id = 1; id < 10_000 && (dedans == null || dehors == null); id += 1) {
    const b = s.cohortBucket(id);
    if (b < seuil && dedans == null) dedans = id;
    if (b >= seuil && dehors == null) dehors = id;
  }
  return { dedans, dehors };
}

async function main() {
  /* ── Table absente : tout est fermé, et le repli est mis en cache ── */
  mode = 'absente';
  requetes = [];
  s.invalidateE2eeSettings();
  assert.strictEqual(await s.peutPublier(1), false, 'table absente ⇒ rien ne s\'ouvre');
  assert.strictEqual(await s.peutActiver(1, 2), false);
  assert.strictEqual(requetes.length, 1, 'le repli est mis en cache comme une vraie lecture');

  /* ── Valeurs par défaut de la migration : fermé ── */
  poser({});
  assert.strictEqual(await s.peutPublier(1), false);
  assert.strictEqual(await s.peutActiver(1, 2), false);

  /* ── Liste explicite ── */
  poser({ enrol_enabled: 1, cohort_ids: '[7, 12]' });
  assert.strictEqual(await s.peutPublier(7), true, 'un compte de la liste publie');
  assert.strictEqual(await s.peutPublier(8), false, 'témoin : un compte hors liste ne publie pas');

  // Le cran « publier » ne suffit pas à activer.
  assert.strictEqual(await s.peutActiver(7, 12), false);
  poser({ enrol_enabled: 1, activate_enabled: 1, cohort_ids: '[7, 12]' });
  assert.strictEqual(await s.peutActiver(7, 12), true, 'deux comptes de la cohorte activent');
  assert.strictEqual(await s.peutActiver(7, 8), false, 'un seul compte hors cohorte suffit à refuser');
  assert.strictEqual(await s.peutActiver(), false, 'aucun compte : rien à activer');

  // Activer sans publier produirait des conversations chiffrées pour des
  // appareils sans clés.
  poser({ enrol_enabled: 0, activate_enabled: 1, cohort_ids: '[7, 12]' });
  assert.strictEqual(await s.peutActiver(7, 12), false, 'activer exige aussi le cran « publier »');

  /* ── Liste illisible : personne n'entre ── */
  poser({ enrol_enabled: 1, cohort_ids: '{pas du json' });
  assert.strictEqual(await s.peutPublier(7), false);
  assert.deepStrictEqual([...s.parseCohortIds('[3, "x", -1, 4.5, 9]')], [3, 9]);
  assert.strictEqual(s.parseCohortIds('{"a":1}').size, 0);

  /* ── Pourcentage : seau stable, et monter ne fait sortir personne ── */
  assert.strictEqual(s.cohortBucket(42), s.cohortBucket(42), 'le seau est stable');
  const { dedans, dehors } = comptesDeSeau(10);
  assert.ok(dedans && dehors, 'il existe des comptes de part et d\'autre de 10 %');
  poser({ enrol_enabled: 1, cohort_percent: 10 });
  assert.strictEqual(await s.peutPublier(dedans), true);
  assert.strictEqual(await s.peutPublier(dehors), false, 'témoin : un compte au-dessus du seuil reste dehors');
  poser({ enrol_enabled: 1, cohort_percent: 50 });
  assert.strictEqual(await s.peutPublier(dedans), true, 'passer de 10 à 50 % n\'en fait sortir personne');
  poser({ enrol_enabled: 1, cohort_percent: 100 });
  assert.strictEqual(await s.peutPublier(dehors), true, '100 % : tout le monde');
  poser({ enrol_enabled: 1, cohort_percent: 0 });
  assert.strictEqual(await s.peutPublier(dedans), false, '0 % sans liste : personne');

  // Répartition grossière : sur 10 000 comptes, à peu près 1 sur 10 sous 10.
  let n = 0;
  for (let id = 1; id <= 10_000; id += 1) if (s.cohortBucket(id) < 10) n += 1;
  assert.ok(n > 800 && n < 1200, `répartition des seaux plausible (${n} / 10 000)`);

  // Identifiants absurdes : jamais dans la cohorte.
  assert.strictEqual(s.estDansCohorte(0, { cohort_percent: 100 }), false);
  assert.strictEqual(s.estDansCohorte('abc', { cohort_percent: 100 }), false);

  /* ── Mises à jour : types stricts ── */
  assert.throws(() => s.normaliseMiseAJour({ enrolEnabled: 'true' }), s.ReglageInvalide);
  assert.throws(() => s.normaliseMiseAJour({ cohortPercent: 101 }), s.ReglageInvalide);
  assert.throws(() => s.normaliseMiseAJour({ cohortPercent: 12.5 }), s.ReglageInvalide);
  assert.throws(() => s.normaliseMiseAJour({ cohortIds: [1, '2'] }), s.ReglageInvalide);
  assert.throws(() => s.normaliseMiseAJour({ cohortIds: [0] }), s.ReglageInvalide);
  assert.throws(
    () => s.normaliseMiseAJour({ cohortIds: Array.from({ length: 501 }, (_, i) => i + 1) }),
    s.ReglageInvalide,
  );
  assert.throws(() => s.normaliseMiseAJour({}), s.ReglageInvalide, 'rien à modifier est une erreur');
  assert.deepStrictEqual(
    s.normaliseMiseAJour({ enrolEnabled: true, cohortIds: [12, 7, 12] }),
    { enrol_enabled: 1, cohort_ids: '[7,12]' },
  );

  /* ── Écriture partielle : les autres réglages sont conservés ── */
  poser({ enrol_enabled: 1, activate_enabled: 0, cohort_percent: 25, cohort_ids: '[7]' });
  const apres = await s.setE2eeSettings(s.normaliseMiseAJour({ activateEnabled: true }));
  assert.strictEqual(Number(apres.activate_enabled), 1);
  assert.strictEqual(Number(apres.enrol_enabled), 1, 'enrol conservé');
  assert.strictEqual(Number(apres.cohort_percent), 25, 'pourcentage conservé');
  assert.strictEqual(apres.cohort_ids, '[7]', 'liste conservée');

  // La fusion se fait sur la base, pas sur le cache : une bascule faite par
  // une autre instance ne doit pas être défaite.
  ligne.cohort_percent = 60; // écrite par une autre instance, cache encore chaud
  const fusion = await s.setE2eeSettings(s.normaliseMiseAJour({ enrolEnabled: true }));
  assert.strictEqual(Number(fusion.cohort_percent), 60, 'la mise à jour repart de la base');

  console.log('e2eeSettingsService.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
