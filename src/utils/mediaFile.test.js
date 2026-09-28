const assert = require('assert');

const {
  deletePublicFileIfUnused,
  publicFilesOfUser,
  groupPhotosOf,
  _cleSupprimable: cleSupprimable,
} = require('./mediaFile');

const HOTE = 'https://www.alanya237.com';
const IMAGE = `${HOTE}/uploads/images/img_12_1756700000000_0123456789abcdef.jpg`;
const ANNONCE = `${HOTE}/uploads/voicemail/vm_12_1756700000000_0123456789abcdef.m4a`;

// ── Clés supprimables : jamais une clé fabriquée par un client ──────
{
  // Une adresse de média s'écrit librement depuis l'application : elle ne
  // doit pas pouvoir désigner autre chose qu'un média rangé.
  for (const url of [
    `${HOTE}/uploads/../.env`,
    `${HOTE}/uploads/media/../../.env`,
    `${HOTE}/uploads/media/2026-09-01/images/..%2F..%2F..%2F.env`,
    `${HOTE}/uploads/exports/export_12.zip`,
    `${HOTE}/uploads/../../server.js`,
  ]) {
    assert.strictEqual(cleSupprimable(url, ['media', 'images', 'voicemail']), null, url);
  }

  // Adresse valide : sa clé, pour le préfixe autorisé.
  assert.strictEqual(cleSupprimable(IMAGE, ['images']), 'images/img_12_1756700000000_0123456789abcdef.jpg');
  // La suppression d'un média de discussion ne touche que `media/` : un
  // message « vue unique » qui désignerait la photo de profil de quelqu'un
  // d'autre ne peut pas la faire supprimer.
  assert.strictEqual(cleSupprimable(IMAGE, ['media']), null);
  assert.strictEqual(cleSupprimable(ANNONCE, ['media']), null);
  assert.strictEqual(
    cleSupprimable(`${HOTE}/uploads/media/2026-09-01/images/media_12_1756700000000.jpg`, ['media']),
    'media/2026-09-01/images/media_12_1756700000000.jpg',
  );

  // Adresse d'avant les partitions : la clé de la partition où le fichier a
  // été rangé.
  assert.strictEqual(
    cleSupprimable(`${HOTE}/uploads/media/images/media_12_1756700000000.jpg`, ['media']),
    'media/2025-09-01/images/media_12_1756700000000.jpg',
  );
}

async function main() {
  /** Base factice : `repond(sql)` rend les lignes, ou jette. */
  function fausseBase(repond) {
    const appels = [];
    return {
      appels,
      execute: async (sql, params) => {
        appels.push({ sql, params });
        return [await repond(sql, params)];
      },
    };
  }
  const libre = () => fausseBase(() => []);
  const essayer = async (url, db) => {
    const supprimes = [];
    const lance = await deletePublicFileIfUnused(url, { db, supprimer: (u) => supprimes.push(u) });
    return { lance, supprimes };
  };

  // ── Ce qui n'est jamais supprimé, avant même de consulter la base ──
  for (const url of [
    `${HOTE}/uploads/images/default_avatar_male.png`, // avatar par défaut, partagé
    `${HOTE}/uploads/media/2026-09-01/images/media_12_1756700000000.jpg`, // média de discussion
    'https://lh3.googleusercontent.com/a/photo.jpg', // hors de chez nous
    `${HOTE}/uploads/images/../../.env`,
    `${HOTE}/uploads/images/photo-vacances.jpg`, // déposé à la main
    null,
    '',
  ]) {
    const db = libre();
    const { lance, supprimes } = await essayer(url, db);
    assert.strictEqual(lance, false, String(url));
    assert.strictEqual(supprimes.length, 0);
    assert.strictEqual(db.appels.length, 0, 'pas même une requête');
  }

  // ── Plus rien ne la désigne : supprimée ─────────────────────────────
  {
    const db = libre();
    const { lance, supprimes } = await essayer(IMAGE, db);
    assert.strictEqual(lance, true);
    assert.deepStrictEqual(supprimes, [IMAGE]);
    assert.strictEqual(db.appels.length, 3, 'photos de profil, de groupe, annonces');
    // Les `_` sont des jokers en SQL : échappés. Comparaison sur la clé, pas
    // sur l'hôte, qui a changé au fil du temps.
    assert.deepStrictEqual(db.appels[0].params, ['%/images/img!_12!_1756700000000!_0123456789abcdef.jpg']);
    assert.ok(db.appels.every((a) => a.sql.includes("ESCAPE '!'")));
  }
  // La forme d'avant le suffixe aléatoire est aussi générée par le serveur.
  assert.strictEqual((await essayer(`${HOTE}/uploads/images/img_12_1756700000000.png`, libre())).lance, true);

  // ── Encore désignée ailleurs : conservée ────────────────────────────
  // Un client qui recopie l'adresse de la photo d'un autre dans son profil,
  // puis la remplace, ne doit pas faire supprimer la photo de l'autre.
  {
    const db = fausseBase((sql) => (sql.includes('FROM users') ? [{ 1: 1 }] : []));
    const { lance, supprimes } = await essayer(IMAGE, db);
    assert.strictEqual(lance, false);
    assert.strictEqual(supprimes.length, 0);
  }
  {
    const db = fausseBase((sql) => (sql.includes('FROM conversation') ? [{ 1: 1 }] : []));
    assert.strictEqual((await essayer(IMAGE, db)).lance, false, 'photo de groupe');
  }

  // ── Table du répondeur absente (migration non appliquée) : elle ne désigne rien ──
  {
    const absente = Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' });
    const db = fausseBase((sql) => {
      if (sql.includes('user_voicemail_schedule')) throw absente;
      return [];
    });
    assert.strictEqual((await essayer(ANNONCE, db)).lance, true);
  }

  // ── Base injoignable : dans le doute, rien n'est supprimé ───────────
  {
    const panne = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const db = fausseBase(() => { throw panne; });
    const { lance, supprimes } = await essayer(IMAGE, db);
    assert.strictEqual(lance, false);
    assert.strictEqual(supprimes.length, 0);
  }

  // ── Fichiers d'un compte, photos de groupes ─────────────────────────
  {
    const db = fausseBase((sql) => {
      if (sql.includes('FROM users')) return [{ avatar_url: IMAGE }];
      if (sql.includes('user_voicemail_schedule')) return [{ greeting_url: ANNONCE }];
      return [];
    });
    assert.deepStrictEqual(await publicFilesOfUser(db, 12), [IMAGE, ANNONCE]);

    const sansRepondeur = fausseBase((sql) => {
      if (sql.includes('FROM users')) return [{ avatar_url: IMAGE }];
      throw Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE' });
    });
    assert.deepStrictEqual(await publicFilesOfUser(sansRepondeur, 12), [IMAGE]);
  }
  {
    const db = fausseBase(() => [{ groupPhoto: IMAGE }]);
    assert.deepStrictEqual(await groupPhotosOf(db, [5, 6]), [IMAGE]);
    assert.deepStrictEqual(db.appels[0].params, [5, 6]);
    // Aucun groupe : aucune requête.
    const vide = libre();
    assert.deepStrictEqual(await groupPhotosOf(vide, []), []);
    assert.strictEqual(vide.appels.length, 0);
  }

  console.log('mediaFile: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
