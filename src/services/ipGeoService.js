// Traduction d'une adresse IP en lieu approximatif (« Douala, Cameroun »), pour
// l'écran de confirmation de connexion par QR.
//
// Pourquoi : sur cet écran, le nom et la plateforme de l'appareil demandeur sont
// DÉCLARÉS par lui, donc falsifiables. L'adresse IP est la seule information que
// le serveur constate — mais sous sa forme brute elle n'apprend rien à qui n'est
// pas technicien. La rendre lisible est ce qui permet à l'utilisateur de
// répondre « ce n'est pas moi » en un coup d'œil.
//
// Fournisseur : ipwhois.io (endpoint ipwho.is, sans clé). Deux conséquences
// assumées : les adresses IP de nos utilisateurs transitent par un tiers, et le
// service peut être lent ou indisponible. La résolution est donc lancée à la
// CRÉATION de la session, jamais dans le chemin d'approbation, et son échec est
// silencieux : l'écran retombe alors sur l'adresse brute.

const TIMEOUT_MS = 2500;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // la géolocalisation d'une IP bouge peu

// ip -> { label, expiresAt }
const _cache = new Map();

/** Adresses non routables : aucun tiers n'a d'information à leur sujet. */
const _estPrivee = (ip) =>
  !ip ||
  ip === 'INDEFINI' ||
  ip === '::1' ||
  ip.startsWith('127.') ||
  ip.startsWith('10.') ||
  ip.startsWith('192.168.') ||
  ip.startsWith('169.254.') ||
  ip.startsWith('fc') ||
  ip.startsWith('fd') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

const _lireCache = (ip) => {
  const hit = _cache.get(ip);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(ip);
    return undefined;
  }
  return hit.label;
};

const _ecrireCache = (ip, label) => {
  if (_cache.size >= CACHE_MAX) {
    const plusAncienne = _cache.keys().next();
    if (!plusAncienne.done) _cache.delete(plusAncienne.value);
  }
  _cache.set(ip, { label, expiresAt: Date.now() + CACHE_TTL_MS });
};

/**
 * @returns {Promise<string|null>} « Ville, Pays », « Pays », ou null si
 *   l'adresse est privée, le service indisponible ou la réponse inexploitable.
 *   Ne lève jamais : un échec de géolocalisation ne doit pas casser une
 *   connexion.
 */
const lookupLocation = async (ip) => {
  const adresse = String(ip || '').trim();
  if (_estPrivee(adresse)) return null;

  const enCache = _lireCache(adresse);
  if (enCache !== undefined) return enCache;

  try {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), TIMEOUT_MS);
    let data;
    try {
      const reponse = await fetch(
        `https://ipwho.is/${encodeURIComponent(adresse)}?fields=success,city,country`,
        { signal: controleur.signal },
      );
      if (!reponse.ok) return null;
      data = await reponse.json();
    } finally {
      clearTimeout(minuteur);
    }

    if (!data || data.success !== true) return null;
    const ville = typeof data.city === 'string' ? data.city.trim() : '';
    const pays = typeof data.country === 'string' ? data.country.trim() : '';
    const label = [ville, pays].filter(Boolean).join(', ') || null;
    if (label) _ecrireCache(adresse, label);
    return label;
  } catch (error) {
    // Timeout, DNS, quota du fournisseur : on dégrade sans bruit.
    console.warn('[ipGeo] lookup échoué:', error.message);
    return null;
  }
};

module.exports = { lookupLocation };
