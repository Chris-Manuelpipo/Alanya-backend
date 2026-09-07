-- Migration 079 : journal des délivrances de clé de sauvegarde
--
-- `GET /api/backup/key` est le point d'accès le plus sensible du serveur : la
-- clé qu'il rend déchiffre la sauvegarde d'un compte. La conception l'assume
-- explicitement — le chiffrement n'est pas de bout en bout, et cet arbitrage
-- doit figurer dans la politique de confidentialité — mais elle l'assortit
-- d'une contrepartie : que chaque délivrance laisse une trace.
--
-- Cette trace existait, sous forme de `console.log`. Elle vivait donc dans la
-- sortie du serveur, hors de portée du panneau d'administration, et disparaissait
-- à la rotation des journaux. La différence entre « un abus laisse une trace
-- quelque part » et « un abus est constatable » est exactement celle-là.
--
-- ── Pourquoi une table dédiée, et non `admin_audit` ──
--
-- `admin_audit` journalise des gestes rares et délibérés : bannir, supprimer,
-- diffuser. Ici, chaque inscrit demande sa clé à chaque sauvegarde et à chaque
-- restauration. À mille comptes en sauvegarde hebdomadaire, cela ferait des
-- milliers de lignes de routine par mois dans un écran conçu pour rendre
-- lisibles quelques dizaines d'actions d'administrateurs. Le journal noierait
-- ce qu'il est censé montrer.

CREATE TABLE IF NOT EXISTS backup_key_access (
  id          BIGINT       NOT NULL AUTO_INCREMENT,

  -- Le compte dont la clé a été demandée. Le contrôleur dérive toujours la clé
  -- de l'appelant authentifié : personne ne peut demander celle d'un autre.
  -- La colonne sert donc à répondre à « qui a demandé la sienne, et quand ».
  --
  -- ON DELETE CASCADE : un compte supprimé emporte ses traces. Ce n'est pas un
  -- journal d'imputabilité comme `admin_audit` — c'est une donnée personnelle
  -- de plus, et la conserver après effacement du compte serait une faute.
  alanya_id   INT          NOT NULL,

  -- Version de clé demandée. NULL sur `/backup/key` (version courante),
  -- renseignée sur `/backup/key/:kid` — c'est-à-dire lors d'une restauration.
  kid         INT UNSIGNED NULL,

  -- `servie` ou `refusee`. Un refus compte autant qu'une délivrance : une série
  -- de refus est le premier signe d'un secret mal déployé.
  outcome     VARCHAR(16)  NOT NULL,

  -- Renseigné sur un refus seulement, et jamais avec le corps de la requête.
  reason      VARCHAR(160) NULL,

  ip          VARCHAR(64)  NULL,
  device_id   VARCHAR(64)  NULL COMMENT 'appareil déclaré par le jeton, s''il y en a un',
  user_agent  VARCHAR(255) NULL,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- « Tout ce qui concerne ce compte, du plus récent au plus ancien » : la
  -- question posée depuis la fiche d'un inscrit.
  KEY idx_bka_account (alanya_id, id),

  -- La purge balaie par date ; sans cet index elle parcourrait toute la table.
  KEY idx_bka_created (created_at),

  CONSTRAINT fk_bka_user FOREIGN KEY (alanya_id)
    REFERENCES users (alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
