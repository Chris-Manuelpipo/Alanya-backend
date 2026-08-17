const pool = require('../../config/db');
const {
  estimateAudience,
  publishBroadcast,
  findBroadcastByClientId,
  mapBroadcastRow,
} = require('../../services/broadcastService');
const { enqueue } = require('../../services/jobQueue');
const { getOfficialAccountId } = require('../../utils/officialAccountGuard');
const { buildBroadcastWhere } = require('./broadcastQuery');
const {
  SUPPORTED_CONTENT_LOCALES,
  REQUIRED_CONTENT_LOCALES,
} = require('../../utils/localeContent');

const listBroadcasts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const { whereSql, params, sortCol, dir } = buildBroadcastWhere(req.query);

    const [items] = await pool.execute(
      `SELECT b.*, u.nom AS sender_nom
       FROM broadcast b
       JOIN users u ON b.sender_id = u.alanyaID
       ${whereSql}
       ORDER BY ${sortCol} ${dir}
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM broadcast b ${whereSql}`,
      params,
    );

    const [scheduled] = await pool.execute(
      `SELECT id AS jobId, payload, run_after AS scheduledAt
       FROM job_queue
       WHERE kind = 'broadcast_send' AND failed_at IS NULL
       ORDER BY run_after ASC
       LIMIT 20`,
    );

    res.json({
      items: items.map(mapBroadcastRow),
      total,
      page,
      limit,
      scheduled: scheduled.map((s) => ({
        jobId: s.jobId,
        scheduledAt: s.scheduledAt,
        payload: typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload,
      })),
    });
  } catch (e) {
    console.error('[Admin] listBroadcasts:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const getBroadcast = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT b.*, u.nom AS sender_nom FROM broadcast b
       JOIN users u ON b.sender_id = u.alanyaID
       WHERE b.id = ?`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Diffusion introuvable' });
    res.json(mapBroadcastRow(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const estimateBroadcast = async (req, res) => {
  try {
    const { criteria } = req.body || {};
    if (!criteria) return res.status(400).json({ error: 'criteria requis' });
    const result = await estimateAudience(criteria);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

/** Couleur acceptée par l'app : `#RRGGBB` (cf. `_parseColor` du viewer). */
function normalizeBackgroundColor(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const hex = v.startsWith('#') ? v.slice(1) : v;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    const err = new Error('Couleur de fond invalide (#RRGGBB attendu)');
    err.status = 400;
    throw err;
  }
  return `#${hex.toUpperCase()}`;
}

const createBroadcast = async (req, res) => {
  try {
    const {
      senderId,
      kind: kindRaw = 0,
      content,
      contentEn,
      // Traductions par locale — `{ fr, en, zh }`. Le couple content/contentEn
      // reste accepté pour les clients non migrés.
      translations: translationsRaw,
      type = 0,
      mediaUrl,
      backgroundColor,
      criteria,
      clientId,
      estimate,
      confirmedEstimate,
      scheduledAt,
      isStatus,
    } = req.body || {};

    const kind = isStatus === true || isStatus === 1 || isStatus === 'true'
      ? 1
      : Number(kindRaw);

    if (!senderId || !criteria || !clientId) {
      return res.status(400).json({ error: 'senderId, criteria et clientId requis' });
    }
    // Normalise les deux formes acceptées vers un seul objet par locale.
    const translations = {};
    for (const loc of SUPPORTED_CONTENT_LOCALES) {
      const v = translationsRaw && translationsRaw[loc];
      if (v != null && String(v).trim()) translations[loc] = String(v).trim();
    }
    if (!translations.fr && content && String(content).trim()) {
      translations.fr = String(content).trim();
    }
    if (!translations.en && contentEn && String(contentEn).trim()) {
      translations.en = String(contentEn).trim();
    }

    // Français et anglais restent obligatoires : sans eux, la chaîne de repli
    // n'a rien à servir et un lecteur verrait une annonce vide. Les autres
    // langues sont facultatives — les exiger bloquerait toute publication
    // jusqu'à ce qu'un traducteur soit disponible, et le repli couvre
    // l'absence.
    for (const loc of REQUIRED_CONTENT_LOCALES) {
      if (!translations[loc]) {
        return res
          .status(400)
          .json({ error: `content (${loc.toUpperCase()}) requis` });
      }
    }

    // Il n'existe qu'un compte officiel, et toutes les diffusions en émanent :
    // c'est la règle « une seule voix ». On compare à l'identifiant canonique
    // plutôt qu'au seul genre de compte, pour que l'apparition accidentelle
    // d'un second compte officiel ne fragmente pas l'identité côté utilisateur.
    const officialId = await getOfficialAccountId();
    if (officialId == null) {
      return res.status(409).json({
        error: 'Aucun compte officiel : créez-le avant de diffuser',
        code: 'OFFICIAL_ACCOUNT_MISSING',
      });
    }
    if (Number(senderId) !== officialId) {
      return res.status(400).json({
        error: 'L\'expéditeur doit être le compte officiel',
        code: 'OFFICIAL_SENDER_REQUIRED',
        expected: officialId,
      });
    }

    const { count, criteria: resolved } = await estimateAudience(criteria);
    if (confirmedEstimate != null && Number(confirmedEstimate) !== count) {
      return res.status(409).json({ error: 'Estimation obsolète', count, estimate: count, criteria: resolved });
    }

    const result = await publishBroadcast({
      senderId: Number(senderId),
      createdBy: req.user.alanyaID,
      kind,
      content: translations.fr,
      contentEn: translations.en,
      translations,
      type: Number(type),
      mediaUrl: mediaUrl || null,
      // Seul un statut porte une couleur de fond ; l'ignorer pour un message
      // évite de stocker un réglage qui n'aurait aucun effet visible.
      backgroundColor: kind === 1 ? normalizeBackgroundColor(backgroundColor) : null,
      criteria,
      clientId,
      estimate: estimate ?? count,
      scheduledAt: scheduledAt || null,
    });

    if (result.duplicate) {
      return res.status(409).json({ error: 'clientId déjà utilisé', id: result.id });
    }
    if (result.scheduled) {
      return res.status(201).json(result);
    }
    res.status(201).json(result);
  } catch (e) {
    console.error('[Admin] createBroadcast:', e.message);
    // Une saisie invalide (couleur mal formée) doit ressortir en 400, sans quoi
    // l'admin voit « Erreur serveur » pour une faute qui est la sienne.
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
};

const cancelScheduled = async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const [rows] = await pool.execute(
      `SELECT id FROM job_queue WHERE id = ? AND kind = 'broadcast_send' AND failed_at IS NULL`,
      [jobId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Job introuvable' });
    await pool.execute('DELETE FROM job_queue WHERE id = ?', [jobId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  listBroadcasts,
  getBroadcast,
  estimateBroadcast,
  createBroadcast,
  cancelScheduled,
};
