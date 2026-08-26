const {
  translateContent,
  reviewContent,
  isConfigured,
} = require('../../services/ai/editorialAssist');
const { currentModel } = require('../../services/ai/openrouter');

/**
 * Assistance éditoriale, côté HTTP.
 *
 * Trois routes, aucune écriture en base : l'assistance remplit des champs de
 * formulaire, et c'est `PUT /welcome/draft` ou `POST /broadcasts` qui décide
 * ensuite. Un échec ici ne doit donc jamais coûter plus qu'un bouton qui
 * n'aboutit pas — l'administrateur garde sa saisie et traduit à la main.
 *
 * Les erreurs du service portent déjà leur statut (400 saisie, 429 quota, 502
 * fournisseur, 503 non configuré) : on le relaie tel quel plutôt que de tout
 * aplatir en 500, sans quoi « ta clé est refusée » et « le modèle a bafouillé »
 * se lisent pareil.
 */

/**
 * L'assistance est-elle disponible ?
 *
 * Consultée au chargement de l'éditeur : sans clé configurée, l'interface
 * n'affiche pas de bouton plutôt que d'en afficher un qui échouera. La
 * permission dit ce que l'administrateur a le droit de faire, celle-ci dit ce
 * que le serveur peut faire — les deux sont nécessaires.
 */
const getAiStatus = async (req, res) => {
  try {
    const enabled = isConfigured();
    res.json({ enabled, model: enabled ? currentModel() : null });
  } catch (e) {
    console.error('[Admin] getAiStatus:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const postTranslate = async (req, res) => {
  try {
    const { content, sourceLocale, targets, kind } = req.body || {};
    const result = await translateContent({ content, sourceLocale, targets, kind });
    res.json(result);
  } catch (e) {
    // Une saisie invalide est le fait de l'appelant, pas un incident : elle
    // n'a rien à faire dans les logs d'erreur du serveur.
    if (!e.status || e.status >= 500) {
      console.error('[Admin] aiTranslate:', e.message);
    }
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
};

const postReview = async (req, res) => {
  try {
    const { translations, kind } = req.body || {};
    const result = await reviewContent({ translations, kind });
    res.json(result);
  } catch (e) {
    if (!e.status || e.status >= 500) {
      console.error('[Admin] aiReview:', e.message);
    }
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
};

module.exports = { getAiStatus, postTranslate, postReview };
