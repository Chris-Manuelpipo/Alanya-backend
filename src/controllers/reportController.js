const { createReport, REPORT_REASONS } = require('../services/reportService');

/**
 * Dépôt d'un signalement par un utilisateur.
 *
 * Un doublon renvoie 200 et non 409 : la personne a signalé, sa plainte est
 * enregistrée, et lui répondre par une erreur l'inviterait à recommencer.
 */
const postReport = async (req, res) => {
  try {
    const { duplicate } = await createReport(req.user.alanyaID, req.body || {});
    res.json({ ok: true, duplicate });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('[Report] postReport error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/** Motifs acceptés — la source de vérité est le serveur, le libellé le client. */
const getReportReasons = (_req, res) => {
  res.json({ reasons: REPORT_REASONS });
};

module.exports = { postReport, getReportReasons };
