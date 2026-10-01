const providers = require('./mailProviders');
const fs = require('fs');
const path = require('path');

// Adresse d'envoi : MAIL_FROM, ou SMTP_FROM pour les anciennes installations.
// Chez Postmark et Bird, elle doit appartenir à un domaine/expéditeur vérifié.
const fromEmail = process.env.MAIL_FROM || process.env.SMTP_FROM;
const fromName = process.env.MAIL_FROM_NAME || 'Alanya';
const appName = process.env.APP_NAME || 'Alanya';
const logoUrl = process.env.LOGO_URL || '';
const baseTemplatePath = path.join(__dirname, '..', 'templates', 'email-template.html');
const baseTemplate = fs.readFileSync(baseTemplatePath, 'utf8');

// Ordre d'essai : le premier qui accepte le message gagne, les suivants ne
// servent qu'en cas d'échec. MAIL_PROVIDERS=postmark,bird (défaut) ; `smtp`
// reste disponible pour revenir à l'ancien envoi.
const providerChain = () =>
  (process.env.MAIL_PROVIDERS || 'postmark,bird')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
    .map((n) => providers[n])
    .filter((p) => p && p.send && p.isConfigured());

const isConfigured = () => providerChain().length > 0;

const defaultFrom = () =>
  fromEmail ? (fromName ? `"${fromName}" <${fromEmail}>` : fromEmail) : undefined;

if (!isConfigured()) {
  console.warn('mailService: aucun fournisseur configuré (POSTMARK_SERVER_TOKEN / BIRD_API_KEY)');
}

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
  supportEmail = process.env.SUPPORT_EMAIL || fromEmail || '',
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
  const mailFrom = from || defaultFrom();
  if (!mailFrom) throw new Error("L'adresse email d'envoi est requise (MAIL_FROM dans .env)");

  const chain = providerChain();
  if (chain.length === 0) throw new Error("Le service email n'est pas configuré");

  const errors = [];
  for (const provider of chain) {
    try {
      const info = await provider.send({ from: mailFrom, to, subject, text, html });
      if (errors.length > 0) {
        console.warn(`[mailService] envoyé par ${provider.name} après échec de : ${errors.map((e) => e.message).join(' ; ')}`);
      }
      return { provider: provider.name, ...info };
    } catch (err) {
      console.error(`[mailService] ${provider.name} a échoué:`, err && err.message ? err.message : err);
      errors.push(err);
    }
  }
  const e = new Error(`Échec de l'envoi : ${errors.map((x) => x.message).join(' ; ')}`);
  e.causes = errors;
  throw e;
};

module.exports = {
  sendMail,
  renderHtmlEmail,
  escapeHtml,
  isConfigured,
  defaultFrom,
};
