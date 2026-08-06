const PDFDocument = require('pdfkit');

const GOLD = '#C9A227';
const MARGIN = 48;
const PAGE_W = 595.28;
const CONTENT_W = PAGE_W - MARGIN * 2;

const ROLE_LABELS = { 0: 'Utilisateur', 1: 'Admin', 2: 'Super Admin' };
const ACCOUNT_LABELS = { 0: 'Personnel', 1: 'Business', 2: 'Officiel' };

function formatDateFr(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('fr-FR');
  } catch {
    return String(value);
  }
}

function formatDateTimeFr(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('fr-FR');
  } catch {
    return String(value);
  }
}

function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (!s) return '0s';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function createPdfBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      buildFn(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function ensureSpace(doc, needed = 60) {
  if (doc.y + needed > doc.page.height - MARGIN) {
    doc.addPage();
  }
}

function drawReportHeader(doc, { title, subtitle, periodLabel, generatedBy }) {
  doc.fillColor(GOLD).fontSize(22).font('Helvetica-Bold').text('Alanya', MARGIN, MARGIN);
  doc.fillColor('#111827').fontSize(18).text(title, MARGIN, doc.y + 4);
  if (subtitle) {
    doc.fontSize(10).font('Helvetica').fillColor('#6b7280').text(subtitle, MARGIN, doc.y + 4);
  }
  if (periodLabel) {
    doc.text(`Période : ${periodLabel}`, MARGIN, doc.y + 2);
  }
  doc.text(`Généré le ${formatDateTimeFr(new Date())}${generatedBy ? ` · ${generatedBy}` : ''}`, MARGIN, doc.y + 2);
  doc.moveDown(0.8);
  doc.strokeColor('#e5e7eb').moveTo(MARGIN, doc.y).lineTo(PAGE_W - MARGIN, doc.y).stroke();
  doc.moveDown(0.8);
  doc.fillColor('#111827');
}

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 48);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text(title, MARGIN, doc.y);
  doc.moveDown(0.4);
}

function drawKeyValues(doc, rows) {
  ensureSpace(doc, rows.length * 16 + 12);
  doc.font('Helvetica').fontSize(10);
  for (const [label, value] of rows) {
    ensureSpace(doc, 16);
    doc.font('Helvetica-Bold').fillColor('#374151').text(`${label} : `, MARGIN, doc.y, { continued: true });
    doc.font('Helvetica').fillColor('#111827').text(String(value));
  }
  doc.moveDown(0.5);
}

function drawTable(doc, { headers, rows, colWidths }) {
  if (!rows.length) {
    doc.fontSize(9).fillColor('#9ca3af').text('Aucune donnée', MARGIN, doc.y);
    doc.moveDown(0.5);
    return;
  }

  const rowH = 18;
  const headerH = 20;

  function drawHeaderRow() {
    ensureSpace(doc, headerH + rowH);
    let x = MARGIN;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#374151');
    headers.forEach((h, i) => {
      doc.text(h, x + 2, doc.y, { width: colWidths[i] - 4, lineBreak: false });
      x += colWidths[i];
    });
    doc.y += headerH - 10;
    doc.strokeColor('#d1d5db').moveTo(MARGIN, doc.y).lineTo(MARGIN + colWidths.reduce((a, b) => a + b, 0), doc.y).stroke();
    doc.y += 4;
  }

  drawHeaderRow();
  doc.font('Helvetica').fontSize(8).fillColor('#111827');

  for (const row of rows) {
    if (doc.y + rowH > doc.page.height - MARGIN) {
      doc.addPage();
      drawHeaderRow();
    }
    let x = MARGIN;
    const y = doc.y;
    row.forEach((cell, i) => {
      const isOfficial = row._official && i <= 1;
      if (isOfficial) doc.fillColor(GOLD);
      doc.text(String(cell ?? ''), x + 2, y, { width: colWidths[i] - 4, lineBreak: false });
      if (isOfficial) doc.fillColor('#111827');
      x += colWidths[i];
    });
    doc.y = y + rowH;
  }
  doc.moveDown(0.6);
}

function userStatusLabel(user) {
  if (Number(user.exclus) === 1) return 'Banni';
  if (Number(user.is_online) === 1) return 'En ligne';
  return 'Hors ligne';
}

function buildUsersCsv(users) {
  const headers = ['ID', 'Nom', 'Pseudo', 'Email', 'Téléphone', 'Rôle', 'Type compte', 'Statut', 'Pays', 'Inscrit le'];
  const lines = [headers.join(',')];
  for (const u of users) {
    lines.push([
      u.alanyaID,
      u.nom,
      u.pseudo,
      u.email,
      u.alanyaPhone,
      ROLE_LABELS[u.type_compte] ?? u.type_compte,
      ACCOUNT_LABELS[u.account_type] ?? u.account_type,
      userStatusLabel(u),
      u.pays_libelle || '',
      formatDateFr(u.created_at),
    ].map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

async function buildUsersPdf({ users, meta }) {
  return createPdfBuffer((doc) => {
    drawReportHeader(doc, {
      title: 'Liste des utilisateurs',
      subtitle: meta.filterSummary || undefined,
      periodLabel: meta.periodLabel || undefined,
      generatedBy: meta.generatedBy,
    });

    drawKeyValues(doc, [
      ['Utilisateurs exportés', meta.exported],
      ['Total correspondant aux filtres', meta.total],
      meta.limitLabel ? ['Limite appliquée', meta.limitLabel] : null,
    ].filter(Boolean));

    const headers = ['ID', 'Nom', 'Pseudo', 'Tél.', 'Rôle', 'Compte', 'Statut', 'Pays'];
    const colWidths = [32, 72, 58, 52, 48, 52, 48, 58];
    const rows = users.map((u) => {
      const row = [
        u.alanyaID,
        u.nom,
        `@${u.pseudo}`,
        u.alanyaPhone,
        ROLE_LABELS[u.type_compte] ?? '',
        ACCOUNT_LABELS[u.account_type] ?? '',
        userStatusLabel(u),
        u.pays_libelle || '',
      ];
      if (Number(u.account_type) === 2) row._official = true;
      return row;
    });

    drawTable(doc, { headers, rows, colWidths });

    doc.fontSize(8).fillColor('#9ca3af').text(
      'Document confidentiel — usage administrateur Alanya uniquement.',
      MARGIN,
      doc.page.height - MARGIN,
      { align: 'center', width: CONTENT_W },
    );
  });
}

async function buildAnalyticsPdf({ data, sections, meta }) {
  const messagesTotal = data.messagesByType.reduce((s, m) => s + m.count, 0);

  return createPdfBuffer((doc) => {
    drawReportHeader(doc, {
      title: 'Rapport Analytics',
      subtitle: meta.sectionSummary,
      periodLabel: `${formatDateTimeFr(data.period.from)} → ${formatDateTimeFr(data.period.to)}`,
      generatedBy: meta.generatedBy,
    });

    if (sections.has('summary')) {
      drawSectionTitle(doc, 'Synthèse');
      drawKeyValues(doc, [
        ['Messages', `${messagesTotal.toLocaleString('fr-FR')} (période préc. : ${data.comparison.messages.toLocaleString('fr-FR')})`],
        ['Appels', `${data.calls.total.toLocaleString('fr-FR')} (période préc. : ${data.comparison.calls.toLocaleString('fr-FR')})`],
        ['Stories', `${data.stories.total.toLocaleString('fr-FR')} (période préc. : ${data.comparison.statuses.toLocaleString('fr-FR')})`],
        ['Nouveaux utilisateurs', `${data.users.newUsers.toLocaleString('fr-FR')} (période préc. : ${data.comparison.registrations.toLocaleString('fr-FR')})`],
      ]);
    }

    if (sections.has('messaging')) {
      drawSectionTitle(doc, 'Messagerie');
      drawTable(doc, {
        headers: ['Type', 'Nombre'],
        colWidths: [200, 80],
        rows: data.messagesByType.map((m) => [m.label, m.count.toLocaleString('fr-FR')]),
      });
      if (data.messagesByDay.length) {
        drawSectionTitle(doc, 'Messages par jour');
        drawTable(doc, {
          headers: ['Date', 'Messages'],
          colWidths: [120, 80],
          rows: data.messagesByDay.map((d) => [formatDateFr(d.date), d.count.toLocaleString('fr-FR')]),
        });
      }
    }

    if (sections.has('calls')) {
      drawSectionTitle(doc, 'Appels');
      drawKeyValues(doc, [
        ['Total', data.calls.total],
        ['Taux de réussite', `${data.calls.successRate}%`],
        ['Durée moyenne', formatDuration(data.calls.avgDuration)],
        ['Durée totale', formatDuration(data.calls.totalDuration)],
        ['Audio / Vidéo', `${data.calls.audio} / ${data.calls.video}`],
        ['Répondus / Manqués / Rejetés', `${data.calls.answered} / ${data.calls.missed} / ${data.calls.rejected}`],
        ['Relay TURN / P2P', `${data.calls.relay} (${data.calls.relayRate}%) / ${data.calls.p2p} (${data.calls.p2pRate}%)`],
      ]);
      if (data.callsByDay.length) {
        drawTable(doc, {
          headers: ['Date', 'Audio', 'Vidéo'],
          colWidths: [100, 60, 60],
          rows: data.callsByDay.map((d) => [formatDateFr(d.date), d.audio, d.video]),
        });
      }
    }

    if (sections.has('stories')) {
      drawSectionTitle(doc, 'Stories');
      drawKeyValues(doc, [
        ['Publiées', data.stories.total],
        ['Vues totales', data.stories.totalViews],
        ['Likes', data.stories.totalLikes],
        ['Vues moyennes', data.stories.avgViews],
        ['Engagement', `${data.stories.engagementRate}%`],
      ]);
      drawTable(doc, {
        headers: ['Type', 'Nombre'],
        colWidths: [160, 80],
        rows: data.stories.byType.map((t) => [t.label, t.count]),
      });
    }

    if (sections.has('meetings')) {
      drawSectionTitle(doc, 'Réunions');
      drawKeyValues(doc, [
        ['Total', data.meetings.total],
        ['Durée moyenne', formatDuration(data.meetings.avgDuration)],
        ['Acceptés / Refusés / Sans réponse', `${data.meetings.accepted} / ${data.meetings.declined} / ${data.meetings.invited}`],
        ['Taux de présence', `${data.meetings.attendanceRate}%`],
        ['No-show', `${data.meetings.noShowRate}%`],
      ]);
    }

    if (sections.has('users')) {
      drawSectionTitle(doc, 'Utilisateurs');
      drawKeyValues(doc, [
        ['Total plateforme', data.users.totalUsers],
        ['Nouveaux (période)', data.users.newUsers],
        ['Bannis (période)', data.users.bannedUsers],
      ]);
      drawTable(doc, {
        headers: ['Rôle', 'Nombre'],
        colWidths: [160, 80],
        rows: data.users.byRole.map((r) => [r.label, r.count]),
      });
    }

    if (sections.has('conversations')) {
      drawSectionTitle(doc, 'Conversations');
      drawKeyValues(doc, [
        ['Total', data.conversations.total],
        ['Groupes', data.conversations.groups],
        ['Privées (1-1)', data.conversations.oneToOne],
        ['Taille moy. groupe', data.conversations.avgGroupSize],
      ]);
    }

    if (sections.has('devices')) {
      drawSectionTitle(doc, 'Appareils (connexions)');
      drawTable(doc, {
        headers: ['OS', 'Connexions'],
        colWidths: [160, 80],
        rows: data.devices.map((d) => [d.os, d.count]),
      });
    }

    if (sections.has('heatmap')) {
      drawSectionTitle(doc, 'Heures de pointe (messages)');
      const topSlots = [...data.heatmap]
        .sort((a, b) => b.count - a.count)
        .slice(0, 24);
      const dowLabels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
      drawTable(doc, {
        headers: ['Jour', 'Heure', 'Messages'],
        colWidths: [60, 60, 80],
        rows: topSlots.map((h) => [
          dowLabels[h.dow] ?? h.dow,
          `${h.hour}h`,
          h.count,
        ]),
      });
    }

    doc.fontSize(8).fillColor('#9ca3af').text(
      'Document confidentiel — usage administrateur Alanya uniquement.',
      MARGIN,
      doc.page.height - MARGIN,
      { align: 'center', width: CONTENT_W },
    );
  });
}

module.exports = {
  buildUsersPdf,
  buildUsersCsv,
  buildAnalyticsPdf,
  formatDateFr,
};
