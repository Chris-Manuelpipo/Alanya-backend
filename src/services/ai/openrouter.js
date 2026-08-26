/**
 * Client OpenRouter — le transport, et rien d'autre.
 *
 * OpenRouter expose l'API « chat completions » d'OpenAI devant tout un
 * catalogue de modèles : en changer est une variable d'environnement, pas un
 * chantier. C'est la raison du choix, et c'est aussi ce qui interdit de
 * s'appuyer sur les extensions propriétaires d'un fournisseur — sortie
 * structurée par schéma, appels d'outils, cache de prompt. Tous les modèles du
 * catalogue ne les supportent pas, et un modèle qui ne les supporte pas répond
 * 400 au lieu de dégrader. Le JSON est donc demandé dans la consigne et validé
 * ici, à la main : c'est le seul contrat que le catalogue entier honore.
 *
 * Pas de SDK : un POST JSON suffit, et `fetch` est natif depuis Node 18
 * (`engines.node` du package). Même parti pris que `services/ipGeoService.js`.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Modèle par défaut.
 *
 * Choisi pour le trio fr/en/zh — le chinois est la langue où les écarts entre
 * modèles se voient le plus, et c'est une langue facultative de
 * `localeContent.js`, donc celle qu'on traduira le plus souvent à la machine.
 * Se remplace par `OPENROUTER_MODEL` ; le catalogue est listable sur
 * `GET https://openrouter.ai/api/v1/models`.
 */
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

const TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 30_000;

/**
 * Deux tentatives, pas plus.
 *
 * La seconde ne relance pas la même requête : elle montre au modèle sa propre
 * réponse et lui redemande du JSON. Un troisième tour ne corrigerait qu'un
 * modèle incapable de tenir la consigne — mieux vaut alors le changer.
 */
const MAX_ATTEMPTS = 2;

/** Le service est-il utilisable ? Sans clé, tout le reste est hors sujet. */
function isConfigured() {
  return Boolean(String(process.env.OPENROUTER_API_KEY || '').trim());
}

/** Modèle effectivement utilisé — exposé pour le journal et les réponses. */
function currentModel() {
  return String(process.env.OPENROUTER_MODEL || '').trim() || DEFAULT_MODEL;
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Extrait le premier objet JSON d'une réponse de modèle.
 *
 * Un modèle instruit de ne renvoyer que du JSON en renvoie presque toujours,
 * mais « presque » se paye : bloc ``` ```json ``` autour, phrase d'introduction,
 * point final après l'accolade. Plutôt que d'interdire ces variantes — ce qui
 * ne marche pas — on les traverse.
 *
 * Le balayage compte les accolades **hors chaînes** : un `}` dans un texte
 * traduit (« il a dit } ») fermerait l'objet trop tôt, et une contre-oblique
 * d'échappement ferait sortir du mode chaîne au mauvais moment.
 *
 * @throws {Error} si aucun objet complet n'est trouvé, ou s'il est invalide.
 */
function extractJson(raw) {
  const texte = String(raw ?? '').trim();
  if (!texte) throw new Error('réponse vide');

  const debut = texte.indexOf('{');
  if (debut === -1) throw new Error('aucun objet JSON');

  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;

  for (let i = debut; i < texte.length; i++) {
    const c = texte[i];

    if (dansChaine) {
      if (echappe) echappe = false;
      else if (c === '\\') echappe = true;
      else if (c === '"') dansChaine = false;
      continue;
    }

    if (c === '"') dansChaine = true;
    else if (c === '{') profondeur++;
    else if (c === '}') {
      profondeur--;
      if (profondeur === 0) {
        return JSON.parse(texte.slice(debut, i + 1));
      }
    }
  }

  throw new Error('objet JSON non refermé');
}

/**
 * Un aller-retour HTTP. Renvoie le texte brut du message d'assistant.
 *
 * Ne connaît rien au JSON attendu : c'est `chatJson` qui en juge, et qui sait
 * relancer.
 */
async function postChat(messages, { maxTokens, temperature }) {
  const baseUrl = String(process.env.OPENROUTER_BASE_URL || '').trim() || DEFAULT_BASE_URL;
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), TIMEOUT_MS);

  let reponse;
  let texte;
  try {
    reponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controleur.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        // Facultatifs chez OpenRouter, mais c'est ce qui sépare la consommation
        // d'Alanya du reste du compte dans leur tableau de bord.
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://www.alanya237.com',
        'X-Title': 'Alanya Admin',
      },
      body: JSON.stringify({
        model: currentModel(),
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
    });
    texte = await reponse.text();
  } catch (error) {
    // Le timeout arrive ici sous forme d'AbortError : le distinguer d'une
    // panne réseau change le code renvoyé à l'administrateur, donc le message
    // qu'il lit.
    if (error.name === 'AbortError') {
      throw httpError(`Le modèle n'a pas répondu en ${Math.round(TIMEOUT_MS / 1000)} s`, 504);
    }
    throw httpError(`Fournisseur injoignable : ${error.message}`, 502);
  } finally {
    clearTimeout(minuteur);
  }

  if (!reponse.ok) {
    // 401/402 sont des erreurs de configuration côté Alanya, pas des pannes du
    // fournisseur : les renvoyer en 502 enverrait chercher la panne au mauvais
    // endroit. 429 se propage tel quel pour que l'interface propose d'attendre.
    if (reponse.status === 401 || reponse.status === 403) {
      throw httpError('Clé OpenRouter refusée', 503);
    }
    if (reponse.status === 402) {
      throw httpError('Crédit OpenRouter épuisé', 503);
    }
    if (reponse.status === 429) {
      throw httpError('Quota du modèle atteint, réessayez dans un instant', 429);
    }
    throw httpError(`Fournisseur en erreur (${reponse.status})`, 502);
  }

  let payload;
  try {
    payload = JSON.parse(texte);
  } catch {
    throw httpError('Réponse du fournisseur illisible', 502);
  }

  // OpenRouter peut répondre 200 avec une erreur dans le corps quand le modèle
  // demandé n'existe pas ou que le fournisseur amont a refusé.
  if (payload?.error) {
    throw httpError(`Modèle en erreur : ${payload.error.message || 'raison inconnue'}`, 502);
  }

  const contenu = payload?.choices?.[0]?.message?.content;
  if (typeof contenu !== 'string' || !contenu.trim()) {
    throw httpError('Le modèle a répondu sans contenu', 502);
  }
  return contenu;
}

/**
 * Demande un objet JSON au modèle et le renvoie parsé.
 *
 * @param {{system: string, user: string, maxTokens?: number, temperature?: number}} params
 * @returns {Promise<object>}
 * @throws {Error} portant `.status` — 503 non configuré, 429 quota, 502/504
 *   fournisseur. Le contrôleur n'a plus qu'à le relayer.
 */
async function chatJson({ system, user, maxTokens = 2_000, temperature = 0.2 }) {
  if (!isConfigured()) {
    throw httpError('Assistance éditoriale non configurée (OPENROUTER_API_KEY absente)', 503);
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let dernierEchec = null;
  for (let essai = 1; essai <= MAX_ATTEMPTS; essai++) {
    const brut = await postChat(messages, { maxTokens, temperature });
    try {
      return extractJson(brut);
    } catch (error) {
      dernierEchec = error;
      // On lui remet sa réponse sous les yeux : un modèle qui a bavardé se
      // corrige au tour suivant, là où répéter la question à l'identique
      // reproduit souvent le même bavardage.
      messages.push({ role: 'assistant', content: brut });
      messages.push({
        role: 'user',
        content:
          "Ta réponse n'était pas exploitable comme JSON. Renvoie uniquement "
          + "l'objet JSON demandé, sans texte autour ni bloc de code.",
      });
    }
  }

  throw httpError(`Réponse du modèle inexploitable : ${dernierEchec.message}`, 502);
}

module.exports = { chatJson, extractJson, isConfigured, currentModel, DEFAULT_MODEL };
