// Page d'accueil publique d'un QR d'identité (`GET /q/u/:token`).
//
// Le QR encode une URL pour qu'un scan par un appareil photo générique mène
// quelque part plutôt que d'afficher une chaîne incompréhensible. Sans cette
// page, cette URL renvoyait le 404 brut d'Express.
//
// Cette page ne fait qu'UNE chose : identifier la personne et transporter le
// jeton jusqu'à l'application. Elle n'ajoute aucun contact — elle n'est pas
// authentifiée, elle ne sait pas qui la consulte. C'est l'app, une fois
// ouverte, qui résout le jeton et écrit le contact. Un lien ouvert par erreur
// dans un navigateur reste donc sans effet.

const pool = require('../config/db');

const APP_SCHEME = process.env.QR_APP_SCHEME || 'alanya';
const PLAY_URL = process.env.QR_PLAY_STORE_URL || '';
const APPSTORE_URL = process.env.QR_APP_STORE_URL || '';

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const _sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  return trimmed.startsWith('http') ? trimmed : null;
};

/** Échappement HTML — ces valeurs viennent de la base et finissent dans le DOM. */
const _esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Groupe l'Alanya ID par deux chiffres, comme l'app le fait à l'affichage. */
const _formatPhone = (phone) =>
  String(phone ?? '').replace(/\D/g, '').replace(/(\d{2})(?=\d)/g, '$1 ').trim();

const _page = ({ titre, corps }) => `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${_esc(titre)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #F5F6FA; color: #1A1C22;
  }
  .carte {
    width: 100%; max-width: 380px; background: #FFF; border-radius: 20px;
    padding: 32px 24px; text-align: center;
    box-shadow: 0 8px 32px rgba(16, 20, 40, .10);
  }
  .avatar {
    width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
    margin: 0 auto 16px; display: block; background: #E4E7F2;
  }
  .initiale {
    width: 96px; height: 96px; border-radius: 50%; margin: 0 auto 16px;
    display: flex; align-items: center; justify-content: center;
    background: #3F51B5; color: #FFF; font-size: 40px; font-weight: 600;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .pseudo { color: #6B7280; margin: 0 0 2px; font-size: 15px; }
  .ident { color: #6B7280; margin: 0 0 24px; font-size: 14px;
           font-variant-numeric: tabular-nums; }
  .bouton {
    display: block; padding: 14px 20px; border-radius: 12px;
    text-decoration: none; font-weight: 600; font-size: 16px; margin-bottom: 10px;
    background: #3F51B5; color: #FFF;
  }
  .secondaire { background: transparent; color: #3F51B5; font-weight: 500;
                font-size: 15px; border: 1px solid #D7DAE6; }
  .note { color: #6B7280; font-size: 13px; line-height: 1.5; margin: 16px 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0F1116; color: #ECEDF2; }
    .carte { background: #191C24; box-shadow: none; }
    .pseudo, .ident, .note { color: #9BA1B0; }
    .secondaire { color: #97A2FF; border-color: #2C3040; }
  }
</style>
<div class="carte">${corps}</div>
`;

const _pageIntrouvable = () =>
  _page({
    titre: 'Code Alanya expiré',
    corps: `
    <div class="initiale">?</div>
    <h1>Ce code n'est plus valide</h1>
    <p class="note">
      Il a peut-être été régénéré par son propriétaire. Demandez-lui de vous
      partager son code Alanya à nouveau.
    </p>`,
  });

const showIdentityLanding = async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) {
      return res.status(404).type('html').send(_pageIntrouvable());
    }

    const [rows] = await pool.execute(
      `SELECT nom, pseudo, alanyaPhone, avatar_url
       FROM users
       WHERE qr_public_id = ? AND exclus = 0`,
      [token],
    );

    if (rows.length === 0) {
      return res.status(404).type('html').send(_pageIntrouvable());
    }

    const u = rows[0];
    const nom = (u.nom || '').trim() || (u.pseudo || '').trim() || 'Utilisateur Alanya';
    const avatar = _sanitizeUrl(u.avatar_url);
    const phone = _formatPhone(u.alanyaPhone);

    // Schéma applicatif et non lien https : les liens universels vérifiés
    // exigent l'empreinte de signature Android et le Team ID Apple, absents
    // du projet. Le schéma fonctionne sans aucun de ces prérequis ; le jour
    // où ils existent, l'intent-filter https prend le relais sans toucher
    // cette page.
    const lienApp = `${APP_SCHEME}://q/u/${encodeURIComponent(token)}`;

    const boutonsStore = [
      PLAY_URL && `<a class="bouton secondaire" href="${_esc(PLAY_URL)}">Télécharger sur Android</a>`,
      APPSTORE_URL && `<a class="bouton secondaire" href="${_esc(APPSTORE_URL)}">Télécharger sur iPhone</a>`,
    ].filter(Boolean).join('\n');

    const corps = `
    ${avatar
      ? `<img class="avatar" src="${_esc(avatar)}" alt="">`
      : `<div class="initiale">${_esc(nom.charAt(0).toUpperCase())}</div>`}
    <h1>${_esc(nom)}</h1>
    ${u.pseudo ? `<p class="pseudo">@${_esc(u.pseudo)}</p>` : ''}
    ${phone ? `<p class="ident">Alanya ID ${_esc(phone)}</p>` : ''}
    <a class="bouton" href="${_esc(lienApp)}">Ouvrir dans Alanya</a>
    ${boutonsStore}
    <p class="note">
      Ouvrez ce lien depuis votre téléphone : Alanya vous proposera d'ajouter
      ${_esc(nom)} à vos contacts préférés.
    </p>`;

    res.type('html').send(_page({ titre: `${nom} sur Alanya`, corps }));
  } catch (error) {
    console.error('[qrLanding] ERROR:', error);
    res.status(500).type('html').send(_pageIntrouvable());
  }
};

module.exports = { showIdentityLanding };
