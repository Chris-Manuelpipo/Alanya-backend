const PDFDocument = require('pdfkit');
const { ROLE_LABELS, ACCOUNT_LABELS, LAYOUT } = require('./theme');
const {
  drawCoverPage,
  drawContentPageHeader,
  drawSectionTitle,
  drawKeyValues,
  drawStatCards,
  drawTable,
  drawPageFooters,
} = require('./layout');

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
    return new Date(value).toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
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

/** `meeting.duree` (durée planifiée) est en minutes, pas en secondes. */
function formatMinutes(minutes) {
  const m = Number(minutes) || 0;
  if (!m) return '0 min';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h) return min ? `${h} h ${min} min` : `${h} h`;
  return `${min} min`;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function createPdfBuffer(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: LAYOUT.margin, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      buildFn(doc);
      drawPageFooters(doc, { coverPage: true });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
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
  const docTitle = 'Liste des utilisateurs';
  const generatedAt = formatDateTimeFr(new Date());

  return createPdfBuffer((doc) => {
    drawCoverPage(doc, {
      documentTitle: docTitle,
      documentSubtitle: 'Export des comptes et profils utilisateurs',
      metaRows: [
        ['Date de génération', generatedAt],
        ['Généré par', meta.generatedBy || '—'],
        ['Filtres appliqués', meta.filterSummary || 'Tous les utilisateurs'],
        meta.periodLabel ? ['Période', meta.periodLabel] : null,
        ['Utilisateurs exportés', meta.exported?.toLocaleString('fr-FR') ?? '—'],
        ['Total (filtres)', meta.total?.toLocaleString('fr-FR') ?? '—'],
        meta.limitLabel ? ['Limite', meta.limitLabel] : null,
      ].filter(Boolean),
      badge: Number(meta.exported) > 0 ? `${meta.exported} profil(s)` : null,
    });

    doc.addPage();
    drawContentPageHeader(doc, docTitle);

    drawSectionTitle(doc, 'Résumé de l\'export', {
      subtitle: meta.filterSummary || undefined,
    });
    drawStatCards(doc, [
      { label: 'Exportés', value: (meta.exported ?? 0).toLocaleString('fr-FR') },
      { label: 'Total filtres', value: (meta.total ?? 0).toLocaleString('fr-FR') },
      { label: 'Comptes officiels', value: users.filter((u) => Number(u.account_type) === 2).length.toLocaleString('fr-FR') },
      { label: 'En ligne', value: users.filter((u) => Number(u.is_online) === 1).length.toLocaleString('fr-FR') },
    ]);

    drawSectionTitle(doc, 'Détail des utilisateurs');

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
  });
}

async function buildAnalyticsPdf({ data, sections, meta }) {
  const docTitle = 'Rapport Analytics';
  const generatedAt = formatDateTimeFr(new Date());
  const periodLabel = `${formatDateTimeFr(data.period.from)} → ${formatDateTimeFr(data.period.to)}`;
  const messagesTotal = data.messagesByType.reduce((s, m) => s + m.count, 0);

  return createPdfBuffer((doc) => {
    drawCoverPage(doc, {
      documentTitle: docTitle,
      documentSubtitle: 'Indicateurs d\'activité et d\'engagement',
      metaRows: [
        ['Date de génération', generatedAt],
        ['Généré par', meta.generatedBy || '—'],
        ['Période analysée', periodLabel],
        ['Sections incluses', meta.sectionSummary || '—'],
      ],
      badge: `${sections.size} section(s)`,
    });

    doc.addPage();
    drawContentPageHeader(doc, docTitle);

    if (sections.has('summary')) {
      drawSectionTitle(doc, 'Synthèse', { subtitle: 'Comparaison avec la période précédente' });
      drawStatCards(doc, [
        {
          label: 'Messages',
          value: messagesTotal.toLocaleString('fr-FR'),
          hint: `préc. ${data.comparison.messages.toLocaleString('fr-FR')}`,
        },
        {
          label: 'Appels',
          value: data.calls.total.toLocaleString('fr-FR'),
          hint: `préc. ${data.comparison.calls.toLocaleString('fr-FR')}`,
        },
        {
          label: 'Stories',
          value: data.stories.total.toLocaleString('fr-FR'),
          hint: `préc. ${data.comparison.statuses.toLocaleString('fr-FR')}`,
        },
        {
          label: 'Nouveaux utilisateurs',
          value: data.users.newUsers.toLocaleString('fr-FR'),
          hint: `préc. ${data.comparison.registrations.toLocaleString('fr-FR')}`,
        },
      ]);
    }

    if (sections.has('messaging')) {
      drawSectionTitle(doc, 'Messagerie');
      drawTable(doc, {
        headers: ['Type', 'Nombre'],
        colWidths: [280, 100],
        rows: data.messagesByType.map((m) => [m.label, m.count.toLocaleString('fr-FR')]),
      });
      if (data.messagesByDay.length) {
        drawSectionTitle(doc, 'Messages par jour');
        drawTable(doc, {
          headers: ['Date', 'Messages'],
          colWidths: [160, 100],
          rows: data.messagesByDay.map((d) => [formatDateFr(d.date), d.count.toLocaleString('fr-FR')]),
        });
      }
    }

    if (sections.has('calls')) {
      drawSectionTitle(doc, 'Appels');
      drawStatCards(doc, [
        { label: 'Total appels', value: data.calls.total.toLocaleString('fr-FR') },
        { label: 'Taux de réussite', value: `${data.calls.successRate}%` },
        { label: 'Durée moyenne', value: formatDuration(data.calls.avgDuration) },
        { label: 'Durée totale', value: formatDuration(data.calls.totalDuration) },
      ]);
      drawKeyValues(doc, [
        ['Audio / Vidéo', `${data.calls.audio} / ${data.calls.video}`],
        ['Répondus / Manqués / Rejetés', `${data.calls.answered} / ${data.calls.missed} / ${data.calls.rejected}`],
        ['Relay TURN / P2P', `${data.calls.relay} (${data.calls.relayRate}%) / ${data.calls.p2p} (${data.calls.p2pRate}%)`],
      ]);
      if (data.callsByDay.length) {
        drawTable(doc, {
          headers: ['Date', 'Audio', 'Vidéo'],
          colWidths: [140, 80, 80],
          rows: data.callsByDay.map((d) => [formatDateFr(d.date), d.audio, d.video]),
        });
      }
    }

    if (sections.has('stories')) {
      drawSectionTitle(doc, 'Stories');
      drawStatCards(doc, [
        { label: 'Publiées', value: data.stories.total.toLocaleString('fr-FR') },
        { label: 'Vues totales', value: data.stories.totalViews.toLocaleString('fr-FR') },
        { label: 'Likes', value: data.stories.totalLikes.toLocaleString('fr-FR') },
        { label: 'Engagement', value: `${data.stories.engagementRate}%` },
      ]);
      drawKeyValues(doc, [
        ['Vues moyennes', data.stories.avgViews],
      ]);
      drawTable(doc, {
        headers: ['Type', 'Nombre'],
        colWidths: [200, 100],
        rows: data.stories.byType.map((t) => [t.label, t.count]),
      });
    }

    if (sections.has('meetings')) {
      drawSectionTitle(doc, 'Réunions');
      drawStatCards(doc, [
        { label: 'Total', value: data.meetings.total.toLocaleString('fr-FR') },
        { label: 'Taux de présence', value: `${data.meetings.attendanceRate}%` },
        { label: 'Durée réelle moy.', value: formatDuration(data.meetings.avgRealDuration) },
        { label: 'No-show', value: `${data.meetings.noShowRate}%` },
      ]);
      drawKeyValues(doc, [
        ['Terminées', `${data.meetings.ended} / ${data.meetings.total}`],
        ['Durée planifiée moyenne', formatMinutes(data.meetings.avgPlannedMinutes)],
        ['Présents / participants', `${data.meetings.attendees} / ${data.meetings.participants}`],
        ['Acceptés / Refusés / Sans réponse', `${data.meetings.accepted} / ${data.meetings.declined} / ${data.meetings.invited}`],
        ['Acceptés jamais venus', `${data.meetings.noShow}`],
      ]);
    }

    if (sections.has('users')) {
      drawSectionTitle(doc, 'Utilisateurs');
      drawStatCards(doc, [
        { label: 'Total plateforme', value: data.users.totalUsers.toLocaleString('fr-FR') },
        { label: 'Nouveaux (période)', value: data.users.newUsers.toLocaleString('fr-FR') },
        { label: 'Bannis (période)', value: data.users.bannedUsers.toLocaleString('fr-FR') },
      ]);
      drawTable(doc, {
        headers: ['Rôle', 'Nombre'],
        colWidths: [200, 100],
        rows: data.users.byRole.map((r) => [r.label, r.count]),
      });
    }

    if (sections.has('conversations')) {
      drawSectionTitle(doc, 'Conversations');
      drawStatCards(doc, [
        { label: 'Total', value: data.conversations.total.toLocaleString('fr-FR') },
        { label: 'Groupes', value: data.conversations.groups.toLocaleString('fr-FR') },
        { label: 'Privées (1-1)', value: data.conversations.oneToOne.toLocaleString('fr-FR') },
        { label: 'Taille moy. groupe', value: String(data.conversations.avgGroupSize) },
      ]);
    }

    if (sections.has('devices')) {
      drawSectionTitle(doc, 'Appareils (connexions)');
      drawTable(doc, {
        headers: ['OS', 'Connexions'],
        colWidths: [200, 100],
        rows: data.devices.map((d) => [d.os, d.count]),
      });
    }

    if (sections.has('heatmap')) {
      drawSectionTitle(doc, 'Heures de pointe (messages)', {
        subtitle: 'Top 24 créneaux les plus actifs',
      });
      const topSlots = [...data.heatmap]
        .sort((a, b) => b.count - a.count)
        .slice(0, 24);
      const dowLabels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
      drawTable(doc, {
        headers: ['Jour', 'Heure', 'Messages'],
        colWidths: [80, 80, 100],
        rows: topSlots.map((h) => [
          dowLabels[h.dow] ?? h.dow,
          `${h.hour}h`,
          h.count,
        ]),
      });
    }
  });
}

module.exports = {
  buildUsersPdf,
  buildUsersCsv,
  buildAnalyticsPdf,
  formatDateFr,
};
