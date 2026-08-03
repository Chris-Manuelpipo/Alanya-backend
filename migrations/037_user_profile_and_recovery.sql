-- Migration 037 : profil démographique + code de récupération de compte
--
-- ⚠ ORDRE DE DÉPLOIEMENT — APPLIQUER CETTE MIGRATION AVANT DE DÉPLOYER LE CODE.
-- Les migrations n'ont pas de runner ici, elles s'appliquent à la main.
-- Réexécution : ignorer erreur 1060 (Duplicate column name).
--
-- Pourquoi ces colonnes :
--
-- genre / age            : déclarés par l'utilisateur à l'onboarding, facultatifs,
--                          et à ÉCRITURE UNIQUE — une fois renseignés ils ne sont
--                          plus modifiables (cf. updateMe, COALESCE).
-- annee_naissance        : DÉDUITE de `age` côté serveur (année courante - âge),
--                          donc approximative : on ne connaît pas la date exacte.
--                          Elle existe parce que `age` se périme d'année en année
--                          alors que l'année de naissance, elle, reste juste. Elle
--                          est ce qui permettra de rafraîchir l'âge de tout le
--                          monde une fois par an sans rien redemander :
--                            UPDATE users SET age = YEAR(NOW()) - annee_naissance
--                            WHERE annee_naissance IS NOT NULL;
-- ville                  : jamais déclarée — extraite de l'adresse IP via
--                          ipGeoService (ipwho.is) en arrière-plan à l'inscription
--                          et à la connexion. Reste NULL si l'IP est privée ou si
--                          le fournisseur est indisponible : c'est une donnée
--                          d'appoint, jamais une donnée dont dépend un parcours.
-- recovery_code_enc      : code de récupération de compte, CHIFFRÉ (AES-256-GCM,
--                          cf. src/services/recoveryCodeService.js). Il existe
--                          parce que l'e-mail est facultatif : sans lui, un compte
--                          sans e-mail dont le mot de passe est oublié est perdu,
--                          `forgot-password` n'interrogeant que users.email.
--                          Chiffré et non haché parce qu'il doit rester
--                          RECONSULTABLE par son propriétaire (Mon compte →
--                          Sécurité), contrairement à un mot de passe.
--                          Ce code ne change jamais, y compris après un
--                          changement ou une réinitialisation de mot de passe.

ALTER TABLE users
  ADD COLUMN genre             VARCHAR(20)       NULL,
  ADD COLUMN age               TINYINT UNSIGNED  NULL,
  ADD COLUMN annee_naissance   SMALLINT UNSIGNED NULL,
  ADD COLUMN ville             VARCHAR(120)      NULL,
  ADD COLUMN recovery_code_enc VARCHAR(255)      NULL;
