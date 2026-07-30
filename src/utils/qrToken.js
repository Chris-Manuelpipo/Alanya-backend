// Génération de jetons opaques pour l'identité QR (users.qr_public_id) et les
// sessions de connexion QR éphémères (src/socket/state/qrLoginSessions.js).

const crypto = require('crypto');

/** Jeton aléatoire non devinable, encodé en base64url (pas de padding/slash). */
const generateOpaqueToken = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

// Base commune aux deux familles de QR. Elle vit ici et non dans les deux
// contrôleurs : chacun n'en fabrique qu'une moitié (identité pour qrController,
// connexion pour qrAuthController) mais qrController les reparse toutes les
// deux. Deux constantes séparées ont déjà divergé une fois — poser QR_BASE_URL
// ne déplaçait que les QR d'identité, laissant les QR de connexion sur
// l'ancien domaine.
const QR_BASE_URL = (process.env.QR_BASE_URL || 'https://www.alanya237.com').replace(/\/+$/, '');

/** URL encodée dans le QR d'identité d'un compte (users.qr_public_id). */
const identityPayload = (qrPublicId) => `${QR_BASE_URL}/q/u/${qrPublicId}`;

// Le point sépare sans ambiguïté : les deux jetons sont en base64url, dont
// l'alphabet ne contient pas le point.
const loginPayload = (sessionId, scanSecret) => `${QR_BASE_URL}/q/l/${sessionId}.${scanSecret}`;

/** URL d'un jeton d'ajout de contact ÉPHÉMÈRE (10 min, usage unique). */
const contactPayload = (token) => `${QR_BASE_URL}/q/c/${token}`;

// Comparaison à temps constant des secrets de QR (scanSecret, pollToken), qui
// sont l'unique preuve de possession du code. Symétrique, donc insensible à
// l'ordre des arguments — c'est justement pourquoi elle vit ici : elle était
// recopiée dans trois fichiers, avec deux conventions d'ordre opposées, et
// déplacer un appel de l'un à l'autre aurait produit une comparaison
// silencieusement fausse sur un chemin où l'échec est un contournement d'auth.
const secretMatches = (a, b) => {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

module.exports = {
  generateOpaqueToken, QR_BASE_URL, identityPayload, loginPayload, contactPayload,
  secretMatches,
};
