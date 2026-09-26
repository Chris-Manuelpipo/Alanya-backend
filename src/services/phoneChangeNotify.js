/**
 * L'e-mail qui confirme un changement de numéro Alanya.
 *
 * Le numéro est l'identifiant de connexion : un changement doit se voir
 * ailleurs que dans l'application, pour que le titulaire le retrouve même
 * s'il a oublié le nouveau — et le repère s'il ne l'a pas voulu.
 */

const { formatDisplay } = require('../utils/alanyaPhone');
const { sendMail, renderHtmlEmail, escapeHtml } = require('./mailService');

const appName = process.env.APP_NAME || 'Alanya';

const LEAD = {
  admin: 'Votre numéro Alanya a été modifié par un administrateur.',
  purchase: 'Vous avez choisi un nouveau numéro Alanya. C\'est lui qui sert désormais à vous connecter.',
};

/**
 * @param {object} p
 * @param {{ nom?: string, email?: string }} p.user
 * @param {string} p.oldPhone
 * @param {string} p.newPhone
 * @param {'admin'|'purchase'} p.origin
 */
async function mailPhoneChange({ user, oldPhone, newPhone, origin }) {
  if (!user?.email) return;
  const oldFmt = formatDisplay(oldPhone);
  const newFmt = formatDisplay(newPhone);
  const title = 'Numéro Alanya modifié';
  const subject = `${title} — ${appName}`;
  const lead = LEAD[origin] || LEAD.admin;
  const text =
    `Bonjour ${user.nom || 'utilisateur'},\n\n` +
    `${lead}\n\n` +
    `Ancien numéro : ${oldFmt}\n` +
    `Nouveau numéro : ${newFmt}\n`;
  const html = renderHtmlEmail({
    title: subject,
    preheader: `Nouveau numéro : ${newFmt}`,
    eyebrow: appName,
    heading: title,
    bodyHtml: `
      <p>Bonjour ${escapeHtml(user.nom || 'utilisateur')},</p>
      <p>${escapeHtml(lead)}</p>
      <p>Ancien : <strong>${escapeHtml(oldFmt)}</strong><br>Nouveau : <strong>${escapeHtml(newFmt)}</strong></p>`,
    accent: '#1f2937',
  });
  await sendMail({ to: user.email, subject, text, html });
}

module.exports = { mailPhoneChange };
