/**
 * Rôles d'administration et permissions nommées.
 *
 * `users.type_compte` porte le rôle depuis toujours — 0 utilisateur, 1 admin,
 * 2 super-admin — et ne change pas ici : ni renumérotation, ni colonne
 * supplémentaire, ni migration. Ce qui change, c'est qu'une route cesse de
 * déclarer un *niveau* pour déclarer une *intention*.
 *
 * Pourquoi ça compte : jusqu'ici, répondre à « qui a le droit de bannir ? »
 * demandait de lire les 54 lignes du routeur. C'est exactement comme ça que
 * `POST /users/:id/ban` s'est retrouvé gardé par `adminAuth` seul alors que le
 * commentaire au-dessus de `banUser` annonçait « super-admin uniquement ».
 *
 * Les verbes sont ceux du journal d'audit (`middleware/adminAudit.js`) : la
 * même action y porte le même nom, sinon les deux cartes divergent.
 *
 * Limite assumée du modèle : le rôle est attaché au type de compte, pas à la
 * personne. Les administrateurs sont donc identiques entre eux — on peut
 * resserrer ce que « admin » signifie, pas distinguer un support d'un
 * modérateur.
 */

/**
 * Ce qu'un administrateur peut faire.
 *
 * Reproduit la frontière actuelle, à une exception près : le bannissement
 * passe au super-admin (voir `SUPER_ADMIN_ONLY`). Tout le reste garde
 * exactement le niveau qu'il avait — un chantier qui déplace la frontière et
 * la rend lisible en même temps serait irrelisible.
 */
const ADMIN_PERMISSIONS = [
  // Lecture et diagnostic
  'stats.read',
  'users.read',
  'groups.read',
  'media.read',
  'meetings.read',
  'broadcasts.read',
  'trips.read',
  'purges.read',
  'settings.read',
  'phones.read',
  'official.read',
  'villes.read',
  'audit.read',

  // Exports — contiennent des données personnelles. Restent au niveau admin
  // parce qu'ils y étaient ; à réexaminer, c'est la permission la plus proche
  // d'une exfiltration de tout l'annuaire.
  'users.export',
  'analytics.export',

  // Son propre compte
  'profile.read',
  'profile.update',
  'profile.password',

  // Contenus : retirer ce qui n'a rien à faire là
  'media.delete',
  'meetings.end',
  'meetings.delete',
  'groups.delete',

  // Comptes, sans les actions irréversibles
  'users.create',
  'users.phone',

  // Diffusions
  'broadcasts.send',
  'broadcasts.cancel',
];

/**
 * Ce que le super-admin est seul à pouvoir faire.
 *
 * `users.ban` et `users.unban` sont les deux seules à changer de niveau : elles
 * étaient ouvertes à tout administrateur. Débannir suit bannir — sans quoi un
 * administrateur pourrait défaire la décision d'un super-admin.
 */
const SUPER_ADMIN_ONLY = [
  'users.ban',
  'users.unban',
  'users.role',
  'users.socle',
  'users.delete',
  'purges.run',
  'purges.settings',
  'trips.purge',
  'settings.write',
  'phones.reserve',
  'phones.release',
  'official.create',
  'welcome.read',
  'welcome.draft',
  'welcome.publish',
  'welcome.backfill',
  'welcome.status',
];

const ROLE_USER = 0;
const ROLE_ADMIN = 1;
const ROLE_SUPER_ADMIN = 2;

const ROLES = {
  [ROLE_ADMIN]: {
    name: 'admin',
    label: 'Administrateur',
    permissions: new Set(ADMIN_PERMISSIONS),
  },
  [ROLE_SUPER_ADMIN]: {
    name: 'super-admin',
    label: 'Super-administrateur',
    permissions: new Set([...ADMIN_PERMISSIONS, ...SUPER_ADMIN_ONLY]),
  },
};

/** Toutes les permissions connues — sert à refuser une faute de frappe. */
const ALL_PERMISSIONS = new Set([...ADMIN_PERMISSIONS, ...SUPER_ADMIN_ONLY]);

function roleFor(typeCompte) {
  return ROLES[Number(typeCompte) || 0] ?? null;
}

/** Permissions effectives d'un compte, triées — c'est ce que le panneau lit. */
function permissionsFor(typeCompte) {
  const role = roleFor(typeCompte);
  return role ? [...role.permissions].sort() : [];
}

function can(typeCompte, permission) {
  return roleFor(typeCompte)?.permissions.has(permission) ?? false;
}

module.exports = {
  ROLE_USER,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  ROLES,
  ADMIN_PERMISSIONS,
  SUPER_ADMIN_ONLY,
  ALL_PERMISSIONS,
  roleFor,
  permissionsFor,
  can,
};
