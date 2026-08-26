/**
 * Assistance éditoriale — traduire et relire le contenu **officiel**.
 *
 * Périmètre, et il est étroit : ce que l'administration écrit elle-même —
 * message de bienvenue, diffusion, statut officiel, libellé de bouton. Jamais
 * un message d'utilisateur. La traduction des conversations reste on-device
 * (ML Kit) et le restera : ce n'est ni le même contenu, ni le même contrat, ni
 * les mêmes destinataires. Rien de ce qui transite ici n'est une donnée
 * personnelle — c'est ce qui rend ce chantier livrable sans dossier RGPD.
 *
 * L'assistance ne publie pas. Elle remplit des champs que l'administrateur
 * relit, corrige et valide : `untranslatedRequiredLocales` garde la
 * publication, ici comme avant.
 */

const {
  SUPPORTED_CONTENT_LOCALES,
  supportedLocale,
} = require('../../utils/localeContent');
const { chatJson, currentModel, isConfigured } = require('./openrouter');

/**
 * Plafond de la source envoyée au modèle.
 *
 * Un bloc de bienvenue tient en quelques lignes ; 4 000 caractères couvrent
 * très large. Le plafond n'est pas là pour la qualité mais pour la facture :
 * sans lui, un copier-coller malheureux part en jetons.
 */
const SOURCE_MAX = 4_000;

/**
 * Corps de notification push, tronqué à 120 caractères.
 *
 * Miroir de `broadcastService.js` (`String(localizedBody).slice(0, 120)`) : le
 * modèle doit connaître la contrainte pour ne pas produire une traduction qui
 * passe en français et se fait couper en chinois.
 */
const PUSH_BODY_MAX = 120;

/**
 * Natures de contenu, et ce qu'elles changent pour le modèle.
 *
 * Le ton et la longueur d'un libellé de bouton n'ont rien à voir avec ceux
 * d'une annonce : un seul prompt générique produirait des boutons en phrases
 * complètes. Ajouter une nature ici suffit — le contrôleur valide contre ces
 * clés.
 */
const KINDS = {
  welcome: {
    label: 'un message de bienvenue envoyé aux nouveaux inscrits',
    guidance:
      "Ton chaleureux mais sobre, vouvoiement. Une à quatre phrases. C'est le "
      + "premier message que la personne reçoit : accueillant, jamais commercial.",
  },
  broadcast: {
    label: 'une annonce diffusée à un ensemble d\'utilisateurs',
    guidance:
      `Ton informatif et direct. Les ${PUSH_BODY_MAX} premiers caractères partent `
      + "en notification push : l'essentiel doit y tenir, dans chaque langue.",
  },
  status: {
    label: 'un statut officiel publié par le compte Alanya',
    guidance: 'Très court, une phrase. Se lit en un coup d\'œil par-dessus une image.',
  },
  cta: {
    label: 'le libellé d\'un bouton d\'action',
    guidance:
      "Deux à quatre mots, à l'impératif, sans ponctuation finale. Doit tenir "
      + 'sur un bouton étroit — préférer court à littéral.',
  },
};

/**
 * Règles de forme communes à toutes les natures.
 *
 * Le balisage est celui de `lib/rich-text-parser.ts` côté admin et de
 * `rich_text_parser.dart` côté application : un modèle qui « nettoie » les
 * astérisques produit un texte juste et un rendu faux, et personne ne s'en
 * aperçoit avant la publication.
 */
const FORM_RULES = `
Règles de forme, sans exception :
- Conserve le balisage tel quel : *gras*, _italique_, ~barré~, =souligné=, #manuscrit#.
  Les marqueurs encadrent la portion traduite, ils ne se traduisent pas et ne
  se suppriment pas.
- Conserve les émojis, à leur place.
- Conserve les sauts de ligne et les paragraphes.
- « Alanya » est un nom de marque : jamais traduit, jamais translittéré.
- Ne conserve pas les URL en les traduisant : recopie-les à l'identique.
- Traduis le sens, pas les mots. Une tournure naturelle dans la langue cible
  vaut mieux qu'un décalque du français.
- N'ajoute rien : pas de formule de politesse absente de la source, pas de
  commentaire, pas de note du traducteur.`;

/** Nom des langues, pour que la consigne ne parle pas en codes ISO. */
const LOCALE_NAMES = {
  fr: 'français',
  en: 'anglais',
  zh: 'chinois simplifié',
};

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Nature du contenu, ou lève. */
function normalizeKind(raw) {
  const kind = String(raw || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) {
    throw httpError('Nature de contenu inconnue', 400);
  }
  return kind;
}

/**
 * Texte source à traduire, ou lève.
 *
 * Tronquer plutôt que refuser au-delà du plafond : l'administrateur récupère
 * une traduction partielle qu'il complète, au lieu d'un refus qui ne lui dit
 * pas quoi couper.
 */
function normalizeSource(raw) {
  const texte = String(raw ?? '').trim();
  if (!texte) {
    throw httpError('Rien à traduire : le texte source est vide', 400);
  }
  return texte.slice(0, SOURCE_MAX);
}

/**
 * Langues à produire, ou lève.
 *
 * Sans liste explicite : toutes les langues supportées sauf la source. C'est
 * le cas courant — l'administrateur écrit le français et veut le reste.
 * La langue source est toujours écartée du résultat, même demandée : renvoyer
 * une « traduction » du français vers le français écraserait la saisie
 * d'origine par une paraphrase.
 */
function normalizeTargets(raw, sourceLocale) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
    return SUPPORTED_CONTENT_LOCALES.filter((l) => l !== sourceLocale);
  }
  if (!Array.isArray(raw)) {
    throw httpError('Langues cibles invalides', 400);
  }

  const cibles = [];
  for (const brut of raw) {
    const locale = supportedLocale(brut);
    if (!locale) {
      throw httpError(`Langue non supportée : ${String(brut).slice(0, 16)}`, 400);
    }
    if (locale !== sourceLocale && !cibles.includes(locale)) cibles.push(locale);
  }
  if (cibles.length === 0) {
    throw httpError('Aucune langue cible en dehors de la langue source', 400);
  }
  return cibles;
}

/** Langue de départ, ou lève. */
function normalizeSourceLocale(raw) {
  const locale = supportedLocale(raw ?? 'fr');
  if (!locale) throw httpError('Langue source non supportée', 400);
  return locale;
}

/**
 * Retient du retour du modèle ce qui est exploitable, et rien de plus.
 *
 * Un modèle peut inventer une langue, renvoyer un objet là où un texte est
 * attendu, ou rendre une chaîne vide. Chacun de ces cas doit produire une
 * langue *manquante* — que l'éditeur signalera comme il signale déjà une
 * traduction absente — et non une valeur bancale écrite dans le brouillon.
 *
 * @returns {{translations: Record<string,string>, missing: string[]}}
 */
function sanitizeTranslations(raw, targets) {
  const translations = {};
  const missing = [];

  for (const locale of targets) {
    const valeur = raw?.[locale];
    if (typeof valeur === 'string' && valeur.trim()) {
      translations[locale] = valeur.trim();
    } else {
      missing.push(locale);
    }
  }
  return { translations, missing };
}

/** La consigne système, identique pour toutes les demandes d'une même nature. */
function buildTranslateSystem(kind) {
  const { label, guidance } = KINDS[kind];
  return `Tu traduis le contenu officiel d'Alanya, une messagerie mobile.

Le texte est ${label}.
${guidance}
${FORM_RULES}

Réponds par un objet JSON et rien d'autre, de la forme :
{"translations": {"<code langue>": "<traduction>"}, "notes": ["<remarque courte>"]}

"notes" est facultatif et sert aux seuls avertissements utiles à un relecteur
(ambiguïté du français, longueur qui dépassera sur un bouton, terme laissé tel
quel). Pas de note pour dire que tout va bien.`;
}

/**
 * Traduit un contenu officiel.
 *
 * @param {{content: string, sourceLocale?: string, targets?: string[], kind: string}} params
 * @returns {Promise<{translations: Record<string,string>, missing: string[], notes: string[], model: string}>}
 */
async function translateContent(params) {
  const kind = normalizeKind(params?.kind);
  const sourceLocale = normalizeSourceLocale(params?.sourceLocale);
  const content = normalizeSource(params?.content);
  const targets = normalizeTargets(params?.targets, sourceLocale);

  const cibles = targets.map((l) => `${l} (${LOCALE_NAMES[l] || l})`).join(', ');
  const payload = await chatJson({
    system: buildTranslateSystem(kind),
    user: `Langue source : ${sourceLocale} (${LOCALE_NAMES[sourceLocale] || sourceLocale}).
Langues à produire : ${cibles}.

Texte source :
"""
${content}
"""`,
    // De quoi loger trois traductions d'un bloc long sans jamais couper au
    // milieu d'une phrase, ce qui produirait un JSON tronqué donc illisible.
    maxTokens: 3_000,
    // Une traduction n'a pas à être créative ; deux appels sur le même texte
    // doivent donner à peu près la même chose.
    temperature: 0.2,
  });

  const { translations, missing } = sanitizeTranslations(payload?.translations, targets);
  const notes = Array.isArray(payload?.notes)
    ? payload.notes.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 300))
    : [];

  return { translations, missing, notes, model: currentModel() };
}

/* ── Relecture ───────────────────────────────────────────────────────────── */

const SEVERITIES = ['bloquant', 'attention', 'suggestion'];

function buildReviewSystem(kind) {
  const { label, guidance } = KINDS[kind];
  return `Tu relis le contenu officiel d'Alanya, une messagerie mobile, avant publication.

Le texte est ${label}.
${guidance}

Tu cherches, dans chaque langue fournie :
- les fautes de langue et de typographie ;
- les écarts de sens entre les versions — c'est le plus important, une
  traduction qui dit autre chose que le français est un incident ;
- le balisage cassé : un marqueur *_~=# ouvert et jamais refermé, ou refermé
  autour d'une autre portion que dans la source ;
- le ton qui s'écarte de la consigne ci-dessus ;
- la longueur qui dépassera à l'affichage.

Tu ne réécris pas le texte. Tu signales, brièvement, en français.

Réponds par un objet JSON et rien d'autre, de la forme :
{"findings": [{"locale": "<code langue>", "severity": "bloquant|attention|suggestion", "message": "<une phrase>"}]}

"findings" vide quand il n'y a rien à dire — c'est un résultat, pas un échec.
"bloquant" est réservé à ce qui ne doit pas partir en l'état : contresens,
balisage cassé, faute dans la première phrase.`;
}

/**
 * Relit un contenu déjà traduit.
 *
 * @param {{translations: Record<string,string>, kind: string}} params
 * @returns {Promise<{findings: Array<{locale: string, severity: string, message: string}>, model: string}>}
 */
async function reviewContent(params) {
  const kind = normalizeKind(params?.kind);
  const brut = params?.translations;
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) {
    throw httpError('Traductions attendues sous forme d\'objet', 400);
  }

  const versions = {};
  for (const [cle, valeur] of Object.entries(brut)) {
    const locale = supportedLocale(cle);
    if (locale && typeof valeur === 'string' && valeur.trim()) {
      versions[locale] = valeur.trim().slice(0, SOURCE_MAX);
    }
  }
  if (Object.keys(versions).length === 0) {
    throw httpError('Rien à relire : aucune version renseignée', 400);
  }

  const corps = Object.entries(versions)
    .map(([l, texte]) => `[${l} — ${LOCALE_NAMES[l] || l}]\n${texte}`)
    .join('\n\n');

  const payload = await chatJson({
    system: buildReviewSystem(kind),
    user: `Versions à relire :\n\n${corps}`,
    maxTokens: 1_500,
    temperature: 0.1,
  });

  const findings = Array.isArray(payload?.findings)
    ? payload.findings
        .map((f) => ({
          locale: supportedLocale(f?.locale),
          severity: SEVERITIES.includes(String(f?.severity || '').toLowerCase())
            ? String(f.severity).toLowerCase()
            : 'suggestion',
          message: typeof f?.message === 'string' ? f.message.trim().slice(0, 300) : '',
        }))
        // Une remarque sans langue reconnue ou sans texte ne s'affiche nulle
        // part : la garder ferait un compteur qui ne correspond à rien.
        .filter((f) => f.locale && f.message)
    : [];

  return { findings, model: currentModel() };
}

module.exports = {
  translateContent,
  reviewContent,
  isConfigured,
  // Exportés pour les tests — ce sont eux qui portent les invariants.
  normalizeKind,
  normalizeSource,
  normalizeTargets,
  normalizeSourceLocale,
  sanitizeTranslations,
  KINDS,
  SOURCE_MAX,
  PUSH_BODY_MAX,
};
