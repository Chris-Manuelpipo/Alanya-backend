const pool = require('../../config/db');
const { fetchUsersForExport, parseExportLimit } = require('./usersQuery');
const { fetchAnalyticsData, parseAnalyticsSections, ALL_ANALYTICS_SECTIONS } = require('./analyticsData');
const { buildUsersPdf, buildUsersCsv, buildAnalyticsPdf } = require('../../services/adminExportPdf');

const SECTION_LABELS = {
  summary: 'Synthèse',
  messaging: 'Messagerie',
  calls: 'Appels',
  stories: 'Stories',
  meetings: 'Réunions',
  users: 'Utilisateurs',
  conversations: 'Conversations',
  devices: 'Appareils',
  heatmap: 'Heures de pointe',
};

function buildUsersFilterSummary(query) {
  const parts = [];
  if (query.search) parts.push(`Recherche « ${query.search} »`);
  if (query.status === 'online') parts.push('En ligne');
  if (query.status === 'banned') parts.push('Bannis');
  if (query.status === 'admin') parts.push('Admins');
  if (query.account_type != null && query.account_type !== '') {
    const types = { 0: 'Personnel', 1: 'Business', 2: 'Officiel' };
    parts.push(types[query.account_type] || `Type ${query.account_type}`);
  }
  if (query.type_compte != null && query.type_compte !== '') {
    const roles = { 0: 'Utilisateur', 1: 'Admin', 2: 'Super Admin' };
    parts.push(roles[query.type_compte] || `Rôle ${query.type_compte}`);
  }
  if (query.idPays) parts.push(`Pays #${query.idPays}`);
  if (query.from || query.to) {
    parts.push(`Inscrits ${query.from || '…'} → ${query.to || '…'}`);
  }
  return parts.length ? parts.join(' · ') : 'Tous les utilisateurs';
}

function exportFilename(prefix, ext) {
  const d = new Date().toISOString().split('T')[0];
  return `alanya_${prefix}_${d}.${ext}`;
}

const exportUsers = async (req, res) => {
  try {
    const format = String(req.query.format || 'pdf').toLowerCase();
    if (format !== 'pdf' && format !== 'csv') {
      return res.status(400).json({ error: 'Format non supporté (pdf ou csv)' });
    }

    const exportLimit = parseExportLimit(req.query.limit);
    const { items, total, exported } = await fetchUsersForExport(pool, req.query, exportLimit);

    const meta = {
      total,
      exported,
      filterSummary: buildUsersFilterSummary(req.query),
      generatedBy: req.user?.email || `Admin #${req.user?.alanyaID}`,
      limitLabel: exportLimit != null ? exportLimit.toLocaleString('fr-FR') : 'Tous',
    };

    if (format === 'csv') {
      const csv = buildUsersCsv(items);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('users', 'csv')}"`);
      return res.send(csv);
    }

    const pdf = await buildUsersPdf({ users: items, meta });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('users', 'pdf')}"`);
    return res.send(pdf);
  } catch (error) {
    console.error('[Admin] exportUsers error:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
};

const exportAnalytics = async (req, res) => {
  try {
    const format = String(req.query.format || 'pdf').toLowerCase();
    if (format !== 'pdf') {
      return res.status(400).json({ error: 'Seul le format PDF est disponible pour analytics' });
    }

    const data = await fetchAnalyticsData(req.query.from, req.query.to);
    const sections = parseAnalyticsSections(req.query.sections);
    const sectionSummary = [...sections]
      .map((s) => SECTION_LABELS[s] || s)
      .join(', ');

    const pdf = await buildAnalyticsPdf({
      data,
      sections,
      meta: {
        generatedBy: req.user?.email || `Admin #${req.user?.alanyaID}`,
        sectionSummary: sectionSummary || ALL_ANALYTICS_SECTIONS.map((s) => SECTION_LABELS[s]).join(', '),
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename('analytics', 'pdf')}"`);
    return res.send(pdf);
  } catch (error) {
    console.error('[Admin] exportAnalytics error:', error.message);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
};

module.exports = { exportUsers, exportAnalytics };
