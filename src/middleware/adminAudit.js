const pool = require('../config/db');

/**
 * Journal des actions administrateur.
 *
 * Monté une fois, en tête du routeur admin, plutôt que recopié dans chaque
 * contrôleur : écrit là-bas, le journal aurait un trou dès la première route
 * ajoutée, et le trou serait invisible. Ici, une route mutante qu'aucune entrée
 * de `ACTIONS` ne décrit est journalisée en `unmapped` — le manque devient une
 * ligne dans la table au lieu d'un silence.
 *
 * L'écriture a lieu sur `finish`, après que la réponse est partie : elle ne peut
 * ni retarder ni faire échouer une action d'administration. Une panne d'écriture
 * se solde par une trace perdue et une ligne dans les logs, jamais par un 500.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes mutantes volontairement hors journal, et la raison.
 *
 * Y figurer est un choix ; ne figurer nulle part est un oubli, et c'est ce que
 * `unmapped` révèle.
 */
const SKIP = new Map([
  // La connexion n'est pas encore authentifiée : `req.user` n'existe pas.
  // Journaliser les connexions admin demande de remonter l'identité depuis le
  // contrôleur — utile, mais c'est un autre travail.
  ['POST /auth/login', 'non authentifiée'],
  // POST par commodité (le ciblage voyage dans le corps), mais ne calcule
  // qu'une taille d'audience et n'écrit rien.
  ['POST /broadcasts/estimate', 'lecture déguisée en POST'],
]);

/**
 * Carte route → action métier.
 *
 * Les verbes sont ceux que le chantier des permissions reprendra : nommer ici
 * `users.ban` plutôt que « POST sur /users/:id/ban » sert les deux.
 */
const ACTIONS = {
  // Comptes
  'POST /users': { action: 'users.create', targetType: 'user' },
  'DELETE /users/:id': { action: 'users.delete', targetType: 'user', param: 'id' },
  'POST /users/:id/ban': { action: 'users.ban', targetType: 'user', param: 'id' },
  'DELETE /users/:id/ban': { action: 'users.unban', targetType: 'user', param: 'id' },
  'PUT /users/:id/role': { action: 'users.role', targetType: 'user', param: 'id' },
  'PUT /users/:id/socle': { action: 'users.socle', targetType: 'user', param: 'id' },
  'PUT /users/:id/phone': { action: 'users.phone', targetType: 'user', param: 'id' },

  // Contenus
  'DELETE /groups/:id': { action: 'groups.delete', targetType: 'group', param: 'id' },
  'DELETE /media/:id': { action: 'media.delete', targetType: 'media', param: 'id' },
  'DELETE /meetings/:id': { action: 'meetings.delete', targetType: 'meeting', param: 'id' },
  'POST /meetings/:id/end': { action: 'meetings.end', targetType: 'meeting', param: 'id' },

  // Modération
  'POST /reports/:id/actions': { action: 'reports.handle', targetType: 'report', param: 'id' },

  // Diffusions
  'POST /broadcasts': { action: 'broadcasts.send', targetType: 'broadcast' },
  'DELETE /broadcasts/scheduled/:jobId': { action: 'broadcasts.cancel', targetType: 'broadcast_job', param: 'jobId' },

  // Rétention
  'POST /purges/:name/run': { action: 'purges.run', targetType: 'purge', param: 'name' },
  'PUT /purges/:name': { action: 'purges.settings', targetType: 'purge', param: 'name' },
  'POST /trips/retention/purge': { action: 'trips.purge', targetType: 'purge' },

  // Réglages et annuaire
  'PUT /settings': { action: 'settings.write', targetType: 'settings' },
  'POST /reserved-alanya-phones': { action: 'phones.reserve', targetType: 'phone' },
  'DELETE /reserved-alanya-phones/:phone': { action: 'phones.release', targetType: 'phone', param: 'phone' },
  'POST /official-account': { action: 'official.create', targetType: 'user' },

  // Assistance éditoriale. Ces deux routes n'écrivent rien — elles seraient
  // donc candidates à SKIP, comme `POST /broadcasts/estimate`. Elles y échappent
  // pour deux raisons : elles envoient du texte chez un tiers, et elles coûtent
  // de l'argent. Quand une traduction publiée se révélera fautive, savoir
  // qu'elle vient de la machine et non d'un traducteur change le diagnostic.
  'POST /ai/translate': { action: 'ai.translate', targetType: 'ai' },
  'POST /ai/review': { action: 'ai.review', targetType: 'ai' },

  // Accueil des nouveaux
  'PUT /welcome/draft': { action: 'welcome.draft', targetType: 'welcome' },
  'POST /welcome/publish': { action: 'welcome.publish', targetType: 'welcome' },
  'POST /welcome/backfill': { action: 'welcome.backfill', targetType: 'welcome' },
  'PUT /welcome/status': { action: 'welcome.status', targetType: 'welcome' },

  // Compte de l'administrateur lui-même
  'PUT /me': { action: 'profile.update', targetType: 'self' },
  'PUT /me/password': { action: 'profile.password', targetType: 'self' },
};

function truncate(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Motif de l'action, tel qu'un humain l'a saisi.
 *
 * Deux champs, jamais le corps entier : `PUT /me/password` transporte un mot de
 * passe en clair, et une seule route de ce genre suffirait à rendre la table
 * plus dangereuse que ce qu'elle protège.
 */
function reasonFrom(body) {
  if (!body || typeof body !== 'object') return null;
  return truncate(body.reason ?? body.note, 500);
}

async function record(req, res) {
  // `req.route` n'est peuplé que si une route a effectivement traité la
  // requête : un 404 n'a rien à journaliser.
  const path = req.route?.path;
  if (!path) return;

  const key = `${req.method} ${path}`;
  if (SKIP.has(key)) return;

  const adminId = req.user?.alanyaID ?? null;
  if (!adminId) return;

  const entry = ACTIONS[key];
  const targetId = entry?.param
    ? truncate(req.params?.[entry.param], 64)
    : truncate(req.params?.id, 64);

  await pool.execute(
    `INSERT INTO admin_audit
       (admin_id, action, route, target_type, target_id, reason, ip, user_agent, status_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adminId,
      entry?.action ?? 'unmapped',
      truncate(key, 160),
      entry?.targetType ?? null,
      targetId,
      reasonFrom(req.body),
      truncate(req.ip, 64),
      truncate(req.get('user-agent'), 255),
      res.statusCode,
    ],
  );
}

function adminAudit(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  res.on('finish', () => {
    // Une action refusée n'a rien modifié ; la journaliser noierait les vraies
    // sous les tentatives malformées.
    if (res.statusCode >= 400) return;
    record(req, res).catch((e) => {
      console.error('[AdminAudit] écriture échouée:', e.message);
    });
  });

  next();
}

module.exports = { adminAudit, ACTIONS, SKIP, reasonFrom };
