-- Migration 087 : le répondeur entre au catalogue des fonctionnalités
--
-- Appliquer après 086. Application MANUELLE, réexécutable sans erreur
-- (INSERT IGNORE), sur le modèle des seeds de la migration 080.
--
-- ── Déclarée, mais GRATUITE ──
--
-- `is_paid = 0` — la colonne existe précisément pour ça : « gratuite pour
-- tous, même en phase payante » (080). Le répondeur ne se paie pas
-- aujourd'hui, et aucun `requireFeature` ne garde ses routes.
--
-- Pourquoi la déclarer alors. Parce que la décision « payant ou gratuit » se
-- prend en connaissant l'usage, et que l'usage ne se mesure qu'une fois la
-- fonctionnalité livrée. Poser la ligne maintenant, c'est s'épargner une
-- migration le jour où la réponse sera connue : il suffira de basculer
-- `is_paid` depuis le back-office, sans toucher au schéma ni au code.
--
-- ── Le jour où le verrou viendra ──
--
-- Il ira sur le PATCH du réglage, et sur lui seul. Jamais sur le GET, jamais
-- dans `call_user`. Un abonnement expiré qui rallumerait les sonneries sans
-- prévenir serait déjà désagréable ; un abonnement expiré qui continuerait
-- d'intercepter sans que l'utilisateur puisse l'éteindre serait un dégât sans
-- commune mesure avec l'enjeu de revenu.

INSERT IGNORE INTO feature (code, name_i18n, description_i18n, is_paid, is_available, sort_order) VALUES
  ('voicemail',
   JSON_OBJECT('fr', 'Répondeur', 'en', 'Voicemail', 'zh', '语音信箱'),
   JSON_OBJECT('fr', 'Sur les créneaux choisis, le téléphone ne sonne pas et l''appelant laisse un message',
               'en', 'During the hours you choose, your phone stays silent and callers leave a message',
               'zh', '在您选择的时段内手机不会响铃，来电者可留言'),
   0, 1, 70);
