const fs = require('fs');
const path = require('path');
const { BRAND, LAYOUT } = require('./theme');

const LOGO_PATH = path.join(__dirname, '../../../assets/brand/logo.png');
const APP_NAME = 'Alanya';
const APP_TAGLINE = 'Administration';

function logoExists() {
  try {
    return fs.existsSync(LOGO_PATH);
  } catch {
    return false;
  }
}

function contentBottom(doc) {
  return LAYOUT.pageH - LAYOUT.margin - LAYOUT.footerH;
}

/**
 * Les polices standard (Helvetica) sont encodées en WinAnsi : les glyphes hors
 * de ce jeu sortent en caractères parasites. Deux cas se produisent à chaque
 * export : l'espace fine insécable des milliers de `toLocaleString('fr-FR')`
 * (« 84 000 » rendu « 84 /000 ») et la flèche des libellés de période.
 */
function pdfText(value) {
  return String(value ?? '')
    .replace(/[    ]/g, ' ')
    .replace(/[→➡]/g, '–')
    .replace(/[‑‒]/g, '-');
}

/**
 * Écrit une ligne à une position absolue **sans passer par le moteur de
 * retour à la ligne de pdfkit**.
 *
 * Pourquoi : dès qu'on lui passe une `width`, `doc.text()` instancie un
 * `LineWrapper` dont `wrap()` compare `doc.y` à `page.maxY()` et appelle
 * `continueOnNewPage()` en cas de dépassement. C'est ce qui ajoutait une page
 * vierge par pied de page, celui-ci étant dessiné sous la marge basse.
 * Sans `width`, `_initOptions` laisse `options.width` indéfinie (`lineBreak`
 * valant `false`), `_text` prend sa branche directe et n'atteint jamais la
 * logique de pagination : cette écriture ne peut donc pas créer de page.
 *
 * L'alignement est calculé ici, et `doc.x`/`doc.y` sont restaurés pour ne pas
 * perturber le flux de contenu en cours.
 */
function writeFlatText(doc, text, { x, y, width = 0, align = 'left', characterSpacing = 0 } = {}) {
  const line = pdfText(text).replace(/\s*\n\s*/g, ' ');
  if (!line) return;

  const savedX = doc.x;
  const savedY = doc.y;

  let drawX = x;
  if (width > 0 && align !== 'left') {
    const w = doc.widthOfString(line, { characterSpacing });
    drawX = align === 'right' ? x + width - w : x + (width - w) / 2;
  }

  doc.text(line, drawX, y, { lineBreak: false, characterSpacing });

  doc.x = savedX;
  doc.y = savedY;
}

/**
 * Unique point d'entrée pour ouvrir une page de contenu : garantit que toute
 * page créée reçoit son en-tête et que `doc.y` repart sous celui-ci.
 */
function startContentPage(doc, documentTitle) {
  doc.addPage();
  drawContentPageHeader(doc, documentTitle ?? doc._alanyaDocTitle ?? '');
}

function ensureSpace(doc, needed = 60) {
  if (doc.y + needed > contentBottom(doc)) {
    startContentPage(doc);
  }
}

function drawLogo(doc, x, y, width) {
  if (!logoExists()) return false;
  try {
    doc.image(LOGO_PATH, x, y, { width });
    return true;
  } catch {
    return false;
  }
}

/** Ratio du logo (240 × 160). */
const LOGO_RATIO = 160 / 240;

/**
 * Page de garde : bandeau indigo dégradé souligné d'or portant l'identité et
 * le titre, puis carte des métadonnées et mention de confidentialité.
 *
 * Le bandeau est mesuré avant d'être peint (il doit être dessiné sous les
 * textes qu'il porte) et s'étire si le titre passe sur plusieurs lignes.
 */
function drawCoverPage(doc, {
  documentTitle,
  documentSubtitle,
  metaRows = [],
  badge,
}) {
  const { margin, pageW, pageH, contentW } = LAYOUT;

  const chipSize = 62;
  const headerTop = 46;
  const titleTop = headerTop + chipSize + 48;
  const titleW = contentW * 0.86;
  const subtitleW = contentW * 0.8;

  // — Mesures —
  doc.font('Helvetica-Bold').fontSize(29);
  const title = pdfText(documentTitle);
  const subtitle = documentSubtitle ? pdfText(documentSubtitle) : '';
  const titleH = doc.heightOfString(title, { width: titleW, lineGap: 2 });

  let subtitleH = 0;
  if (documentSubtitle) {
    doc.font('Helvetica').fontSize(11.5);
    subtitleH = doc.heightOfString(subtitle, { width: subtitleW });
  }

  const bandH = Math.round(Math.max(
    LAYOUT.coverBandMinH,
    titleTop + titleH + (subtitleH ? subtitleH + 10 : 0) + (badge ? 40 : 0) + 44,
  ));

  // — Bandeau —
  doc.save();
  const band = doc.linearGradient(0, 0, pageW, bandH);
  band.stop(0, BRAND.primary).stop(1, BRAND.primaryDark);
  doc.rect(0, 0, pageW, bandH).fill(band);

  // Halos très discrets, pour éviter l'aplat plat.
  doc.fillOpacity(0.06);
  doc.circle(pageW - 48, 36, 150).fill(BRAND.onPrimary);
  doc.circle(pageW - 140, bandH + 20, 90).fill(BRAND.onPrimary);
  doc.fillOpacity(1);

  doc.rect(0, bandH - 3, pageW, 3).fill(BRAND.gold);
  doc.restore();

  // — Identité : pastille blanche + nom —
  doc.save();
  doc.roundedRect(margin, headerTop, chipSize, chipSize, 14).fill(BRAND.surface);
  doc.restore();

  const logoW = chipSize - 18;
  if (!drawLogo(doc, margin + 9, headerTop + (chipSize - logoW * LOGO_RATIO) / 2, logoW)) {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(BRAND.primaryDark)
      .text('A', margin, headerTop + 20, { width: chipSize, align: 'center', lineBreak: false });
  }

  const identityX = margin + chipSize + 18;
  doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND.onPrimary)
    .text(APP_NAME.toUpperCase(), identityX, headerTop + 13, { characterSpacing: 2.6, lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(BRAND.onPrimaryMuted)
    .text(APP_TAGLINE.toUpperCase(), identityX + 2, headerTop + 39, { characterSpacing: 2.2, lineBreak: false });

  doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.onPrimaryMuted)
    .text('RAPPORT ADMINISTRATIF', margin, headerTop + 18, {
      width: contentW,
      align: 'right',
      characterSpacing: 1.8,
      lineBreak: false,
    });

  // — Titre du document —
  doc.save();
  doc.rect(margin, titleTop - 24, 46, 3).fill(BRAND.gold);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(29).fillColor(BRAND.onPrimary)
    .text(title, margin, titleTop, { width: titleW, lineGap: 2 });
  let y = doc.y;

  if (documentSubtitle) {
    doc.font('Helvetica').fontSize(11.5).fillColor(BRAND.onPrimaryMuted)
      .text(subtitle, margin, y + 8, { width: subtitleW });
    y = doc.y;
  }

  if (badge) {
    doc.font('Helvetica-Bold').fontSize(8.5);
    const badgeLabel = pdfText(badge);
    const badgeW = Math.min(doc.widthOfString(badgeLabel, { characterSpacing: 1.2 }) + 30, contentW);
    doc.save();
    doc.fillOpacity(0.18).roundedRect(margin, y + 14, badgeW, 22, 11).fill(BRAND.onPrimary);
    doc.restore();
    doc.fillColor(BRAND.onPrimary)
      .text(badgeLabel, margin, y + 20, {
        width: badgeW,
        align: 'center',
        characterSpacing: 1.2,
        lineBreak: false,
      });
  }

  // — Carte des métadonnées —
  const cardX = margin;
  const cardW = contentW;
  const cardPad = 26;
  const labelW = 148;
  const valueX = cardX + cardPad + labelW + 16;
  const valueW = cardW - cardPad * 2 - labelW - 16;
  const stripH = 36;

  doc.font('Helvetica').fontSize(10);
  const rows = metaRows.map(([label, value]) => {
    const text = pdfText(value ?? '—');
    return {
      label: pdfText(label).toUpperCase(),
      value: text,
      h: Math.max(18, doc.heightOfString(text, { width: valueW })) + 14,
    };
  });

  // La carte ne doit jamais mordre sur la mention de confidentialité : on la
  // remonte, puis on tronque, si les métadonnées sont exceptionnellement longues.
  const noteY = pageH - margin - 56;
  const cardYPref = bandH + 46;
  const cardYMin = bandH + 24;
  const cardHFor = (list) => stripH + list.reduce((sum, r) => sum + r.h, 0) + 8;
  const maxCardH = noteY - 24 - cardYMin;

  while (rows.length > 1 && cardHFor(rows) > maxCardH) rows.pop();

  const cardH = cardHFor(rows);
  const cardY = cardH > noteY - 24 - cardYPref ? cardYMin : cardYPref;

  doc.save();
  doc.roundedRect(cardX + 1, cardY + 3, cardW, cardH, 12).fillOpacity(0.55).fill('#EDF1F7');
  doc.restore();

  doc.save();
  doc.roundedRect(cardX, cardY, cardW, cardH, 12).fill(BRAND.surface);
  doc.roundedRect(cardX, cardY, cardW, cardH, 12).lineWidth(1).strokeColor(BRAND.border).stroke();
  doc.rect(cardX + 14, cardY + 14, 3, 12).fill(BRAND.gold);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.inkLight)
    .text('INFORMATIONS DU DOCUMENT', cardX + cardPad, cardY + 15, {
      characterSpacing: 1.6,
      lineBreak: false,
    });

  doc.save();
  doc.moveTo(cardX + cardPad, cardY + stripH - 6).lineTo(cardX + cardW - cardPad, cardY + stripH - 6)
    .lineWidth(1).strokeColor(BRAND.border).stroke();
  doc.restore();

  let rowY = cardY + stripH + 4;
  rows.forEach((row, i) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.inkMuted)
      .text(row.label, cardX + cardPad, rowY + 2, { width: labelW, characterSpacing: 0.5 });
    doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink)
      .text(row.value, valueX, rowY, { width: valueW });

    rowY += row.h;
    if (i < rows.length - 1) {
      doc.save();
      doc.moveTo(cardX + cardPad, rowY - 7).lineTo(cardX + cardW - cardPad, rowY - 7)
        .lineWidth(0.6).strokeColor('#F1F5F9').stroke();
      doc.restore();
    }
  });

  // — Mention de confidentialité —
  doc.save();
  doc.rect(margin + (contentW - 40) / 2, noteY, 40, 2).fill(BRAND.gold);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND.inkMuted)
    .text('DOCUMENT CONFIDENTIEL', margin, noteY + 18, {
      width: contentW,
      align: 'center',
      characterSpacing: 1.8,
    });
  doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.inkLight)
    .text('Réservé aux administrateurs Alanya — ne pas diffuser sans autorisation.', margin, noteY + 34, {
      width: contentW,
      align: 'center',
    });
}

/** En-tête des pages de contenu (après la garde). */
function drawContentPageHeader(doc, documentTitle) {
  documentTitle = pdfText(documentTitle);
  doc._alanyaDocTitle = documentTitle;
  const { margin, pageW, contentHeaderH } = LAYOUT;
  const y = margin - 8;

  doc.save();
  doc.rect(0, 0, pageW, contentHeaderH).fill(BRAND.surface);
  doc.rect(0, contentHeaderH - 1, pageW, 1).fill(BRAND.border);
  doc.rect(0, 0, 4, contentHeaderH).fill(BRAND.primary);
  doc.restore();

  if (drawLogo(doc, margin, 10, 28)) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.ink)
      .text(APP_NAME, margin + 36, 14, { lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor(BRAND.inkMuted)
      .text(documentTitle, margin + 36, 26, { width: pageW - margin * 2 - 80, lineBreak: false });
  } else {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.primary)
      .text(`${APP_NAME} · ${documentTitle}`, margin, 18, { width: pageW - margin * 2 });
  }

  doc.y = contentHeaderH + 16;
  doc.x = margin;
}

function drawSectionTitle(doc, title, { subtitle } = {}) {
  // Réserve de quoi poser le titre *et* le début de son contenu : un titre seul
  // en bas de page, son tableau rejeté sur la suivante, se lit mal.
  ensureSpace(doc, 96);
  const { margin } = LAYOUT;

  doc.save();
  doc.rect(margin, doc.y, 4, subtitle ? 36 : 22).fill(BRAND.primary);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.ink)
    .text(pdfText(title), margin + 14, doc.y + (subtitle ? 0 : 2));
  if (subtitle) {
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkMuted)
      .text(pdfText(subtitle), margin + 14, doc.y + 2);
  }
  doc.moveDown(subtitle ? 1.2 : 0.8);
}

/** Liste de paires libellé / valeur, posée sur un aplat pour la détacher. */
function drawKeyValues(doc, rows) {
  const { margin, contentW } = LAYOUT;
  const pad = 14;
  const rowH = 20;
  const labelW = 210;
  const valueX = margin + pad + labelW;
  const valueW = contentW - pad * 2 - labelW;

  ensureSpace(doc, rows.length * rowH + pad * 2 + 8);
  const top = doc.y;

  doc.save();
  doc.roundedRect(margin, top, contentW, rows.length * rowH + pad * 2 - 4, LAYOUT.radius)
    .fill(BRAND.surfaceAlt);
  doc.restore();

  let y = top + pad;
  rows.forEach(([label, value], i) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.inkMuted);
    writeFlatText(doc, ellipsize(doc, pdfText(label), labelW - 12), { x: margin + pad, y: y + 3 });

    doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink);
    writeFlatText(doc, ellipsize(doc, pdfText(value ?? '—'), valueW), { x: valueX, y: y + 2 });

    y += rowH;
    if (i < rows.length - 1) {
      doc.save();
      doc.moveTo(margin + pad, y - 4).lineTo(margin + contentW - pad, y - 4)
        .lineWidth(0.5).strokeColor(BRAND.border).stroke();
      doc.restore();
    }
  });

  doc.y = top + rows.length * rowH + pad * 2 - 4;
  doc.moveDown(0.8);
}

/** Grille de KPI (2 colonnes), accordée à la carte de la page de garde. */
function drawStatCards(doc, stats) {
  if (!stats.length) return;
  const { margin, contentW } = LAYOUT;
  const gap = 12;
  const cardW = (contentW - gap) / 2;
  const cardH = 66;
  const cols = 2;

  for (let i = 0; i < stats.length; i += cols) {
    ensureSpace(doc, cardH + gap);
    const rowY = doc.y;

    for (let c = 0; c < cols && i + c < stats.length; c++) {
      const { label, value, hint } = stats[i + c];
      const x = margin + c * (cardW + gap);

      doc.save();
      doc.roundedRect(x + 1, rowY + 2, cardW, cardH, LAYOUT.radius).fillOpacity(0.55).fill('#EDF1F7');
      doc.restore();

      doc.save();
      doc.roundedRect(x, rowY, cardW, cardH, LAYOUT.radius).fill(BRAND.surface);
      doc.roundedRect(x, rowY, cardW, cardH, LAYOUT.radius).lineWidth(1).strokeColor(BRAND.border).stroke();
      doc.rect(x, rowY, cardW, 3).fill(BRAND.primary);
      doc.restore();

      // Le repère de comparaison en haut à droite, en vis-à-vis de la valeur.
      if (hint) {
        doc.font('Helvetica').fontSize(7.5).fillColor(BRAND.inkLight);
        writeFlatText(doc, pdfText(hint), {
          x: x + 14, y: rowY + 19, width: cardW - 28, align: 'right',
        });
      }

      doc.font('Helvetica-Bold').fontSize(19).fillColor(BRAND.ink);
      writeFlatText(doc, ellipsize(doc, pdfText(value), cardW - 28), { x: x + 14, y: rowY + 14 });

      doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkMuted);
      writeFlatText(doc, ellipsize(doc, pdfText(label), cardW - 28), { x: x + 14, y: rowY + 42 });
    }
    doc.y = rowY + cardH + gap;
  }
  doc.moveDown(0.4);
}

const TABLE_PAD = 9;

/**
 * Tronque à la largeur disponible avec une ellipse. Sans cela pdfkit, à qui on
 * passerait une `width` plus étroite qu'un mot, coupe **au milieu du mot**
 * (« Utilisateur » rendu « Utilisate / ur ») et double la hauteur de la ligne.
 */
function ellipsize(doc, text, maxW) {
  const s = String(text ?? '');
  if (maxW <= 0) return '';
  if (doc.widthOfString(s) <= maxW) return s;

  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${s.slice(0, mid)}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo).trimEnd()}…` : '';
}

/**
 * Nombres, éventuellement groupés par milliers, et pourcentages : alignés à
 * droite. Les numéros de téléphone commencent par « + » et restent à gauche.
 */
const NUMERIC_CELL = /^\d[\d ]*(?:[.,]\d+)?\s*%?$/;

function columnAligns(headers, rows) {
  return headers.map((_, i) => {
    let seen = 0;
    for (const row of rows) {
      const v = pdfText(row[i]).trim();
      if (!v || v === '—') continue;
      if (!NUMERIC_CELL.test(v)) return 'left';
      seen++;
    }
    return seen ? 'right' : 'left';
  });
}

/**
 * Largeurs de colonnes calculées sur le contenu réel.
 *
 * Le tableau s'élargit jusqu'à la largeur utile quand son contenu le justifie
 * (la liste des utilisateurs l'occupe entièrement), mais un tableau de deux
 * colonnes courtes reste compact plutôt que d'être étiré sur toute la page.
 * Le surplus va d'abord aux colonnes de texte : une colonne de nombres n'a
 * rien à gagner à mesurer 180 pt pour afficher « 4h ».
 */
function computeColumnWidths(doc, { headers, rows, aligns }) {
  const total = LAYOUT.contentW;
  const pad = TABLE_PAD * 2;
  const MIN_W = 30;

  doc.font('Helvetica-Bold').fontSize(8);
  const natural = headers.map((h) => doc.widthOfString(pdfText(h).toUpperCase(), { characterSpacing: 0.4 }) + pad + 4);

  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      // Les deux premières cellules d'un compte officiel sont rendues en gras :
      // les mesurer en normal ferait tronquer un texte qui tient pourtant.
      doc.font(row._official && i <= 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      const w = doc.widthOfString(pdfText(row[i])) + pad;
      if (w > natural[i]) natural[i] = w;
    }
  }

  const sum = natural.reduce((a, b) => a + b, 0);

  if (sum <= total) {
    const target = Math.min(total, Math.max(sum * 1.3, total * 0.6));
    const weights = natural.map((w, i) => (aligns[i] === 'right' ? w * 0.25 : w));
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;
    const surplus = target - sum;
    return natural.map((w, i) => w + (surplus * weights[i]) / wSum);
  }

  // Trop large : on rabote les colonnes les plus généreuses, jamais sous MIN_W.
  const widths = natural.slice();
  let over = sum - total;
  for (let guard = 0; guard < 12 && over > 0.5; guard++) {
    const room = widths.map((w) => Math.max(0, w - MIN_W));
    const pool = room.reduce((a, b) => a + b, 0);
    if (pool <= 0) break;
    const cut = Math.min(over, pool);
    for (let i = 0; i < widths.length; i++) widths[i] -= (room[i] / pool) * cut;
    over -= cut;
  }
  return widths;
}

/**
 * Tableau — en-tête indigo répété à chaque page, lignes alternées, cellules sur
 * une seule ligne (ellipse au besoin) donc de hauteur constante.
 *
 * Les largeurs de colonnes viennent du contenu ; le `colWidths` que passent les
 * appelants est accepté sans effet, pour ne pas avoir à toucher leurs appels.
 */
function drawTable(doc, { headers, rows }) {
  const { margin, contentW, tableHeaderH, tableRowH } = LAYOUT;

  if (!rows.length) {
    ensureSpace(doc, 48);
    const y = doc.y;
    doc.save();
    doc.roundedRect(margin, y, contentW, 38, LAYOUT.radius).fill(BRAND.surfaceAlt);
    doc.roundedRect(margin, y, contentW, 38, LAYOUT.radius).lineWidth(1).strokeColor(BRAND.border).stroke();
    doc.restore();
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkMuted);
    writeFlatText(doc, 'Aucune donnée disponible', { x: margin, y: y + 15, width: contentW, align: 'center' });
    doc.y = y + 46;
    return;
  }

  const aligns = columnAligns(headers, rows);
  const widths = computeColumnWidths(doc, { headers, rows, aligns });
  const colX = [];
  let acc = margin;
  for (const w of widths) { colX.push(acc); acc += w; }
  const tableW = acc - margin;

  const tableCtx = { headerDrawnOnPage: false };

  function drawHeaderRow() {
    const y = doc.y;
    doc.save();
    doc.rect(margin, y, tableW, tableHeaderH).fill(BRAND.primary);
    doc.restore();

    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.headerText);
    headers.forEach((h, i) => {
      const inner = widths[i] - TABLE_PAD * 2;
      writeFlatText(doc, ellipsize(doc, pdfText(h).toUpperCase(), inner), {
        x: colX[i] + TABLE_PAD,
        y: y + 8,
        width: inner,
        align: aligns[i],
        characterSpacing: 0.4,
      });
    });
    doc.y = y + tableHeaderH;
    tableCtx.headerDrawnOnPage = true;
  }

  function maybeNewPage(needed) {
    if (doc.y + needed > contentBottom(doc)) {
      startContentPage(doc);
      tableCtx.headerDrawnOnPage = false;
    }
    if (!tableCtx.headerDrawnOnPage) drawHeaderRow();
  }

  // Pas de tableau amorcé en bas de page pour une ou deux lignes.
  maybeNewPage(tableHeaderH + tableRowH * Math.min(3, rows.length));

  rows.forEach((row, rowIndex) => {
    maybeNewPage(tableRowH);
    const y = doc.y;
    const isOfficial = row._official;

    doc.save();
    doc.rect(margin, y, tableW, tableRowH).fill(rowIndex % 2 === 0 ? BRAND.surface : BRAND.surfaceAlt);
    if (isOfficial) doc.rect(margin, y, 3, tableRowH).fill(BRAND.gold);
    doc.moveTo(margin, y + tableRowH).lineTo(margin + tableW, y + tableRowH)
      .lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.restore();

    row.forEach((cell, i) => {
      const isGoldCell = isOfficial && i <= 1;
      doc.font(isGoldCell ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
        .fillColor(isGoldCell ? BRAND.gold : BRAND.ink);
      const inner = widths[i] - TABLE_PAD * 2;
      writeFlatText(doc, ellipsize(doc, pdfText(cell), inner), {
        x: colX[i] + TABLE_PAD,
        y: y + 7,
        width: inner,
        align: aligns[i],
      });
    });

    doc.y = y + tableRowH;
  });

  doc.moveDown(0.8);
}

/**
 * Pied de page de toutes les pages de contenu, en une passe finale (le total
 * n'est connu qu'à la fin).
 *
 * Deux garanties indépendantes contre les pages fantômes :
 *  1. le pied de page est dessiné **dans** la boîte imprimable, dans la bande
 *     `footerH` que `contentBottom()` réserve déjà — plus sous la marge basse ;
 *  2. le texte passe par `writeFlatText`, qui n'atteint jamais la logique de
 *     pagination de pdfkit.
 */
function drawPageFooters(doc, { coverPage = true } = {}) {
  const range = doc.bufferedPageRange();
  const totalContent = coverPage ? Math.max(range.count - 1, 0) : range.count;
  const { margin, pageW, pageH, footerH, contentW } = LAYOUT;

  const ruleY = pageH - margin - footerH + 8;
  const textY = ruleY + 7;

  for (let i = range.start; i < range.start + range.count; i++) {
    if (coverPage && i === range.start) continue;

    doc.switchToPage(i);
    const contentNum = coverPage ? i : i + 1;

    doc.save();
    doc.moveTo(margin, ruleY).lineTo(pageW - margin, ruleY)
      .lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.restore();

    doc.font('Helvetica').fontSize(7).fillColor(BRAND.inkLight);
    writeFlatText(doc, `${APP_NAME} · Confidentiel`, { x: margin, y: textY });
    writeFlatText(doc, `Page ${contentNum} sur ${totalContent}`, {
      x: margin,
      y: textY,
      width: contentW,
      align: 'right',
    });
  }

  // Filet de sécurité : le pied de page ne doit jamais faire grossir le buffer.
  const after = doc.bufferedPageRange().count;
  if (after !== range.count) {
    console.warn(
      `[adminExportPdf] ${after - range.count} page(s) créée(s) pendant le pied de page — régression de pagination.`,
    );
  }
}

module.exports = {
  drawCoverPage,
  startContentPage,
  drawContentPageHeader,
  drawSectionTitle,
  drawKeyValues,
  drawStatCards,
  drawTable,
  drawPageFooters,
  writeFlatText,
  ensureSpace,
  contentBottom,
  logoExists,
};
