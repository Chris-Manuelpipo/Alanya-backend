const ACCOUNT_TYPE = Object.freeze({
  PERSONNEL: 0,
  BUSINESS: 1,
  OFFICIEL: 2,
});

const VERIFICATION = Object.freeze({
  NON_DEMANDE: 0,
  EN_COURS: 1,
  VERIFIE: 2,
  REFUSE: 3,
  EXPIRE: 4,
  REVOQUE: 5,
});

/**
 * Avatar imposé aux comptes officiels : le logo Alanya.
 *
 * `OFFICIAL_ACCOUNT_AVATAR_URL` permet d'en servir une variante dédiée (carrée,
 * dimensionnée pour une pastille). À défaut on retombe sur `LOGO_URL`, de sorte
 * que la règle « un compte officiel porte le logo » s'applique même sans
 * configuration supplémentaire — sans ce repli, elle était silencieusement
 * inerte et le compte officiel héritait de l'avatar par défaut anonyme.
 *
 * @returns {string|null} l'URL, ou null si aucune n'est configurée.
 */
const resolveOfficialAvatarUrl = () => {
  const url = process.env.OFFICIAL_ACCOUNT_AVATAR_URL || process.env.LOGO_URL;
  const trimmed = typeof url === 'string' ? url.trim() : '';
  return trimmed && trimmed.startsWith('http') ? trimmed : null;
};

module.exports = { ACCOUNT_TYPE, VERIFICATION, resolveOfficialAvatarUrl };
