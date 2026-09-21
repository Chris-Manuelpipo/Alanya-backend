const pool = require('../config/db');
const { storedKeyFromUrl, listPrefix } = require('../services/mediaStorage');

/** Au-delà, la requête est refusée plutôt que de lister le bucket sans fin. */
const MAX_IDS = 2000;

/**
 * Tailles des objets présents chez Backblaze, pour un ensemble de clés.
 *
 * Une liste par dossier de partition plutôt qu'une requête par média : un
 * export demande jusqu'à 2 000 médias, qui tiennent dans au plus quelques
 * dizaines de dossiers (un par jour et par type).
 */
async function taillesChezB2(cles) {
  const dossiers = new Set(cles.map((k) => k.slice(0, k.lastIndexOf('/') + 1)));
  const tailles = new Map();
  for (const dossier of dossiers) {
    // eslint-disable-next-line no-await-in-loop
    for (const o of await listPrefix(dossier)) tailles.set(o.key, o.size);
  }
  return tailles;
}

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
 * L'existence de **l'objet chez Backblaze**, pas seulement la date de
 * partition. Un média peut manquer pour d'autres raisons qu'une purge, et
 * annoncer récupérable ce qui ne l'est pas est précisément le défaut qu'on
 * corrige.
 */
exports.checkAvailability = async (req, res) => {
  const raw = req.body?.msgIDs;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'msgIDs requis', code: 'MSG_IDS_REQUIRED' });
  }
  if (raw.length > MAX_IDS) {
    return res.status(400).json({ error: `Maximum ${MAX_IDS} identifiants`, code: 'LIMIT_REACHED' });
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
    const aChercher = [];
    for (const row of rows) {
      const key = storedKeyFromUrl(row.mediaUrl);
      if (key) aChercher.push({ msgID: row.msgID, key });
    }

    if (aChercher.length > 0) {
      let tailles;
      try {
        tailles = await taillesChezB2(aChercher.map((c) => c.key));
      } catch (e) {
        console.error('[MediaAvailability] Backblaze injoignable:', e.message);
        return res.status(503).json({ error: 'Stockage des médias indisponible', code: 'STORAGE_UNAVAILABLE' });
      }
      for (const c of aChercher) {
        if (!tailles.has(c.key)) continue; // absent : irrécupérable
        available.push(c.msgID);
        bytes[c.msgID] = tailles.get(c.key);
      }
    }

    return res.json({ available, bytes });
  } catch (e) {
    console.error('[MediaAvailability] ERROR:', e);
    return res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
  }
};
