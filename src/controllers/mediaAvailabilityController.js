const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

/** Au-delà, la requête est refusée plutôt que de balayer le disque sans fin. */
const MAX_IDS = 2000;

/**
 * Chemin disque d'un média à partir de son URL publique.
 *
 * Renvoie `null` si l'URL ne pointe pas dans `uploads/`, ou si elle tente de
 * remonter l'arborescence. Le contrôle de remontée n'est pas théorique : cette
 * URL vient de la base, mais la base a été alimentée par des clients.
 */
const _diskPath = (mediaUrl) => {
  if (!mediaUrl) return null;
  const marker = '/uploads/';
  const idx = String(mediaUrl).indexOf(marker);
  if (idx === -1) return null;

  const relative = decodeURIComponent(mediaUrl.substring(idx + marker.length));
  const resolved = path.resolve(UPLOADS_DIR, relative);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return null;
  return resolved;
};

/**
 * `POST /api/media/availability` — parmi ces médias, lesquels existent encore ?
 *
 * ── Pourquoi cette route existe ──
 *
 * Avant d'exporter une période, l'application doit dire à l'inscrit combien
 * d'éléments manquants elle peut récupérer, et ce que ça va coûter. Elle ne
 * peut pas le deviner seule : sa seule information hors ligne est la durée de
 * rétention, qu'elle **déduit** des réponses `410` déjà reçues. Tant qu'elle
 * ne l'a jamais rencontrée, elle croit tout récupérable — et promet des
 * téléchargements qui échoueront.
 *
 * Une requête ici, de quelques kilo-octets, remplace cette devinette par un
 * fait. Elle **économise** de la bande passante au lieu d'en dépenser : sans
 * elle, le client lançait des dizaines de téléchargements voués au `410`.
 *
 * Le serveur répond aussi les tailles réelles, ce que le client ne pouvait
 * qu'estimer à partir d'une moyenne.
 *
 * ── Ce qui est vérifié ──
 *
 * L'existence du **fichier sur le disque**, pas seulement la date de partition.
 * Un fichier peut manquer pour d'autres raisons qu'une purge, et annoncer
 * récupérable ce qui ne l'est pas est précisément le défaut qu'on corrige.
 */
exports.checkAvailability = async (req, res) => {
  const raw = req.body?.msgIDs;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'msgIDs requis' });
  }
  if (raw.length > MAX_IDS) {
    return res.status(400).json({ error: `Maximum ${MAX_IDS} identifiants` });
  }

  const ids = [...new Set(
    raw.map((v) => Number.parseInt(v, 10)).filter((v) => Number.isInteger(v) && v > 0),
  )];
  if (ids.length === 0) return res.json({ available: [], bytes: {} });

  try {
    // Restreint aux messages des conversations de l'appelant : sans ce filtre,
    // n'importe qui pourrait sonder l'existence des médias de n'importe qui,
    // et en déduire une activité qui ne le regarde pas.
    const [rows] = await pool.query(
      `SELECT m.msgID, m.mediaUrl
         FROM message m
         JOIN conv_participants cp ON cp.conversID = m.conversationID
        WHERE m.msgID IN (?) AND cp.alanyaID = ?`,
      [ids, req.user.alanyaID],
    );

    const available = [];
    const bytes = {};
    for (const row of rows) {
      const filePath = _diskPath(row.mediaUrl);
      if (!filePath) continue;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        available.push(row.msgID);
        bytes[row.msgID] = stat.size;
      } catch (_) {
        // Absent : purgé, ou jamais arrivé. Dans les deux cas, irrécupérable —
        // et c'est exactement ce que l'appelant a besoin de savoir.
      }
    }

    return res.json({ available, bytes });
  } catch (e) {
    console.error('[MediaAvailability] ERROR:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

exports._diskPath = _diskPath;
