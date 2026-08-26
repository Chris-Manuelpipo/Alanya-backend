const assert = require('assert');

const {
  MEDIA_ROOT,
  TRASH_DIR,
  LEGACY_KINDS,
  MS_PAR_JOUR,
  partitionKeyFor,
  isPartitionKey,
  partitionStartMs,
  partitionExpiresAtMs,
  isPartitionExpired,
  secondsUntilPartitionExpiry,
  partitionFromPath,
  uploadMsFromFileName,
  partitionDirFor,
  trashNameFor,
  parseTrashName,
} = require('./mediaPartition');

const utc = (s) => Date.parse(s);

// ── Clé de partition ────────────────────────────────────────────────
assert.strictEqual(partitionKeyFor(utc('2026-08-24T00:00:00Z')), '2026-08-24');
assert.strictEqual(partitionKeyFor(utc('2026-08-24T23:59:59Z')), '2026-08-24');
assert.strictEqual(partitionKeyFor(utc('2026-08-25T00:00:00Z')), '2026-08-25');
assert.strictEqual(partitionKeyFor(new Date(utc('2026-01-02T12:00:00Z'))), '2026-01-02');

// Le découpage est en UTC, pas en heure locale : c'est ce qui garantit que la
// frontière ne bouge pas quand le fuseau du serveur change.
assert.strictEqual(partitionKeyFor(utc('2026-08-24T22:30:00Z')), '2026-08-24');

// Une entrée non finie échoue visiblement au lieu de produire « NaN-NaN-NaN »,
// qui créerait un répertoire que le balayage ne ramasserait jamais.
assert.strictEqual(partitionKeyFor(undefined), null);
assert.strictEqual(partitionKeyFor('pas un instant'), null);

// ── Validité d'une clé ──────────────────────────────────────────────
assert.ok(isPartitionKey('2026-08-24'));
assert.ok(isPartitionKey('2024-02-29')); // année bissextile
assert.ok(!isPartitionKey('2026-02-31')); // forme correcte, date inexistante
assert.ok(!isPartitionKey('2026-13-01'));
assert.ok(!isPartitionKey('2026-00-10'));
assert.ok(!isPartitionKey('2026-8-24')); // non zéro-paddé
assert.ok(!isPartitionKey('images'));
assert.ok(!isPartitionKey('.trash'));
assert.ok(!isPartitionKey(''));
assert.ok(!isPartitionKey(null));

// Aucun des dossiers hérités ne peut être pris pour une partition : c'est ce
// qui permet aux deux dispositions de cohabiter sous `uploads/media/`.
for (const kind of LEGACY_KINDS) {
  assert.ok(!isPartitionKey(kind), `${kind} ne doit pas passer pour une partition`);
}
assert.ok(!isPartitionKey(TRASH_DIR));

// ── Début et échéance ───────────────────────────────────────────────
assert.strictEqual(partitionStartMs('2026-08-24'), utc('2026-08-24T00:00:00Z'));
assert.strictEqual(partitionStartMs('pas-une-date'), null);

// Une partition D couvre [D, D+1). Son fichier le plus récent est déposé juste
// avant D+1 00:00Z et doit vivre 30 jours : l'échéance est donc D + 31 jours.
assert.strictEqual(
  partitionExpiresAtMs('2026-07-20', 30),
  utc('2026-08-20T00:00:00Z'),
);
assert.strictEqual(partitionExpiresAtMs('2026-07-20', 1), utc('2026-07-22T00:00:00Z'));
assert.strictEqual(partitionExpiresAtMs('pas-une-date', 30), null);
assert.strictEqual(partitionExpiresAtMs('2026-07-20', undefined), null);

// La garantie centrale : AUCUN fichier ne peut vivre moins que la rétention
// annoncée. On vérifie les deux bornes de la tranche.
{
  const retention = 30;
  const cle = '2026-07-20';
  const echeance = partitionExpiresAtMs(cle, retention);

  const plusAncien = utc('2026-07-20T00:00:00Z'); // premier instant de la tranche
  const plusRecent = utc('2026-07-20T23:59:59Z'); // dernier instant de la tranche

  assert.ok(echeance - plusRecent >= retention * MS_PAR_JOUR,
    'le fichier le plus récent doit vivre au moins la rétention');
  assert.ok(echeance - plusAncien <= (retention + 1) * MS_PAR_JOUR,
    'aucun fichier ne doit vivre plus que la rétention + un jour');
}

// ── Expiration ──────────────────────────────────────────────────────
{
  const opts = (now) => ({ retentionDays: 30, now: utc(now) });

  // La veille de l'échéance : elle tient encore.
  assert.ok(!isPartitionExpired('2026-07-20', opts('2026-08-19T23:59:59Z')));
  // À l'instant pile : elle tombe.
  assert.ok(isPartitionExpired('2026-07-20', opts('2026-08-20T00:00:00Z')));
  // Bien après : elle tombe toujours (le balayage rattrape les retards).
  assert.ok(isPartitionExpired('2026-07-20', opts('2026-09-30T00:00:00Z')));
  // La partition du jour ne tombe évidemment pas.
  assert.ok(!isPartitionExpired('2026-08-20', opts('2026-08-20T12:00:00Z')));

  // Une clé invalide n'expire jamais : en cas de doute, on ne supprime pas.
  assert.ok(!isPartitionExpired('images', opts('2030-01-01T00:00:00Z')));
  assert.ok(!isPartitionExpired('2026-02-31', opts('2030-01-01T00:00:00Z')));
}

// ── Plafond de cache ────────────────────────────────────────────────
{
  const restant = secondsUntilPartitionExpiry('2026-07-20', {
    retentionDays: 30,
    now: utc('2026-08-19T00:00:00Z'),
  });
  assert.strictEqual(restant, 86400); // il reste exactement un jour

  // Jamais de valeur négative : une partition déjà échue plafonne à 0.
  assert.strictEqual(
    secondsUntilPartitionExpiry('2026-07-20', {
      retentionDays: 30,
      now: utc('2026-09-01T00:00:00Z'),
    }),
    0,
  );
  assert.strictEqual(
    secondsUntilPartitionExpiry('images', { retentionDays: 30 }),
    0,
  );
}

// ── Lecture d'un chemin ─────────────────────────────────────────────
assert.strictEqual(
  partitionFromPath('https://www.alanya237.com/uploads/media/2026-08-24/images/media_1_1756000000000.jpg'),
  '2026-08-24',
);
assert.strictEqual(
  partitionFromPath('/uploads/media/2026-08-24/video/media_42_1756000000000.mp4'),
  '2026-08-24',
);

// Chemin hérité : pas de partition. `null` signifie « hors partition », pas
// « expiré » — c'est le relais de lecture qui prend le relais, pas le 410.
assert.strictEqual(partitionFromPath('/uploads/media/images/media_1_1756000000000.jpg'), null);
// Un avatar n'est pas sous `media/` du tout : il ne tombe jamais.
assert.strictEqual(partitionFromPath('/uploads/images/img_1_1756000000000.jpg'), null);
assert.strictEqual(partitionFromPath(''), null);
assert.strictEqual(partitionFromPath(null), null);

// Les paramètres et ancres d'URL ne doivent pas fausser la lecture.
assert.strictEqual(
  partitionFromPath('/uploads/media/2026-08-24/images/x.jpg?v=2#haut'),
  '2026-08-24',
);

// ── Horodatage lu dans le nom de fichier ────────────────────────────
assert.strictEqual(uploadMsFromFileName('media_42_1756000000000.jpg'), 1756000000000);
assert.strictEqual(uploadMsFromFileName('media_1_1756000000000'), 1756000000000);
assert.strictEqual(uploadMsFromFileName('img_42_1756000000000.jpg'), null); // avatar
assert.strictEqual(uploadMsFromFileName('photo-vacances.jpg'), null);
assert.strictEqual(uploadMsFromFileName(''), null);

// La partition d'un fichier existant se calcule donc sans la base — c'est ce
// qui rend la migration des fichiers déjà en place déterministe et rejouable.
assert.strictEqual(
  partitionKeyFor(uploadMsFromFileName('media_42_' + utc('2026-07-20T13:00:00Z') + '.jpg')),
  '2026-07-20',
);

// ── Chemin de dépôt ─────────────────────────────────────────────────
assert.strictEqual(
  partitionDirFor('images', utc('2026-08-24T10:00:00Z')),
  'media/2026-08-24/images',
);
assert.strictEqual(partitionDirFor('images', 'pas un instant'), null);
assert.ok(partitionDirFor('video').startsWith(`${MEDIA_ROOT}/`));

// ── Nommage de corbeille ────────────────────────────────────────────
{
  const nom = trashNameFor('2026-07-20', 'hote:123:abcd', 'run-7');
  const lu = parseTrashName(nom);
  assert.deepStrictEqual(lu, { cle: '2026-07-20', workerId: 'hote-123-abcd', runId: 'run-7' });

  // Deux exécutions ne visent jamais la même destination : c'est ce qui permet
  // à `rename` de servir de verrou sans se marcher dessus.
  assert.notStrictEqual(
    trashNameFor('2026-07-20', 'a', 'run-1'),
    trashNameFor('2026-07-20', 'b', 'run-1'),
  );
  assert.notStrictEqual(
    trashNameFor('2026-07-20', 'a', 'run-1'),
    trashNameFor('2026-07-20', 'a', 'run-2'),
  );

  // Les séparateurs de chemin ne peuvent pas survivre à l'assainissement :
  // un workerId hostile ne doit pas pouvoir sortir du sas.
  const hostile = trashNameFor('2026-07-20', '../../etc', 'run');
  assert.ok(!hostile.includes('/'));
  assert.ok(!hostile.includes('..'));

  assert.strictEqual(parseTrashName('2026-07-20'), null);
  assert.strictEqual(parseTrashName('images__a__b'), null);
  assert.strictEqual(parseTrashName(''), null);
}

console.log('mediaPartition: OK');
