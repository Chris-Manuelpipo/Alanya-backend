/**
 * Registre des purges de rétention, pilotables depuis l'espace super-admin.
 *
 * Les cinq purges nocturnes suppriment définitivement des fichiers et des
 * lignes. Elles n'avaient jusqu'ici ni interrupteur, ni compteur préalable,
 * ni trace d'exécution : les couper imposait de modifier le code, et rien ne
 * distinguait « elle tourne et n'a rien à faire » de « elle ne tourne pas ».
 * C'est ce dernier point qui a laissé le bug d'alias SQL de la purge des
 * médias passer inaperçu — elle échouait chaque nuit, en silence.
 *
 * Chaque purge se décrit ici : ce qu'elle supprime, quels réglages elle
 * expose, comment compter ce qui serait supprimé, comment l'exécuter. Les
 * cinq n'ont pas la même forme (les médias exposent une durée, les trajets
 * trois, les diffusions et la rétention générale aucune — leurs durées sont
 * figées dans leur SQL), d'où un descripteur par purge plutôt qu'un schéma
 * commun forcé.
 *
 * Voir migration 068 : `purge_settings` (état + surcharges) et `purge_runs`
 * (journal).
 */

const pool = require('../config/db');
const mediaPolicy = require('../constants/mediaRetentionPolicy');
const tripPolicy = require('../constants/tripPolicy');

const NAMES = ['media', 'broadcast', 'welcome_status', 'trip', 'data_retention'];

/** Borne une valeur de réglage. Une saisie hors bornes est ramenée, jamais rejetée en silence. */
function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── Descripteurs ────────────────────────────────────────────────────────────
//
// `knobs` : réglages surchargeables depuis l'admin. Une purge sans knob a ses
// durées figées dans son SQL — c'est signalé à l'écran plutôt que masqué.
// `stats(opts)` : ce qui serait supprimé MAINTENANT, avec les réglages courants.
// `run(opts)`   : exécution réelle.

const DESCRIPTORS = {
  media: {
    label: 'Médias expirés',
    description:
      "Vide `message.mediaUrl` et supprime le fichier du disque au-delà de la "
      + 'rétention. Le message lui-même est conservé : seule la pièce jointe disparaît.',
    knobs: [{
      key: 'mediaDays',
      label: 'Rétention des médias',
      unit: 'jours',
      min: 1,
      max: 365,
      default: () => mediaPolicy.RETENTION.mediaDays,
    }],
    async stats(opts) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS fichiers,
                COALESCE(SUM(m.mediaSize), 0) AS octets,
                MIN(m.sendAt) AS plusAncien
           FROM message m
          WHERE m.mediaUrl IS NOT NULL AND m.mediaUrl <> ''
            AND m.sendAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.mediaDays],
      );
      return {
        fichiers: Number(rows[0].fichiers) || 0,
        octets: Number(rows[0].octets) || 0,
        plusAncien: rows[0].plusAncien,
      };
    },
    async run(opts) {
      const { runNightlyMediaPurge } = require('./mediaRetention');
      return runNightlyMediaPurge(undefined, { mediaDays: opts.mediaDays });
    },
  },

  broadcast: {
    label: 'Accusés de diffusion',
    description:
      'Rafraîchit les compteurs de diffusion et supprime les accusés de '
      + 'livraison de plus de 90 jours.',
    knobs: [], // durée figée dans le SQL de broadcastService
    async stats() {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS lignes FROM broadcast_delivery
          WHERE delivered_at IS NOT NULL
            AND delivered_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`,
      );
      return { lignes: Number(rows[0].lignes) || 0, retentionFigee: '90 jours' };
    },
    async run() {
      const { runNightlyDeliveryMaintenance } = require('./broadcastService');
      return runNightlyDeliveryMaintenance();
    },
  },

  welcome_status: {
    label: "Statuts d'accueil expirés",
    description:
      'Supprime les statuts de bienvenue expirés. Sans elle, `statut` grossit '
      + "d'une ligne par inscription sans jamais rétrécir.",
    knobs: [{
      key: 'retentionDays',
      label: 'Conservation après expiration',
      unit: 'jours',
      min: 1,
      max: 365,
      default: () => 7,
    }],
    async stats(opts) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS lignes
           FROM statut s
           JOIN welcome_status_delivery w ON w.statut_id = s.ID
          WHERE s.expiredAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.retentionDays],
      );
      return { lignes: Number(rows[0].lignes) || 0 };
    },
    async run(opts) {
      const { purgeExpiredWelcomeStatuses } = require('./welcomeService');
      return purgeExpiredWelcomeStatuses({ retentionDays: opts.retentionDays });
    },
  },

  trip: {
    label: 'Traces de trajets',
    description:
      'Efface les points GPS des trajets clos au-delà de la rétention, puis les '
      + 'trajets eux-mêmes. Un trajet en cours n\'est jamais touché : sa trace '
      + 'est le suivi live.',
    knobs: [
      {
        key: 'pointsHours',
        label: 'Points GPS après clôture',
        unit: 'heures',
        min: 1,
        max: 8760,
        default: () => tripPolicy.RETENTION.pointsHours,
      },
      {
        key: 'pointsIncidentDays',
        label: 'Points GPS si clôture sur alerte',
        unit: 'jours',
        min: 1,
        max: 365,
        default: () => tripPolicy.RETENTION.pointsIncidentDays,
      },
      {
        key: 'tripMonths',
        label: 'Trajets complets',
        unit: 'mois',
        min: 1,
        max: 120,
        default: () => tripPolicy.RETENTION.tripMonths,
      },
    ],
    async stats() {
      const { fetchTraceRetentionStats } = require('./tripRetention');
      return fetchTraceRetentionStats();
    },
    async run() {
      const { runNightlyTripPurge } = require('./tripRetention');
      return runNightlyTripPurge();
    },
  },

  data_retention: {
    label: 'Rétention générale',
    description:
      'Statuts ordinaires expirés, historique d\'appels, journal de connexions, '
      + 'jobs en échec, appareils révoqués, jetons push dormants, OTP périmés.',
    knobs: [], // durées figées, une par cible, dans dataRetentionService
    async stats() {
      const cibles = [
        ['statut', "SELECT COUNT(*) n FROM statut WHERE expiredAt < DATE_SUB(NOW(), INTERVAL 7 DAY)", '7 jours'],
        ['callHistory', "SELECT COUNT(*) n FROM callHistory WHERE created_at < DATE_SUB(NOW(), INTERVAL 12 MONTH)", '12 mois'],
        ['userAccess', "SELECT COUNT(*) n FROM userAccess WHERE dateLogin < DATE_SUB(NOW(), INTERVAL 90 DAY)", '90 jours'],
        ['job_queue', "SELECT COUNT(*) n FROM job_queue WHERE failed_at IS NOT NULL AND failed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)", '30 jours'],
        ['appareils', "SELECT COUNT(*) n FROM appareils WHERE revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(), INTERVAL 90 DAY)", '90 jours'],
        ['user_push_devices', "SELECT COUNT(*) n FROM user_push_devices WHERE lastHeartbeatAt IS NOT NULL AND lastHeartbeatAt < DATE_SUB(NOW(), INTERVAL 180 DAY)", '180 jours'],
      ];
      const parCible = {};
      for (const [nom, sql, retention] of cibles) {
        try {
          const [rows] = await pool.execute(sql);
          parCible[nom] = { lignes: Number(rows[0].n) || 0, retention };
        } catch (e) {
          parCible[nom] = { erreur: e.message };
        }
      }
      return { parCible };
    },
    async run() {
      const { runDataRetentionPurge } = require('./dataRetentionService');
      return runDataRetentionPurge();
    },
  },
};

// ── Réglages ────────────────────────────────────────────────────────────────

function defaultsFor(name) {
  const out = {};
  for (const knob of DESCRIPTORS[name].knobs) out[knob.key] = knob.default();
  return out;
}

/**
 * Réglages effectifs d'une purge : défauts du code/environnement, surchargés
 * par ce qui a été réglé en base. Une purge absente de la table est active
 * avec ses défauts — l'état de départ reproduit le comportement d'avant.
 */
async function getSetting(name) {
  if (!DESCRIPTORS[name]) throw new Error(`Purge inconnue: ${name}`);
  const [rows] = await pool.execute(
    'SELECT enabled, overrides, updated_at, updated_by FROM purge_settings WHERE name = ?',
    [name],
  );
  const row = rows[0];
  const overrides = row?.overrides
    ? (typeof row.overrides === 'string' ? JSON.parse(row.overrides) : row.overrides)
    : {};
  const defauts = defaultsFor(name);
  const options = { ...defauts };
  for (const knob of DESCRIPTORS[name].knobs) {
    if (overrides[knob.key] != null) {
      options[knob.key] = clampInt(overrides[knob.key], {
        min: knob.min, max: knob.max, fallback: defauts[knob.key],
      });
    }
  }
  return {
    name,
    enabled: row ? !!row.enabled : true,
    options,
    defauts,
    surcharges: overrides,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

async function isEnabled(name) {
  try {
    return (await getSetting(name)).enabled;
  } catch (e) {
    // Table absente (migration non appliquée) ou base injoignable : ne pas
    // désarmer silencieusement une purge à cause d'un incident d'infra —
    // le comportement d'avant cette fonctionnalité est « toujours active ».
    console.warn(`[Purge] lecture du réglage ${name} impossible, purge maintenue active:`, e.message);
    return true;
  }
}

/** Réglages effectifs, sans jeter : sert au balayage automatique. */
async function resolveOptions(name) {
  try {
    return (await getSetting(name)).options;
  } catch {
    return defaultsFor(name);
  }
}

async function updateSetting(name, { enabled, overrides } = {}, by = null) {
  if (!DESCRIPTORS[name]) throw new Error(`Purge inconnue: ${name}`);
  const courant = await getSetting(name);
  const nextEnabled = typeof enabled === 'boolean' ? enabled : courant.enabled;

  const nextOverrides = { ...courant.surcharges };
  if (overrides && typeof overrides === 'object') {
    for (const knob of DESCRIPTORS[name].knobs) {
      if (!(knob.key in overrides)) continue;
      const brut = overrides[knob.key];
      if (brut === null || brut === '') {
        delete nextOverrides[knob.key]; // retour au défaut
      } else {
        nextOverrides[knob.key] = clampInt(brut, {
          min: knob.min, max: knob.max, fallback: courant.defauts[knob.key],
        });
      }
    }
  }

  await pool.execute(
    `INSERT INTO purge_settings (name, enabled, overrides, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
                             overrides = VALUES(overrides),
                             updated_by = VALUES(updated_by)`,
    [name, nextEnabled ? 1 : 0, JSON.stringify(nextOverrides), by],
  );
  return getSetting(name);
}

// ── Exécution + journal ─────────────────────────────────────────────────────

async function recordRun(name, { trigger = 'auto', by = null, ok, result, error, durationMs }) {
  try {
    await pool.execute(
      `INSERT INTO purge_runs (name, trigger_source, by_admin, ok, result, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, trigger, by, ok ? 1 : 0, result ? JSON.stringify(result) : null,
        error ? String(error).slice(0, 2000) : null, durationMs],
    );
  } catch (e) {
    // Le journal ne doit jamais faire échouer la purge elle-même.
    console.warn('[Purge] journalisation impossible:', e.message);
  }
}

/**
 * Exécute une purge et la journalise — y compris en cas d'échec, qui est
 * précisément ce que l'absence de journal rendait invisible jusqu'ici.
 */
async function runPurge(name, { trigger = 'auto', by = null } = {}) {
  const desc = DESCRIPTORS[name];
  if (!desc) throw new Error(`Purge inconnue: ${name}`);
  const options = await resolveOptions(name);
  const t0 = Date.now();
  try {
    const result = await desc.run(options);
    await recordRun(name, { trigger, by, ok: true, result, durationMs: Date.now() - t0 });
    return { ok: true, result };
  } catch (e) {
    console.error(`[Purge] ${name} a échoué:`, e.message);
    await recordRun(name, { trigger, by, ok: false, error: e.message, durationMs: Date.now() - t0 });
    throw e;
  }
}

/** Exécution automatique : respecte l'interrupteur, contrairement à l'appel manuel. */
async function runPurgeIfEnabled(name) {
  if (!(await isEnabled(name))) {
    console.log(`[Purge] ${name} désactivée depuis l'admin — balayage ignoré`);
    return { ok: true, skipped: true };
  }
  return runPurge(name, { trigger: 'auto' });
}

async function listRuns(name, limit = 20) {
  const n = clampInt(limit, { min: 1, max: 100, fallback: 20 });
  const [rows] = await pool.query(
    `SELECT id, name, ran_at, trigger_source, by_admin, ok, result, error, duration_ms
       FROM purge_runs WHERE name = ? ORDER BY ran_at DESC, id DESC LIMIT ?`,
    [name, n],
  );
  return rows;
}

/** Vue complète pour l'admin : réglages, ce qui serait supprimé, historique. */
async function describeAll({ withStats = true, runsPerPurge = 5 } = {}) {
  const out = [];
  for (const name of NAMES) {
    const desc = DESCRIPTORS[name];
    const setting = await getSetting(name).catch(() => ({
      name, enabled: true, options: defaultsFor(name), defauts: defaultsFor(name),
      surcharges: {}, updatedAt: null, updatedBy: null,
    }));
    let stats = null;
    let statsErreur = null;
    if (withStats) {
      try { stats = await desc.stats(setting.options); }
      catch (e) { statsErreur = e.message; }
    }
    const runs = await listRuns(name, runsPerPurge).catch(() => []);
    out.push({
      ...setting,
      label: desc.label,
      description: desc.description,
      knobs: desc.knobs.map((k) => ({
        key: k.key, label: k.label, unit: k.unit, min: k.min, max: k.max,
        defaut: k.default(), valeur: setting.options[k.key],
      })),
      stats,
      statsErreur,
      runs,
    });
  }
  return out;
}

module.exports = {
  NAMES,
  DESCRIPTORS,
  getSetting,
  updateSetting,
  isEnabled,
  resolveOptions,
  runPurge,
  runPurgeIfEnabled,
  listRuns,
  describeAll,
};
