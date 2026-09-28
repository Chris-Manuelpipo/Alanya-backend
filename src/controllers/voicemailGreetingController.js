/**
 * Annonce vocale du répondeur : dépôt, remplacement, suppression.
 *
 * L'annonce est un réglage, pas un message. Elle ne passe donc PAS par
 * `POST /upload/media`, qui la rangerait sous `media/<jour>/` : elle serait
 * traitée comme un média de discussion, qui expire. Elle vit sous
 * `voicemail/`, dans le bucket public `profilemedia`, que rien ne purge.
 *
 * Chaque enregistrement produit un NOUVEAU nom de fichier, avec un suffixe
 * aléatoire, et l'ancien est supprimé. Ce n'est pas seulement de l'hygiène :
 * le cache média de l'application indexe par le dernier segment de l'URL, sans
 * aucune invalidation par contenu. Sous un nom stable, les appelants
 * entendraient éternellement la première version.
 */

const fs = require('fs/promises');

const {
  loadUserVoicemailSchedule,
  upsertUserVoicemailSchedule,
} = require('../services/voicemailScheduleService');
const { emitToUser } = require('../utils/userSocketRegistry');
const { isB2Enabled, putFile, publicUrl, removeAllVersions, keyFromUrl } =
  require('../services/mediaStorage');

/** Plafond de durée, en secondes. « Quelques secondes », pas un monologue. */
const MAX_GREETING_SECONDS = 10;

/** Supprime l'annonce précédente. Un échec ici ne doit jamais bloquer la nouvelle. */
const _supprimerFichier = async (url) => {
  if (!url) return;
  try {
    if (!isB2Enabled()) return;
    // Seulement une annonce : quoi que désigne l'adresse, rien d'autre ne
    // part d'ici.
    const cle = keyFromUrl(url);
    if (cle && cle.startsWith('voicemail/')) await removeAllVersions(cle);
  } catch (e) {
    console.warn('[VoicemailGreeting] ancien fichier non supprimé:', e.message);
  }
};

const _diffuser = (req, alanyaID, payload) => {
  // Les autres appareils du compte doivent voir la nouvelle annonce sans
  // attendre : le réglage est par compte.
  emitToUser(req.app.get('io'), alanyaID, 'voicemail_greeting_updated', payload);
};

const putVoicemailGreeting = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier envoyé', code: 'FILE_REQUIRED' });
    }
    const alanyaID = req.user.alanyaID;

    const secondes = Number(req.body?.seconds);
    if (!Number.isFinite(secondes) || secondes < 1 || secondes > MAX_GREETING_SECONDS) {
      // Le fichier de transit ne doit pas survivre au refus.
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        error: `L'annonce doit durer entre 1 et ${MAX_GREETING_SECONDS} secondes`,
        code: 'GREETING_TOO_LONG',
      });
    }

    let url;
    try {
      if (!isB2Enabled()) throw new Error('Backblaze non configuré');
      await putFile(req.file.storageKey, req.file.path, { contentType: req.file.mimetype });
      url = publicUrl(req.file.storageKey);
    } catch (e) {
      console.error('[VoicemailGreeting] dépôt Backblaze échoué:', e.message);
      return res.status(503).json({ error: 'Stockage indisponible', code: 'STORAGE_UNAVAILABLE' });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }

    // L'ancienne est supprimée APRÈS que la nouvelle est écrite : à aucun
    // moment le compte ne se retrouve sans annonce alors qu'il en avait une.
    const avant = await loadUserVoicemailSchedule(alanyaID);
    await upsertUserVoicemailSchedule(alanyaID, {
      greeting_url: url,
      greeting_seconds: Math.round(secondes),
    });
    await _supprimerFichier(avant.greeting_url);

    const payload = { greetingUrl: url, greetingSeconds: Math.round(secondes) };
    _diffuser(req, alanyaID, payload);
    res.json(payload);
  } catch (error) {
    console.error('[VoicemailGreeting] put error:', error.message);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

const deleteVoicemailGreeting = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const avant = await loadUserVoicemailSchedule(alanyaID);
    await upsertUserVoicemailSchedule(alanyaID, {
      greeting_url: null,
      greeting_seconds: null,
    });
    await _supprimerFichier(avant.greeting_url);

    const payload = { greetingUrl: null, greetingSeconds: null };
    _diffuser(req, alanyaID, payload);
    res.json(payload);
  } catch (error) {
    console.error('[VoicemailGreeting] delete error:', error.message);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

module.exports = {
  MAX_GREETING_SECONDS,
  putVoicemailGreeting,
  deleteVoicemailGreeting,
};
