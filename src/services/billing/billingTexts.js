/**
 * Textes de l'abonnement qui annoncent une date et un prix : fonctions pures,
 * sans notification ni base, pour être testées seules.
 *
 * Le prix n'est JAMAIS écrit en dur : il vient du plan vendu, que le
 * super-admin règle. Un tarif qui change doit changer ces annonces avec lui.
 */

const { BILLING_MODEL } = require('../../constants/billing');

const TZ = 'Africa/Douala';

/** « 17 novembre 2026 » (ou la langue demandée). */
function fmtDay(d, locale = 'fr-FR') {
  return new Date(d).toLocaleDateString(locale, {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ,
  });
}

/** « 1 000 F » : francs CFA, groupés à la manière de la langue. */
function fmtAmount(amount, locale = 'fr-FR') {
  return `${Math.round(Number(amount)).toLocaleString(locale)} F`;
}

const LOCALES = { fr: 'fr-FR', en: 'en-GB', zh: 'zh-CN' };

/**
 * L'annonce faite à tous quand le payant s'allume (compte officiel).
 *
 * @param {{ model: number, graceUntil: Date|string, price: number }} p
 * @returns {{ fr: string, en: string, zh: string }}
 */
function graceText({ model, graceUntil, price }) {
  const d = (l) => fmtDay(graceUntil, LOCALES[l]);
  const p = (l) => fmtAmount(price, LOCALES[l]);
  if (Number(model) === BILLING_MODEL.TRIAL) {
    return {
      fr: `Alanya devient payant. Vous gardez tout gratuitement jusqu'au ${d('fr')}. Ensuite, vous recevrez toujours vos messages et vos appels, mais il faudra un abonnement d'un an (${p('fr')}) pour envoyer des messages et appeler. Payez sur le site, puis entrez le code reçu dans l'application : vous pouvez le faire dès maintenant, votre année commencera à la fin de la période gratuite.`,
      en: `Alanya is becoming paid. Everything stays free until ${d('en')}. After that, you will still receive your messages and calls, but you will need a one-year subscription (${p('en')}) to send messages and make calls. Pay on the website, then enter the code you receive in the app: you can do it right now, your year will start when the free period ends.`,
      zh: `Alanya 即将收费。在 ${d('zh')} 之前一切仍然免费。之后您仍可接收消息和来电，但发送消息和拨打电话需要订阅一年（${p('zh')}）。请在网站付款，然后在应用中输入收到的代码：现在就可以操作，您的一年将从免费期结束时开始。`,
    };
  }
  return {
    fr: `Alanya Plus arrive. Jusqu'au ${d('fr')}, traduction, sauvegarde, trajets de confiance et sonneries par liste restent gratuits. Ensuite, ils rejoignent l'offre annuelle à ${p('fr')}, qui inclut aussi la coche « Abonné Alanya Plus ». Abonnez-vous dès maintenant depuis votre profil : votre première période et votre coche commencent à cette date.`,
    en: `Alanya Plus is coming. Until ${d('en')}, translation, backup, trusted trips and list ringtones stay free. Then they join the yearly offer at ${p('en')}, which also includes the “Alanya Plus subscriber” badge. Subscribe now from your profile: your first period and badge start on that date.`,
    zh: `Alanya Plus 即将推出。在 ${d('zh')} 之前，翻译、备份、可信行程和列表铃声仍然免费。之后它们将纳入每年 ${p('zh')} 的方案，并附带「Alanya Plus 订阅用户」标记。现在即可在个人资料中订阅：您的第一个周期和标记将从该日期开始。`,
  };
}

/** Le rappel collectif, sept jours avant la fin de la grâce. */
function graceReminderText({ model, graceUntil, price }) {
  const d = (l) => fmtDay(graceUntil, LOCALES[l]);
  const p = (l) => fmtAmount(price, LOCALES[l]);
  if (Number(model) === BILLING_MODEL.TRIAL) {
    return {
      fr: `Plus que 7 jours : à partir du ${d('fr')}, il faudra un abonnement (${p('fr')} / an) pour envoyer des messages et appeler. Vous continuerez à tout recevoir. Déjà abonné ? Rien à faire.`,
      en: `7 days left: from ${d('en')}, you will need a subscription (${p('en')} / year) to send messages and make calls. You will still receive everything. Already subscribed? Nothing to do.`,
      zh: `还剩 7 天：自 ${d('zh')} 起，发送消息和拨打电话需要订阅（每年 ${p('zh')}）。您仍可接收一切。已经订阅？无需任何操作。`,
    };
  }
  return {
    fr: `Plus que 7 jours : à partir du ${d('fr')}, traduction, sauvegarde, trajets et sonneries par liste font partie d'Alanya Plus (${p('fr')} / an, avec la coche). Déjà abonné ? Rien à faire.`,
    en: `7 days left: from ${d('en')}, translation, backup, trips and list ringtones will be part of Alanya Plus (${p('en')} / year, with the badge). Already subscribed? Nothing to do.`,
    zh: `还剩 7 天：自 ${d('zh')} 起，翻译、备份、行程和列表铃声将属于 Alanya Plus（每年 ${p('zh')}，含标记）。已经订阅？无需任何操作。`,
  };
}

module.exports = {
  fmtDay, fmtAmount, graceText, graceReminderText,
};
