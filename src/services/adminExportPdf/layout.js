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

function ensureSpace(doc, needed = 60) {
  if (doc.y + needed > contentBottom(doc)) {
    doc.addPage();
    drawContentPageHeader(doc, doc._alanyaDocTitle || '');
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

/** Page de garde — logo, titre, métadonnées. */
function drawCoverPage(doc, {
  documentTitle,
  documentSubtitle,
  metaRows = [],
  badge,
}) {
  const { margin, pageW, pageH, coverBandH, contentW } = LAYOUT;

  // Bandeau indigo
  doc.save();
  doc.rect(0, 0, pageW, coverBandH).fill(BRAND.primary);
  doc.rect(0, coverBandH - 4, pageW, 4).fill(BRAND.gold);
  doc.restore();

  const logoW = 88;
  const logoX = margin;
  const logoY = 28;
  if (!drawLogo(doc, logoX, logoY, logoW)) {
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#FFFFFF')
      .text(APP_NAME, logoX, logoY + 16);
  }

  doc.font('Helvetica').fontSize(11).fillColor('#E0E7FF')
    .text('Rapport administratif', pageW - margin - 160, 36, { width: 160, align: 'right' });

  let y = coverBandH + 56;

  doc.font('Helvetica-Bold').fontSize(34).fillColor(BRAND.ink)
    .text(APP_NAME, margin, y, { width: contentW, align: 'center' });
  y = doc.y + 4;

  doc.font('Helvetica').fontSize(13).fillColor(BRAND.inkMuted)
    .text(APP_TAGLINE, margin, y, { width: contentW, align: 'center' });
  y = doc.y + 20;

  const lineW = 72;
  doc.save();
  doc.rect(margin + (contentW - lineW) / 2, y, lineW, 3).fill(BRAND.gold);
  doc.restore();
  y += 24;

  doc.font('Helvetica-Bold').fontSize(22).fillColor(BRAND.primaryDark)
    .text(documentTitle, margin, y, { width: contentW, align: 'center' });
  y = doc.y + 6;

  if (documentSubtitle) {
    doc.font('Helvetica').fontSize(11).fillColor(BRAND.inkMuted)
      .text(documentSubtitle, margin, y, { width: contentW, align: 'center' });
    y = doc.y + 8;
  }

  if (badge) {
    const badgeW = Math.min(doc.widthOfString(badge, { font: 'Helvetica-Bold', size: 9 }) + 24, contentW);
    const badgeX = margin + (contentW - badgeW) / 2;
    doc.save();
    doc.roundedRect(badgeX, y + 4, badgeW, 22, 11).fill(BRAND.goldLight);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.gold)
      .text(badge, badgeX, y + 10, { width: badgeW, align: 'center' });
    doc.restore();
    y += 36;
  } else {
    y += 16;
  }

  // Carte métadonnées
  const cardX = margin + 24;
  const cardW = contentW - 48;
  const cardPad = 20;
  const rowH = 22;
  const cardH = cardPad * 2 + metaRows.length * rowH;

  doc.save();
  doc.roundedRect(cardX, y, cardW, cardH, LAYOUT.radius).fill(BRAND.surfaceAlt);
  doc.roundedRect(cardX, y, cardW, cardH, LAYOUT.radius).lineWidth(1).strokeColor(BRAND.border).stroke();
  doc.rect(cardX, y, 4, cardH).fill(BRAND.primary);
  doc.restore();

  let rowY = y + cardPad;
  doc.font('Helvetica').fontSize(10);
  for (const [label, value] of metaRows) {
    doc.font('Helvetica-Bold').fillColor(BRAND.inkMuted)
      .text(label, cardX + cardPad + 8, rowY, { width: 140, continued: false });
    doc.font('Helvetica').fillColor(BRAND.ink)
      .text(String(value ?? '—'), cardX + cardPad + 148, rowY, { width: cardW - cardPad * 2 - 156 });
    rowY += rowH;
  }

  y += cardH + 40;

  doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkLight)
    .text(
      'Document confidentiel — réservé aux administrateurs Alanya.\nNe pas diffuser sans autorisation.',
      margin,
      pageH - margin - 36,
      { width: contentW, align: 'center', lineGap: 2 },
    );
}

/** En-tête des pages de contenu (après la garde). */
function drawContentPageHeader(doc, documentTitle) {
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
  ensureSpace(doc, 52);
  const { margin } = LAYOUT;

  doc.save();
  doc.rect(margin, doc.y, 4, subtitle ? 36 : 22).fill(BRAND.primary);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.ink)
    .text(title, margin + 14, doc.y + (subtitle ? 0 : 2));
  if (subtitle) {
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkMuted)
      .text(subtitle, margin + 14, doc.y + 2);
  }
  doc.moveDown(subtitle ? 1.2 : 0.8);
}

function drawKeyValues(doc, rows) {
  ensureSpace(doc, rows.length * 18 + 16);
  const { margin } = LAYOUT;
  const labelW = 180;

  for (const [label, value] of rows) {
    ensureSpace(doc, 18);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.inkMuted)
      .text(`${label}`, margin + 8, y, { width: labelW });
    doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink)
      .text(String(value ?? '—'), margin + labelW + 8, y, { width: LAYOUT.contentW - labelW - 16 });
    doc.y = y + 18;
  }
  doc.moveDown(0.6);
}

/** Grille de KPI (2 colonnes). */
function drawStatCards(doc, stats) {
  if (!stats.length) return;
  const { margin, contentW } = LAYOUT;
  const gap = 12;
  const cardW = (contentW - gap) / 2;
  const cardH = 64;
  const cols = 2;

  for (let i = 0; i < stats.length; i += cols) {
    ensureSpace(doc, cardH + gap);
    const rowY = doc.y;

    for (let c = 0; c < cols && i + c < stats.length; c++) {
      const { label, value, hint } = stats[i + c];
      const x = margin + c * (cardW + gap);

      doc.save();
      doc.roundedRect(x, rowY, cardW, cardH, LAYOUT.radius).fill(BRAND.surface);
      doc.roundedRect(x, rowY, cardW, cardH, LAYOUT.radius).lineWidth(1).strokeColor(BRAND.border).stroke();
      doc.rect(x, rowY, cardW, 3).fill(BRAND.primary);
      doc.restore();

      doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND.ink)
        .text(String(value), x + 14, rowY + 12, { width: cardW - 28, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkMuted)
        .text(label, x + 14, rowY + 34, { width: cardW - 28, lineBreak: false });
      if (hint) {
        doc.font('Helvetica').fontSize(8).fillColor(BRAND.inkLight)
          .text(hint, x + 14, rowY + 46, { width: cardW - 28, align: 'right', lineBreak: false });
      }
    }
    doc.y = rowY + cardH + gap;
  }
  doc.moveDown(0.4);
}

function measureRowHeight(doc, cells, colWidths, fontSize = 8) {
  doc.font('Helvetica').fontSize(fontSize);
  let maxLines = 1;
  cells.forEach((cell, i) => {
    const text = String(cell ?? '');
    const h = doc.heightOfString(text, { width: colWidths[i] - 16 });
    const lines = Math.ceil(h / (fontSize * 1.2)) || 1;
    if (lines > maxLines) maxLines = lines;
  });
  return Math.max(LAYOUT.tableRowH, maxLines * (fontSize * 1.25) + 10);
}

/** Tableau moderne — en-tête indigo, lignes alternées, répétition en-tête. */
function drawTable(doc, { headers, rows, colWidths }) {
  const { margin, tableHeaderH } = LAYOUT;
  const tableW = colWidths.reduce((a, b) => a + b, 0);

  if (!rows.length) {
    ensureSpace(doc, 40);
    doc.save();
    doc.roundedRect(margin, doc.y, tableW, 36, LAYOUT.radius).fill(BRAND.surfaceAlt);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.inkMuted)
      .text('Aucune donnée disponible', margin, doc.y + 12, { width: tableW, align: 'center' });
    doc.restore();
    doc.y += 44;
    return;
  }

  const tableCtx = { headerDrawnOnPage: false };

  function drawHeaderRow() {
    const y = doc.y;
    doc.save();
    doc.rect(margin, y, tableW, tableHeaderH).fill(BRAND.primary);
    doc.restore();

    let x = margin;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.headerText);
    headers.forEach((h, i) => {
      doc.text(h.toUpperCase(), x + 8, y + 8, { width: colWidths[i] - 16, lineBreak: false });
      x += colWidths[i];
    });
    doc.y = y + tableHeaderH;
    tableCtx.headerDrawnOnPage = true;
  }

  function maybeNewPage(rowH) {
    if (doc.y + rowH > contentBottom(doc)) {
      doc.addPage();
      drawContentPageHeader(doc, doc._alanyaDocTitle || '');
      tableCtx.headerDrawnOnPage = false;
    }
    if (!tableCtx.headerDrawnOnPage) drawHeaderRow();
  }

  maybeNewPage(tableHeaderH + LAYOUT.tableRowH);
  if (!tableCtx.headerDrawnOnPage) drawHeaderRow();

  rows.forEach((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : row;
    const isOfficial = row._official;
    const rowH = measureRowHeight(doc, cells, colWidths);

    maybeNewPage(rowH);
    const y = doc.y;
    const bg = rowIndex % 2 === 0 ? BRAND.surface : BRAND.surfaceAlt;

    doc.save();
    doc.rect(margin, y, tableW, rowH).fill(bg);
    if (isOfficial) {
      doc.rect(margin, y, 3, rowH).fill(BRAND.gold);
    }
    doc.moveTo(margin, y + rowH).lineTo(margin + tableW, y + rowH).lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.restore();

    let x = margin;
    doc.font('Helvetica').fontSize(8);
    cells.forEach((cell, i) => {
      const isGoldCell = isOfficial && i <= 1;
      doc.fillColor(isGoldCell ? BRAND.gold : BRAND.ink);
      if (isGoldCell) doc.font('Helvetica-Bold');
      doc.text(String(cell ?? ''), x + 8, y + 7, { width: colWidths[i] - 16 });
      if (isGoldCell) doc.font('Helvetica');
      x += colWidths[i];
    });
    doc.y = y + rowH;
  });

  doc.moveDown(0.8);
}

function drawPageFooters(doc, { coverPage = true } = {}) {
  const range = doc.bufferedPageRange();
  const totalContent = coverPage ? Math.max(range.count - 1, 0) : range.count;
  const { margin, pageW, pageH, contentW } = LAYOUT;

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footerY = pageH - margin + 8;

    if (coverPage && i === range.start) continue;

    const contentNum = coverPage ? i : i + 1;

    doc.save();
    doc.moveTo(margin, footerY - 6).lineTo(pageW - margin, footerY - 6)
      .lineWidth(0.5).strokeColor(BRAND.border).stroke();
    doc.restore();

    doc.font('Helvetica').fontSize(7).fillColor(BRAND.inkLight);
    doc.text(`${APP_NAME} · Confidentiel`, margin, footerY, { lineBreak: false });
    doc.text(`Page ${contentNum} sur ${totalContent}`, margin, footerY, {
      width: contentW,
      align: 'right',
    });
  }
}

module.exports = {
  drawCoverPage,
  drawContentPageHeader,
  drawSectionTitle,
  drawKeyValues,
  drawStatCards,
  drawTable,
  drawPageFooters,
  ensureSpace,
  contentBottom,
  logoExists,
};
