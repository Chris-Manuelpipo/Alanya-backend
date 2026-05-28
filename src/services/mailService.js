const nodemailer = require('nodemailer');

const fromEmail = process.env.SMTP_FROM;
const fromName = process.env.MAIL_FROM_NAME || 'Alanya';

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
  transporter,
  verifyTransporter,
};
