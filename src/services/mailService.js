const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const fromEmail = process.env.SMTP_FROM;
const fromName = process.env.MAIL_FROM_NAME || 'Alanya';
const appName = process.env.APP_NAME || 'Alanya';
const logoUrl = process.env.LOGO_URL || '';
const baseTemplatePath = path.join(__dirname, '..', 'templates', 'email-template.html');
const baseTemplate = fs.readFileSync(baseTemplatePath, 'utf8');

if (!process.env.SMTP_HOST) {
  console.warn('mailService: SMTP_HOST not configured');
}

const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER && process.env.SMTP_PASS
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

const verifyTransporter = async () => {
  try {
    await transporter.verify();
    console.info('mailService: transporter verified');
  } catch (err) {
    console.warn('mailService: transporter verification failed:', err && err.message ? err.message : err);
  }
};

// Verify in background
verifyTransporter();

const escapeHtml = (value) => {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const renderHtmlEmail = ({
  title,
  preheader = '',
  eyebrow = appName,
  heading,
  intro,
  bodyHtml = '',
  accent = '#1f2937',
  footerNote = 'Cet email est envoyé automatiquement, merci de ne pas y répondre.',
  supportEmail = process.env.SUPPORT_EMAIL || process.env.SMTP_FROM || '',
  ctaLabel = '',
  ctaUrl = '',
}) => {
  const withLogo = Boolean(logoUrl);
  const withIntro = Boolean(intro);
  const withCta = Boolean(ctaLabel && ctaUrl);
  const withSupport = Boolean(supportEmail);

  const html = baseTemplate
    .replace(/\{\{#ifLogo\}\}([\s\S]*?)\{\{\/ifLogo\}\}/g, withLogo ? '$1' : '')
    .replace(/\{\{#ifIntro\}\}([\s\S]*?)\{\{\/ifIntro\}\}/g, withIntro ? '$1' : '')
    .replace(/\{\{#ifCta\}\}([\s\S]*?)\{\{\/ifCta\}\}/g, withCta ? '$1' : '')
    .replace(/\{\{#ifSupport\}\}([\s\S]*?)\{\{\/ifSupport\}\}/g, withSupport ? '$1' : '')
    .replace(/\{\{appName\}\}/g, escapeHtml(appName))
    .replace(/\{\{logoUrl\}\}/g, escapeHtml(logoUrl))
    .replace(/\{\{title\}\}/g, escapeHtml(title))
    .replace(/\{\{preheader\}\}/g, escapeHtml(preheader))
    .replace(/\{\{eyebrow\}\}/g, escapeHtml(eyebrow))
    .replace(/\{\{heading\}\}/g, escapeHtml(heading))
    .replace(/\{\{intro\}\}/g, intro)
    .replace(/\{\{bodyHtml\}\}/g, bodyHtml)
    .replace(/\{\{accent\}\}/g, escapeHtml(accent))
    .replace(/\{\{footerNote\}\}/g, escapeHtml(footerNote))
    .replace(/\{\{supportEmail\}\}/g, escapeHtml(supportEmail))
    .replace(/\{\{ctaLabel\}\}/g, escapeHtml(ctaLabel))
    .replace(/\{\{ctaUrl\}\}/g, escapeHtml(ctaUrl));

  return html;
};

const sendMail = async ({ from, to, subject, text, html }) => {
  const mailFrom = from || (fromName ? `"${fromName}" <${fromEmail}>` : fromEmail);
  if (!mailFrom) throw new Error('L\'adresse email d\'envoi est requise (SMTP_FROM dans .env)');

  try {
    const info = await transporter.sendMail({
      from: mailFrom,
      to,
      subject,
      text,
      html,
    });
    return info;
  } catch (err) {
    console.error('[mailService] sendMail error:', err);
    throw err;
  }
};

module.exports = {
  sendMail,
  renderHtmlEmail,
  escapeHtml,
  transporter,
  verifyTransporter,
};
