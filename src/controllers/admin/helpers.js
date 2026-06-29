const { sendMail, renderHtmlEmail, escapeHtml } = require('../../services/mailService');

// Helper pour `from` par défaut
const _daysAgoIso = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

// Libellés métier (cf. commentaires SQL des colonnes `type`)
const _MESSAGE_TYPE_LABELS = ['Texte', 'Image', 'Vidéo', 'Audio', 'Fichier', 'Localisation'];
const _STATUS_TYPE_LABELS  = ['Texte', 'Image', 'Vidéo'];
const _ROLE_LABELS = { 0: 'Utilisateur', 1: 'Admin', 2: 'Super-admin' };

// Conversion sûre des agrégats SQL (SUM peut renvoyer NULL ou une string)
const _num = (v) => Number(v) || 0;

// Formatage relatif FR pour le feed d'activité
const _relativeTime = (date) => {
  const ts = new Date(date).getTime();
  if (Number.isNaN(ts)) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)     return "à l'instant";
  if (diff < 3600)   return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400)  return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `il y a ${Math.floor(diff / 86400)} j`;
  return new Date(date).toLocaleDateString('fr-FR');
};

const _appName = process.env.APP_NAME || 'Alanya';

const _buildUserMailFrom = () => {
  const fromEmail = process.env.SMTP_FROM;
  const fromName = process.env.MAIL_FROM_NAME || _appName;
  return fromEmail ? `"${fromName}" <${fromEmail}>` : undefined;
};

const _notifyUserAccountAction = async ({ email, nom, action, reason }) => {
  if (!email) return;

  const subject =
    action === 'ban'
      ? `Votre compte a été banni sur ${_appName}`
      : `Votre compte a été supprimé sur ${_appName}`;
  const title = action === 'ban' ? 'Compte suspendu' : 'Compte supprimé';
  const lead = action === 'ban'
    ? `Votre compte sur ${_appName} a été suspendu par un administrateur.`
    : `Votre compte sur ${_appName} a été supprimé par un administrateur.`;
  const safeReason = reason ? escapeHtml(reason) : '';
  const bodyHtml = `
    <p>Bonjour ${escapeHtml(nom || 'utilisateur')},</p>
    <p>${escapeHtml(lead)}</p>
    ${reason ? `<div style="margin-top:18px;padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:6px">Motif</div><div style="color:#111827">${safeReason}</div></div>` : ''}
    <p style="margin-top:18px;">Si vous pensez qu'il s'agit d'une erreur, contactez le support.</p>`;
  const text = `${lead}${reason ? `\n\nMotif : ${reason}` : ''}\n\nSi vous pensez qu'il s'agit d'une erreur, contactez le support.`;
  const html = renderHtmlEmail({
    title,
    preheader: title,
    eyebrow: _appName,
    heading: title,
    intro: 'Notification de sécurité et de compte',
    bodyHtml,
    accent: action === 'ban' ? '#e11d48' : '#111827',
    footerNote: 'Cet email est envoyé automatiquement, merci de ne pas y répondre.',
  });

  await sendMail({
    from: _buildUserMailFrom(),
    to: email,
    subject,
    text,
    html,
  });
};

module.exports = {
  _daysAgoIso,
  _MESSAGE_TYPE_LABELS,
  _STATUS_TYPE_LABELS,
  _ROLE_LABELS,
  _num,
  _relativeTime,
  _appName,
  _buildUserMailFrom,
  _notifyUserAccountAction,
};
