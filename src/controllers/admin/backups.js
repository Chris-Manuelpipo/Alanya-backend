const pool = require('../../config/db');
const { BACKUP_STALE_DAYS } = require('./usersQuery');

/**
 * État des sauvegardes du parc.
 *
 * ── Ce que l'admin peut, et ne peut pas ──
 *
 * Le serveur ne détient AUCUNE sauvegarde : elles sont sur le Drive de
 * l'inscrit ou dans son dossier `Téléchargements`. Il ne garde que ce
 * descriptif — date, taille, décompte, version de clé. On ne peut donc ni
 * télécharger, ni restaurer, ni supprimer la sauvegarde de quelqu'un, ni en
 * déclencher une à distance : elle part du téléphone, à l'ouverture de
 * l'application.
 *
 * C'est le prix du choix de conception initial — garder les données chez
 * l'inscrit et épargner sa bande passante. Ce que l'administration peut faire,
 * c'est constater : qui est protégé, qui ne l'est pas.
 *
 * ── Pourquoi `jamais` est le chiffre qui compte ──
 *
 * Un compte sans sauvegarde perdra tout son historique au changement de
 * téléphone, et rien aujourd'hui ne le signale — ni à lui, ni à vous.
 */
const getBackupOverview = async (_req, res) => {
  try {
    const [[r]] = await pool.query(
      `SELECT
         COUNT(*)                                                   AS comptes,
         SUM(backup_last_at IS NOT NULL)                            AS avecSauvegarde,
         SUM(backup_last_at >= DATE_SUB(NOW(), INTERVAL ? DAY))     AS recentes,
         SUM(backup_last_at IS NOT NULL
             AND backup_last_at < DATE_SUB(NOW(), INTERVAL ? DAY))  AS perimees,
         SUM(backup_last_at IS NULL)                                AS jamais,
         COALESCE(SUM(backup_bytes), 0)                             AS octetsTotal,
         MAX(backup_last_at)                                        AS derniere
       FROM users
       WHERE exclus = 0`,
      [BACKUP_STALE_DAYS, BACKUP_STALE_DAYS],
    );

    const comptes = Number(r.comptes) || 0;
    const recentes = Number(r.recentes) || 0;

    res.json({
      // Renvoyé plutôt que codé en dur côté écran : la règle vit ici, et les
      // deux ne peuvent pas diverger.
      staleDays: BACKUP_STALE_DAYS,
      comptes,
      avecSauvegarde: Number(r.avecSauvegarde) || 0,
      recentes,
      perimees: Number(r.perimees) || 0,
      jamais: Number(r.jamais) || 0,
      octetsTotal: Number(r.octetsTotal) || 0,
      derniere: r.derniere ?? null,
      // Le seul indicateur qui se lise d'un coup d'œil : quelle part du parc
      // est réellement protégée aujourd'hui.
      couverture: comptes > 0 ? Math.round((recentes / comptes) * 100) : 0,
    });
  } catch (error) {
    console.error('[Admin] getBackupOverview error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Répartition des versions de clé en service.
 *
 * Après une rotation de secret, cette liste dit combien de comptes portent
 * encore l'ancienne — c'est-à-dire combien de sauvegardes deviendraient
 * illisibles si l'on retirait cette version trop tôt.
 */
const getBackupKeyUsage = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.backup_kid AS kid, COUNT(*) AS comptes,
              MAX(u.backup_last_at) AS derniere
         FROM users u
        WHERE u.backup_kid IS NOT NULL AND u.exclus = 0
        GROUP BY u.backup_kid
        ORDER BY u.backup_kid DESC`,
    );
    res.json(rows.map((r) => ({
      kid: Number(r.kid),
      comptes: Number(r.comptes) || 0,
      derniere: r.derniere ?? null,
    })));
  } catch (error) {
    console.error('[Admin] getBackupKeyUsage error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getBackupOverview, getBackupKeyUsage };
