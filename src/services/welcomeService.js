const pool = require('../config/db');
const { getOfficialAccountId } = require('../utils/officialAccountGuard');
const { ensureDirectConversation, writeContentI18n } = require('./broadcastService');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { notifyNewMessage } = require('./notificationService');
const { enqueue } = require('./jobQueue');

const {
  SUPPORTED_CONTENT_LOCALES,
  normalizeLocale,
  resolveI18n,
  pickLocalized,
  untranslatedRequiredLocales,
} = require('../utils/localeContent');

const WELCOME_CTA_MSG_TYPE = 8;
const BACKFILL_BATCH = 100;

/** `statut.text` est un TINYTEXT : 255 octets, pas 255 caractères. */
const STATUS_TEXT_MAX = 200;

/** Durée de vie d'un statut, alignée sur `statutController.createStatus`. */
const STATUS_TTL_HOURS = 24;

function mapBlockRow(row) {
  let ctaJson = row.cta_json;
  if (typeof ctaJson === 'string') {
    try { ctaJson = JSON.parse(ctaJson); } catch (_) { ctaJson = null; }
  }
  return {
    id: row.id,
    sortOrder: row.sort_order,
    blockType: row.block_type,
    contentFr: row.content_fr ?? '',
    contentEn: row.content_en ?? '',
    mediaUrl: row.media_url ?? '',
    ctaJson,
  };
}

function mapConfigRow(row, blocks = []) {
  return {
    id: row.id,
    version: row.version,
    isActive: !!row.is_active,
    isDraft: !!row.is_draft,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    blocks,
  };
}

/**
 * Écrit les traductions d'un bloc de bienvenue.
 *
 * **Toujours appelé avec l'`insertId` du bloc qui vient d'être inséré.** Les
 * lignes de `welcome_block_i18n` sont clées sur `block_id`, et `publishDraft`
 * recopie les blocs deux fois en leur donnant à chaque passage de nouveaux
 * identifiants : réutiliser l'ancien laisserait les traductions accrochées à
 * des blocs supprimés et les nouveaux muets. La panne serait silencieuse —
 * c'est exactement ainsi que `cta_json` avait été cassé (migrations 042/046).
 *
 * `field` vaut `content` pour le corps, `cta.<index>` pour le libellé du
 * bouton d'indice `<index>`. Un seul endroit connaît cette convention.
 *
 * Sans effet si la table n'existe pas encore (migration 053 non appliquée) :
 * le contenu reste lisible via `content_fr`/`content_en`, toujours écrites en
 * parallèle.
 */
/**
 * Construit les lignes `(locale, field, value)` des traductions d'un bloc.
 *
 * Pure et exportée pour être testable sans base : c'est la logique dont dépend
 * la survie des traductions à travers les recopies de blocs.
 *
 * Trois provenances, par ordre de priorité :
 *   1. `translations` / `ctaTranslations` — le bloc arrive de l'éditeur ;
 *   2. `i18n` — le bloc a été relu en base et on le recopie : c'est ce cas qui
 *      transporte les traductions d'un identifiant de bloc au suivant ;
 *   3. colonnes héritées `contentFr`/`contentEn` et libellés de `cta_json` —
 *      contenu antérieur à la migration 053.
 *
 * `field` vaut `content` pour le corps, `cta.<index>` pour le libellé du bouton
 * d'indice `<index>`. Un seul endroit connaît cette convention.
 */
function buildBlockI18nRows(block) {
  if (!block) return [];

  const rows = [];
  const seen = new Set();

  /**
   * Traductions que l'éditeur a explicitement vidées : aucune provenance
   * ultérieure ne peut les repeupler. Sans cette mémoire, effacer un texte dans
   * l'administration restait sans effet — la valeur vide était ignorée et
   * l'ancienne traduction, relue en base ou dans la colonne héritée, revenait à
   * l'enregistrement suivant.
   */
  const cleared = new Set();

  const push = (locale, field, value) => {
    if (locale == null) return;
    const key = `${locale}|${field}`;
    if (seen.has(key) || cleared.has(key)) return;
    if (value == null || String(value).trim() === '') return;
    seen.add(key);
    rows.push([locale, field, String(value)]);
  };

  /**
   * Saisie de l'éditeur : une valeur vide vaut suppression, une valeur pleine
   * vaut écriture. Seule cette provenance a ce pouvoir — une clé *absente*
   * reste une absence d'information, qui laisse jouer les provenances
   * suivantes.
   */
  const pushFromEditor = (source, locale, field) => {
    if (!source || !Object.prototype.hasOwnProperty.call(source, locale)) return;
    const value = source[locale];
    if (value == null || String(value).trim() === '') {
      cleared.add(`${locale}|${field}`);
      return;
    }
    push(locale, field, value);
  };

  const translations = block.translations;
  for (const locale of SUPPORTED_CONTENT_LOCALES) {
    pushFromEditor(translations, locale, 'content');
  }

  for (const row of block.i18n || []) {
    push(row.locale, row.field || 'content', row.value);
  }

  push('fr', 'content', block.contentFr);
  push('en', 'content', block.contentEn);

  const buttons = block.ctaJson?.buttons ?? [];
  const ctaTranslations = block.ctaTranslations || [];
  buttons.forEach((btn, index) => {
    const perLocale = ctaTranslations[index];
    for (const locale of SUPPORTED_CONTENT_LOCALES) {
      pushFromEditor(perLocale, locale, `cta.${index}`);
    }
    push('fr', `cta.${index}`, btn.labelFr);
    push('en', `cta.${index}`, btn.labelEn);
  });

  // Un `cta.<n>` au-delà du dernier bouton est le reliquat d'un bouton
  // supprimé, arrivé ici par `block.i18n` : le recopier de configuration en
  // configuration le ferait ressurgir le jour où un bouton reprend cet indice.
  //
  // Filtre suspendu quand le bloc ne porte aucun bouton : `mapBlockRow` met
  // `ctaJson` à null si le JSON est illisible, et ce nettoyage effacerait alors
  // définitivement des libellés parfaitement valides.
  if (!buttons.length) return rows;
  return rows.filter(([, field]) => {
    const m = /^cta\.(\d+)$/.exec(field);
    return !m || Number(m[1]) < buttons.length;
  });
}

/**
 * Reconstruit la forme éditeur des traductions d'un bloc : `translations` pour
 * le corps, `ctaTranslations` pour les libellés de boutons (un objet par
 * bouton, dans l'ordre du tableau).
 *
 * `welcome_block_i18n` fait foi ; les colonnes héritées `content_fr`/
 * `content_en` et les `labelFr`/`labelEn` de `cta_json` ne servent que de repli,
 * locale par locale, pour les blocs antérieurs à la migration 053.
 *
 * Sans cette reconstruction, l'API ne renvoyait que la forme héritée alors que
 * l'éditeur d'administration lit `translations` : les champs s'ouvraient vides
 * sur un contenu pourtant intact en base, pendant que l'aperçu — resté sur les
 * colonnes héritées — affichait le texte. C'est ce désaccord qui rendait la
 * panne illisible.
 */
function attachBlockTranslations(block) {
  const translations = {};
  const ctaTranslations = (block.ctaJson?.buttons ?? []).map(() => ({}));

  for (const row of block.i18n || []) {
    // `normalizeLocale` replierait une locale inconnue sur `fr` et écraserait
    // le français : ici on l'écarte.
    const locale = String(row.locale || '').toLowerCase().split(/[-_]/)[0];
    if (!SUPPORTED_CONTENT_LOCALES.includes(locale)) continue;
    if (row.value == null || String(row.value).trim() === '') continue;

    const field = row.field || 'content';
    if (field === 'content') {
      translations[locale] = String(row.value);
      continue;
    }
    const m = /^cta\.(\d+)$/.exec(field);
    // Un `cta.<n>` sans bouton correspondant est le reliquat d'un bouton
    // supprimé : il ne doit pas ressusciter dans l'éditeur.
    if (m && ctaTranslations[Number(m[1])]) {
      ctaTranslations[Number(m[1])][locale] = String(row.value);
    }
  }

  if (translations.fr == null && String(block.contentFr || '').trim()) {
    translations.fr = String(block.contentFr);
  }
  if (translations.en == null && String(block.contentEn || '').trim()) {
    translations.en = String(block.contentEn);
  }
  (block.ctaJson?.buttons ?? []).forEach((btn, index) => {
    const perLocale = ctaTranslations[index];
    if (perLocale.fr == null && String(btn.labelFr || '').trim()) {
      perLocale.fr = String(btn.labelFr);
    }
    if (perLocale.en == null && String(btn.labelEn || '').trim()) {
      perLocale.en = String(btn.labelEn);
    }
  });

  block.translations = translations;
  block.ctaTranslations = ctaTranslations;
  return block;
}

/**
 * Valeurs des colonnes héritées `content_fr`/`content_en`, dérivées de ce qui
 * vient d'être décidé pour `welcome_block_i18n`.
 *
 * Les deux écritures partent ainsi de la même source. Recopier le `contentFr`
 * reçu de l'éditeur laissait la colonne sur l'ancien texte pendant que la table
 * normalisée recevait le nouveau : l'aperçu d'administration et la livraison
 * cessaient alors de montrer la même chose.
 *
 * À supprimer avec les colonnes (migration 054).
 */
function legacyContentColumns(block) {
  const rows = buildBlockI18nRows(block);
  const pick = (locale) => {
    const hit = rows.find(([l, field]) => l === locale && field === 'content');
    return hit ? hit[2] : '';
  };
  return [pick('fr'), pick('en')];
}

/**
 * Écrit les traductions d'un bloc de bienvenue.
 *
 * **Toujours appelé avec l'`insertId` du bloc qui vient d'être inséré.** Les
 * lignes de `welcome_block_i18n` sont clées sur `block_id`, et une
 * configuration de bienvenue recopie ses blocs à chaque changement d'état
 * (`ensureDraftConfig`, `saveDraft`, et deux fois dans `publishDraft`), avec de
 * nouveaux identifiants à chaque passage. Réutiliser l'ancien laisserait les
 * traductions accrochées à des blocs supprimés et les nouveaux muets — panne
 * silencieuse, exactement ainsi que `cta_json` avait été cassé (042/046).
 *
 * Sans effet si la table n'existe pas encore (migration 053 non appliquée) :
 * le contenu reste lisible via `content_fr`/`content_en`, toujours écrites en
 * parallèle.
 */
async function writeBlockI18n(conn, blockId, block) {
  if (!blockId) return;
  const rows = buildBlockI18nRows(block);
  if (rows.length === 0) return;

  try {
    for (const [locale, field, value] of rows) {
      await conn.execute(
        `INSERT INTO welcome_block_i18n (block_id, locale, field, value)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [blockId, locale, field, value],
      );
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

async function loadBlocksForConfig(configId, conn = pool) {
  const [rows] = await conn.execute(
    'SELECT * FROM welcome_block WHERE config_id = ? ORDER BY sort_order ASC, id ASC',
    [configId],
  );
  const blocks = rows.map(mapBlockRow);

  // Traductions de tous les blocs en une requête. Vide tant que la migration
  // 053 n'est pas passée : `blockToMessagePayload` retombe alors sur
  // `content_fr`/`content_en` et sur les `labelFr`/`labelEn` de `cta_json`.
  if (blocks.length) {
    try {
      const ids = blocks.map((b) => b.id);
      const [i18nRows] = await conn.query(
        'SELECT block_id, locale, field, value FROM welcome_block_i18n WHERE block_id IN (?)',
        [ids],
      );
      const byBlock = new Map();
      for (const r of i18nRows) {
        const list = byBlock.get(r.block_id) || [];
        list.push(r);
        byBlock.set(r.block_id, list);
      }
      for (const b of blocks) {
        b.i18n = byBlock.get(b.id) || [];
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      for (const b of blocks) b.i18n = [];
    }
  }

  // `i18n` reste la forme brute que consomment la livraison et la recopie des
  // blocs ; `translations` en est la vue par locale, seule forme que lit
  // l'éditeur d'administration. Les deux sont toujours renvoyées ensemble.
  for (const b of blocks) attachBlockTranslations(b);

  return blocks;
}

async function getActiveConfig() {
  const [rows] = await pool.execute(
    'SELECT * FROM welcome_config WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
  );
  if (!rows.length) return null;
  const blocks = await loadBlocksForConfig(rows[0].id);
  return mapConfigRow(rows[0], blocks);
}

async function getDraftConfig(conn = pool) {
  const [rows] = await conn.execute(
    'SELECT * FROM welcome_config WHERE is_draft = 1 ORDER BY id DESC LIMIT 1',
  );
  if (!rows.length) return null;
  const blocks = await loadBlocksForConfig(rows[0].id, conn);
  return mapConfigRow(rows[0], blocks);
}

async function ensureDraftConfig(conn) {
  let draft = await getDraftConfig(conn);
  if (draft) return draft;

  const active = await getActiveConfig();
  const [ins] = await conn.execute(
    'INSERT INTO welcome_config (version, is_active, is_draft) VALUES (?, 0, 1)',
    [active?.version ?? 1],
  );
  const draftId = ins.insertId;

  if (active?.blocks?.length) {
    for (const b of active.blocks) {
      const [contentFr, contentEn] = legacyContentColumns(b);
      const [blockIns] = await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draftId,
          b.sortOrder,
          b.blockType,
          contentFr,
          contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
      // Nouveau bloc, donc nouvel identifiant : les traductions relues sur
      // l'actif (`b.i18n`) sont recopiées sur celui-ci.
      await writeBlockI18n(conn, blockIns.insertId, b);
    }
  }

  const [rows] = await conn.execute('SELECT * FROM welcome_config WHERE id = ?', [draftId]);
  const blocks = await loadBlocksForConfig(draftId, conn);
  return mapConfigRow(rows[0], blocks);
}

async function getAdminWelcomeState() {
  const [active, draft] = await Promise.all([getActiveConfig(), getDraftConfig()]);
  return { active, draft: draft ?? active };
}

function blockToMessagePayload(block, locale, configId, alanyaID, sortOrder) {
  const clientId = `welcome:${configId}:${alanyaID}:${sortOrder}`;

  // Table normalisée d'abord, colonnes héritées ensuite, le temps de la
  // double écriture.
  const body = () =>
    resolveI18n(block.i18n, locale, { valueKey: 'value', field: 'content' }) ??
    pickLocalized(block, locale, 'content');

  switch (block.blockType) {
    case 'text': {
      return { type: 0, content: body(), mediaUrl: null, clientId };
    }
    case 'image':
      return {
        type: 1,
        content: body() || null,
        mediaUrl: block.mediaUrl || null,
        clientId,
      };
    case 'video':
      return {
        type: 2,
        content: body() || null,
        mediaUrl: block.mediaUrl || null,
        clientId,
      };
    case 'cta': {
      const raw = block.ctaJson?.buttons ?? [];
      // Les libellés vivent désormais dans `welcome_block_i18n`, indexés par la
      // position du bouton (`cta.0`, `cta.1`…). `cta_json` ne garde que la
      // structure : action et cible. Le repli sur `labelFr`/`labelEn` couvre
      // les configurations antérieures à la migration 053 — c'est ce JSON qui
      // avait déjà été cassé une fois (migrations 042 puis 046), on ne le
      // réécrit pas.
      const buttons = raw.map((btn, index) => ({
        label:
          resolveI18n(block.i18n, locale, {
            valueKey: 'value',
            field: `cta.${index}`,
          }) ??
          (normalizeLocale(locale) !== 'fr'
            ? (btn.labelEn || btn.labelFr || '')
            : (btn.labelFr || btn.labelEn || '')),
        action: btn.action === 'url' ? 'url' : 'route',
        target: String(btn.target || ''),
      })).filter((b) => b.label && b.target);
      return {
        type: WELCOME_CTA_MSG_TYPE,
        content: JSON.stringify({ buttons }),
        mediaUrl: null,
        clientId,
      };
    }
    default:
      return null;
  }
}

/* ── Statut de bienvenue ──────────────────────────────────────────────────
 *
 * Réglage global et non versionné : l'interrupteur agit sans passer par
 * « Publier », contrairement au message. Voir migrations/044_welcome_status.sql.
 */

function mapStatusConfigRow(row) {
  return {
    enabled: !!row.enabled,
    type: Number(row.type) || 0,
    textFr: row.text_fr ?? '',
    textEn: row.text_en ?? '',
    mediaUrl: row.media_url ?? '',
    backgroundColor: row.background_color ?? '',
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

async function getWelcomeStatusConfig() {
  const [[row]] = await pool.execute(
    'SELECT * FROM welcome_status_config WHERE id = 1',
  );
  if (!row) {
    return {
      enabled: false, type: 0, textFr: '', textEn: '', translations: {},
      mediaUrl: '', backgroundColor: '', updatedAt: null, updatedBy: null,
    };
  }

  // Traductions normalisées. Vides tant que la migration 053 n'est pas passée :
  // `text_fr`/`text_en` prennent alors le relais.
  const translations = {};
  try {
    const [rows] = await pool.execute(
      'SELECT locale, text FROM welcome_status_config_i18n WHERE config_id = 1',
    );
    for (const r of rows) translations[normalizeLocale(r.locale)] = r.text;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }

  return { ...mapStatusConfigRow(row), translations };
}

/** Couleur de fond acceptée par l'app : `#RRGGBB` (cf. `_parseColor`). */
function normalizeBackgroundColor(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const hex = v.startsWith('#') ? v.slice(1) : v;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    const err = new Error('Couleur de fond invalide (#RRGGBB attendu)');
    err.status = 400;
    throw err;
  }
  return `#${hex.toUpperCase()}`;
}

function normalizeStatusText(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (v.length > STATUS_TEXT_MAX) {
    const err = new Error(`Texte du statut limité à ${STATUS_TEXT_MAX} caractères`);
    err.status = 400;
    throw err;
  }
  return v;
}

async function saveWelcomeStatusConfig(patch, adminId) {
  const type = [0, 1, 2].includes(Number(patch?.type)) ? Number(patch.type) : 0;
  // Les colonnes héritées restent la source du français et de l'anglais tant
  // qu'elles existent : on les dérive des traductions plutôt que d'exiger des
  // appelants qu'ils envoient les deux formes.
  const incoming = patch?.translations || {};
  const textFr = normalizeStatusText(incoming.fr ?? patch?.textFr);
  const textEn = normalizeStatusText(incoming.en ?? patch?.textEn);
  const mediaUrl = patch?.mediaUrl ? String(patch.mediaUrl).slice(0, 512) : null;
  const backgroundColor = normalizeBackgroundColor(patch?.backgroundColor);
  const enabled = patch?.enabled ? 1 : 0;

  // Activer sans contenu livrable produirait des statuts vides : on refuse ici
  // plutôt que de laisser passer et d'échouer silencieusement à la livraison.
  if (enabled) {
    if (type === 0 && !textFr) {
      const err = new Error('Un statut texte exige un texte en français');
      err.status = 400;
      throw err;
    }
    // Contrairement au message, le statut conserve les deux langues et l'app
    // choisit à l'affichage : sans texte anglais, l'anglophone voit du français.
    if (textFr && !textEn) {
      const err = new Error('Un statut texte exige aussi sa traduction anglaise');
      err.status = 400;
      throw err;
    }
    if (type !== 0 && !mediaUrl) {
      const err = new Error('Un statut image ou vidéo exige un média');
      err.status = 400;
      throw err;
    }
  }

  await pool.execute(
    `INSERT INTO welcome_status_config
       (id, enabled, type, text_fr, text_en, media_url, background_color, updated_by)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled), type = VALUES(type),
       text_fr = VALUES(text_fr), text_en = VALUES(text_en),
       media_url = VALUES(media_url), background_color = VALUES(background_color),
       updated_by = VALUES(updated_by)`,
    [enabled, type, textFr || null, textEn || null, mediaUrl, backgroundColor, adminId ?? null],
  );

  const translations = { ...incoming, fr: textFr, en: textEn };
  try {
    for (const locale of SUPPORTED_CONTENT_LOCALES) {
      const value = normalizeStatusText(translations[locale]);
      if (value) {
        await pool.execute(
          `INSERT INTO welcome_status_config_i18n (config_id, locale, text)
           VALUES (1, ?, ?)
           ON DUPLICATE KEY UPDATE text = VALUES(text)`,
          [locale, value],
        );
      } else {
        // Une traduction effacée doit disparaître, sinon l'ancienne valeur
        // resterait servie alors que l'administrateur l'a retirée.
        await pool.execute(
          'DELETE FROM welcome_status_config_i18n WHERE config_id = 1 AND locale = ?',
          [locale],
        );
      }
    }
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }

  return getWelcomeStatusConfig();
}

/**
 * Publie le statut de bienvenue pour un utilisateur.
 *
 * Volontairement indépendant du message : le statut part même si aucune version
 * du message n'est active, et une erreur ici ne doit jamais faire échouer la fin
 * d'onboarding. La ligne `welcome_status_delivery` sert à la fois de clé de
 * visibilité et de garde anti-doublon (`alanyaID` UNIQUE).
 */
async function deliverWelcomeStatus(alanyaID) {
  const config = await getWelcomeStatusConfig();
  if (!config.enabled) return { delivered: false, reason: 'DISABLED' };

  const hasContent = config.type === 0 ? !!config.textFr : !!config.mediaUrl;
  if (!hasContent) return { delivered: false, reason: 'EMPTY_STATUS' };

  const officialId = await getOfficialAccountId();
  if (!officialId) return { delivered: false, reason: 'NO_OFFICIAL_ACCOUNT' };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[dup]] = await conn.execute(
      'SELECT statut_id FROM welcome_status_delivery WHERE alanyaID = ? FOR UPDATE',
      [alanyaID],
    );
    if (dup) {
      await conn.commit();
      return { delivered: false, reason: 'ALREADY_DELIVERED', statutId: dup.statut_id };
    }

    const [ins] = await conn.execute(
      `INSERT INTO statut
         (alanyaID, type, text, text_en, mediaUrl, backgroundColor,
          createdAt, expiredAt, viewedBy, likedBy)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), 0, 0)`,
      [
        officialId,
        config.type,
        config.textFr || '',
        config.textEn || null,
        config.mediaUrl || null,
        config.backgroundColor || null,
        STATUS_TTL_HOURS,
      ],
    );
    // Le statut livré porte les mêmes traductions que la configuration :
    // sans cela, un lecteur chinois verrait l'anglais alors que la version
    // chinoise existe.
    await writeContentI18n(conn, 'statut', ins.insertId, config.translations);

    await conn.execute(
      'INSERT INTO welcome_status_delivery (alanyaID, statut_id) VALUES (?, ?)',
      [alanyaID, ins.insertId],
    );

    await conn.commit();
    return { delivered: true, statutId: ins.insertId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Purge les statuts de bienvenue expirés.
 *
 * Sans elle, `statut` grossirait d'une ligne par inscription, indéfiniment :
 * l'app cesse de les afficher après 24 h mais rien ne les supprimait.
 * La suppression en cascade nettoie `welcome_status_delivery`.
 */
async function purgeExpiredWelcomeStatuses({ retentionDays = 7 } = {}) {
  const [res] = await pool.execute(
    `DELETE s FROM statut s
     JOIN welcome_status_delivery w ON w.statut_id = s.ID
     WHERE s.expiredAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [retentionDays],
  );
  return { purged: res.affectedRows || 0 };
}

async function deliverWelcome(alanyaID, { locale = 'fr' } = {}) {
  const loc = normalizeLocale(locale);

  // Le statut n'est publié que lors de la PREMIÈRE livraison du message, plus
  // bas. Cet endpoint est rappelé à chaque lancement de l'app en rattrapage
  // (home_screen.dart) : le tenter ici enverrait le statut à tous les comptes
  // existants dès l'activation de l'interrupteur, alors qu'il est réservé aux
  // nouveaux inscrits.
  let welcomeStatus = { delivered: false, reason: 'NOT_A_NEW_SIGNUP' };

  const [[delivery]] = await pool.execute(
    'SELECT conversID, config_id FROM welcome_delivery WHERE alanyaID = ?',
    [alanyaID],
  );

  if (delivery) {
    const officialId = await getOfficialAccountId();
    let officialName = 'Alanya';
    let officialAvatar = '';
    if (officialId) {
      const [[u]] = await pool.execute(
        'SELECT nom, avatar_url AS avatarUrl FROM users WHERE alanyaID = ?',
        [officialId],
      );
      officialName = u?.nom || officialName;
      officialAvatar = u?.avatarUrl || '';
    }
    return {
      delivered: false,
      alreadyDelivered: true,
      conversationId: delivery.conversID,
      configId: delivery.config_id,
      senderId: officialId,
      senderName: officialName,
      senderAvatar: officialAvatar,
      messageCount: 0,
      statusDelivered: welcomeStatus.delivered,
    };
  }

  const config = await getActiveConfig();
  if (!config?.blocks?.length) {
    return {
      delivered: false, skipped: true, reason: 'NO_ACTIVE_CONFIG',
      statusDelivered: welcomeStatus.delivered,
    };
  }

  const officialId = await getOfficialAccountId();
  if (!officialId) {
    return {
      delivered: false, skipped: true, reason: 'NO_OFFICIAL_ACCOUNT',
      statusDelivered: welcomeStatus.delivered,
    };
  }

  const [[officialUser]] = await pool.execute(
    'SELECT nom, avatar_url AS avatarUrl FROM users WHERE alanyaID = ?',
    [officialId],
  );

  const conn = await pool.getConnection();
  let conversID;
  let messageCount = 0;
  let lastPreview = '';
  let lastType = 0;

  try {
    await conn.beginTransaction();

    const [[dup]] = await conn.execute(
      'SELECT conversID, config_id FROM welcome_delivery WHERE alanyaID = ? FOR UPDATE',
      [alanyaID],
    );
    if (dup) {
      await conn.commit();
      return {
        delivered: false,
        alreadyDelivered: true,
        conversationId: dup.conversID,
        configId: dup.config_id,
        senderId: officialId,
        senderName: officialUser?.nom || 'Alanya',
        senderAvatar: officialUser?.avatarUrl || '',
        messageCount: 0,
        statusDelivered: welcomeStatus.delivered,
      };
    }

    conversID = await ensureDirectConversation(conn, officialId, alanyaID);
    const sentAt = new Date();

    for (const block of config.blocks) {
      const payload = blockToMessagePayload(block, loc, config.id, alanyaID, block.sortOrder);
      if (!payload || (payload.type !== 0 && !payload.content && !payload.mediaUrl)) continue;

      await conn.execute(
        `INSERT INTO message
          (senderID, conversationID, content, type, status, sendAt, clientID, mediaUrl)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE msgID = msgID`,
        [
          officialId,
          conversID,
          payload.content,
          payload.type,
          sentAt,
          payload.clientId,
          payload.mediaUrl,
        ],
      );
      messageCount += 1;
      lastPreview = resolveLastMessagePreview({
        content: payload.content,
        type: payload.type,
      });
      lastType = payload.type;
    }

    if (messageCount === 0) {
      await conn.rollback();
      return {
        delivered: false, skipped: true, reason: 'EMPTY_CONFIG',
        statusDelivered: welcomeStatus.delivered,
      };
    }

    await conn.execute(
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = ?, lastMessageSenderID = ?,
           lastMessageType = ?, lastMessageStatus = 1,
           message_count = message_count + ?
       WHERE conversID = ?`,
      [lastPreview, sentAt, officialId, lastType, messageCount, conversID],
    );

    await conn.execute(
      'UPDATE conv_participants SET unreadCount = unreadCount + ? WHERE conversID = ? AND alanyaID = ?',
      [messageCount, conversID, alanyaID],
    );

    await conn.execute(
      'INSERT INTO welcome_delivery (alanyaID, config_id, conversID) VALUES (?, ?, ?)',
      [alanyaID, config.id, conversID],
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // Première livraison confirmée : c'est bien un nouvel inscrit. Le statut vient
  // après la transaction du message pour qu'un échec ici — statut désactivé,
  // média absent, erreur SQL — ne fasse jamais perdre le message déjà écrit.
  try {
    welcomeStatus = await deliverWelcomeStatus(alanyaID);
  } catch (e) {
    console.error('[welcome] échec du statut de bienvenue:', e.message);
    welcomeStatus = { delivered: false, reason: 'ERROR' };
  }

  const lastBody = lastPreview || 'Message de bienvenue';
  await notifyNewMessage(conversID, officialId, officialUser?.nom || 'Alanya', {
    content: lastBody,
    type: lastType,
    msgID: 0,
    clientId: `welcome:${config.id}:${alanyaID}:tail`,
    senderAvatar: officialUser?.avatarUrl || '',
    unreadTotal: messageCount,
  });

  return {
    delivered: true,
    alreadyDelivered: false,
    conversationId: conversID,
    configId: config.id,
    senderId: officialId,
    senderName: officialUser?.nom || 'Alanya',
    senderAvatar: officialUser?.avatarUrl || '',
    messageCount,
    statusDelivered: welcomeStatus.delivered,
  };
}

async function saveDraft(blocks, adminId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const draft = await ensureDraftConfig(conn);

    await conn.execute('DELETE FROM welcome_block WHERE config_id = ?', [draft.id]);

    const sorted = [...(blocks || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    for (let i = 0; i < sorted.length; i += 1) {
      const b = sorted[i];
      const [contentFr, contentEn] = legacyContentColumns(b);
      const [ins] = await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draft.id,
          b.sortOrder ?? i,
          b.blockType,
          contentFr,
          contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
      // Les blocs du brouillon viennent d'être supprimés : leurs lignes i18n
      // sont parties par ON DELETE CASCADE. On réécrit sur le nouvel id.
      await writeBlockI18n(conn, ins.insertId, b);
    }

    await conn.execute('UPDATE welcome_config SET updated_at = NOW() WHERE id = ?', [draft.id]);
    await conn.commit();

    return getDraftConfig();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function publishDraft(adminId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const draft = await ensureDraftConfig(conn);
    const blocks = await loadBlocksForConfig(draft.id, conn);
    if (!blocks.length) {
      const err = new Error('Le brouillon est vide');
      err.status = 400;
      throw err;
    }

    // Les langues requises sont exigées, mais seulement à la publication : un
    // brouillon doit rester enregistrable en cours de rédaction. La traduction
    // n'est due que là où il y a du texte — une légende vide dans toutes les
    // langues est légitime sur un bloc image ou vidéo.
    //
    // Le contrôle porte sur `translations`, forme de référence depuis la 053 :
    // sur `contentFr`/`contentEn`, un bloc créé après la migration présentait
    // des colonnes héritées vides et franchissait le garde sans traduction.
    const untranslated = blocks
      .filter((b) => b.blockType !== 'cta')
      .filter((b) => untranslatedRequiredLocales(b.translations).length)
      .map((b) => b.sortOrder + 1);
    if (untranslated.length) {
      const err = new Error(
        `Traduction manquante — bloc(s) ${untranslated.join(', ')}`,
      );
      err.status = 400;
      throw err;
    }

    // Un bouton dont le libellé manque dans une langue est simplement retiré à
    // la livraison (blockToMessagePayload) : ce lecteur-là verrait un bloc
    // amputé.
    const ctaUntranslated = blocks
      .filter((b) => b.blockType === 'cta')
      .filter((b) => (b.ctaTranslations ?? []).some(
        (perLocale) => untranslatedRequiredLocales(perLocale).length,
      ))
      .map((b) => b.sortOrder + 1);
    if (ctaUntranslated.length) {
      const err = new Error(
        `Libellé de bouton non traduit — bloc(s) ${ctaUntranslated.join(', ')}`,
      );
      err.status = 400;
      throw err;
    }

    const [[maxRow]] = await conn.execute(
      'SELECT COALESCE(MAX(version), 0) AS m FROM welcome_config WHERE is_draft = 0',
    );
    const nextVersion = Number(maxRow.m) + 1;

    await conn.execute('UPDATE welcome_config SET is_active = 0 WHERE is_active = 1');

    const [ins] = await conn.execute(
      `INSERT INTO welcome_config (version, is_active, is_draft, published_at, published_by)
       VALUES (?, 1, 0, NOW(), ?)`,
      [nextVersion, adminId],
    );
    const newId = ins.insertId;

    for (const b of blocks) {
      const [contentFr, contentEn] = legacyContentColumns(b);
      const [ins] = await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId,
          b.sortOrder,
          b.blockType,
          contentFr,
          contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
      // Configuration publiée : nouveaux identifiants de blocs, donc les
      // traductions du brouillon (`b.i18n`) sont réécrites sur eux.
      await writeBlockI18n(conn, ins.insertId, b);
    }

    // Resync draft from published
    await conn.execute('DELETE FROM welcome_block WHERE config_id = ?', [draft.id]);
    const publishedBlocks = await loadBlocksForConfig(newId, conn);
    for (const b of publishedBlocks) {
      const [contentFr, contentEn] = legacyContentColumns(b);
      const [ins] = await conn.execute(
        `INSERT INTO welcome_block
          (config_id, sort_order, block_type, content_fr, content_en, media_url, cta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          draft.id,
          b.sortOrder,
          b.blockType,
          contentFr,
          contentEn,
          b.mediaUrl || null,
          b.ctaJson ? JSON.stringify(b.ctaJson) : null,
        ],
      );
      // Resynchronisation du brouillon sur le publié : troisième jeu
      // d'identifiants, troisième réécriture.
      await writeBlockI18n(conn, ins.insertId, b);
    }
    await conn.execute(
      'UPDATE welcome_config SET version = ? WHERE id = ?',
      [nextVersion, draft.id],
    );

    await conn.commit();
    return getActiveConfig();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function countBackfillCandidates() {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM users u
     WHERE u.exclus = 0 AND u.account_type != 2
       AND NOT EXISTS (SELECT 1 FROM welcome_delivery wd WHERE wd.alanyaID = u.alanyaID)`,
  );
  return Number(row.c) || 0;
}

async function processWelcomeBackfillBatch({ idFrom = 0, limit = BACKFILL_BATCH } = {}) {
  const config = await getActiveConfig();
  if (!config) return { processed: 0, delivered: 0 };

  const [users] = await pool.execute(
    `SELECT u.alanyaID FROM users u
     WHERE u.exclus = 0 AND u.account_type != 2
       AND u.alanyaID > ?
       AND NOT EXISTS (SELECT 1 FROM welcome_delivery wd WHERE wd.alanyaID = u.alanyaID)
     ORDER BY u.alanyaID ASC
     LIMIT ${Number(limit) || BACKFILL_BATCH}`,
    [idFrom],
  );

  let delivered = 0;
  let failed = 0;
  let lastId = idFrom;
  let firstError = null;
  for (const u of users) {
    lastId = Number(u.alanyaID);
    try {
      const r = await deliverWelcome(lastId, { locale: 'fr' });
      if (r.delivered) delivered += 1;
      else if (!r.alreadyDelivered) {
        failed += 1;
        firstError = firstError || r.reason || 'SKIPPED';
      }
    } catch (e) {
      failed += 1;
      firstError = firstError || e.message;
      console.warn('[Welcome] backfill user', lastId, e.message);
    }
  }

  // Une erreur par utilisateur est rattrapée pour ne pas interrompre le lot,
  // mais un lot entièrement en échec se terminait « avec succès » : le job
  // était supprimé, rien n'était livré et l'admin n'en savait rien. On trace
  // au moins un résumé exploitable.
  const level = delivered === 0 && failed > 0 ? 'error' : 'log';
  console[level](
    `[Welcome] rattrapage : ${delivered} livré(s), ${failed} échec(s) sur ${users.length}` +
      (firstError ? ` — première cause : ${firstError}` : ''),
  );

  return {
    processed: users.length,
    delivered,
    failed,
    firstError,
    lastId,
    hasMore: users.length >= limit,
  };
}

async function startBackfill(adminId) {
  void adminId;
  const pending = await countBackfillCandidates();
  if (!pending) return { queued: false, pending: 0, reason: 'NOTHING_TO_DO' };

  // `reviveFailed` : un rattrapage ayant échoué définitivement laissait sa ligne
  // en base et bloquait pour toujours toute nouvelle tentative, en silence.
  const jobId = await enqueue(
    'welcome_backfill',
    { idFrom: 0 },
    { dedupeKey: 'welcome_backfill', reviveFailed: true },
  );

  // `enqueue` renvoie null quand un rattrapage est déjà en attente. L'ignorer
  // faisait annoncer « lancé » alors que rien n'avait été mis en file.
  if (!jobId) return { queued: false, pending, reason: 'ALREADY_RUNNING' };

  return { queued: true, pending };
}

async function continueBackfillChain(lastId, hasMore) {
  if (!hasMore) return;
  await enqueue(
    'welcome_backfill',
    { idFrom: lastId },
    { dedupeKey: `welcome_backfill:${lastId}`, reviveFailed: true },
  );
}

module.exports = {
  buildBlockI18nRows,
  attachBlockTranslations,
  legacyContentColumns,
  WELCOME_CTA_MSG_TYPE,
  getAdminWelcomeState,
  saveDraft,
  publishDraft,
  deliverWelcome,
  countBackfillCandidates,
  processWelcomeBackfillBatch,
  startBackfill,
  continueBackfillChain,
  // Statut de bienvenue (réglage global, non versionné)
  STATUS_TEXT_MAX,
  getWelcomeStatusConfig,
  saveWelcomeStatusConfig,
  deliverWelcomeStatus,
  purgeExpiredWelcomeStatuses,
};
