-- Migration 093 : le signalement porte son propre extrait
--
-- Appliquer après 092. Application MANUELLE, réexécutable (garde par
-- information_schema). AVANT le déploiement du code : `reportService` écrit
-- ces colonnes dès qu'un client les envoie, et la console de modération les
-- lit.
--
-- ── Le problème que ça résout ──
--
-- La file de modération affiche aujourd'hui `message.content` du message
-- signalé (`controllers/admin/reports.js`), et la recherche porte dessus.
-- Avec le chiffrement de bout en bout, il n'y a plus rien à lire : le texte
-- est dans un corps scellé que le serveur ne peut pas ouvrir, et c'est
-- précisément le but.
--
-- Sans ces colonnes, la modération des messages s'arrête net le jour où le
-- chiffrement s'allume. Pas « se dégrade » : s'arrête. Un signalement
-- arriverait avec un identifiant de message et rien d'autre, et la personne
-- qui modère devrait trancher sur la seule foi du motif choisi.
--
-- ── Qui fournit l'extrait, et pourquoi c'est acceptable ──
--
-- Le client de la personne qui signale. Elle a le message en clair sous les
-- yeux — c'est même pour ça qu'elle signale — et c'est le seul acteur, avec
-- l'auteur, à pouvoir le lire. En signalant, elle choisit délibérément de
-- montrer ce passage à la modération. C'est la même mécanique que chez
-- WhatsApp, et elle a une propriété qui compte : le serveur n'obtient le
-- clair QUE de ce qu'on lui a explicitement soumis, jamais de tout le fil.
--
-- ── Pourquoi un extrait de contexte, et pas le seul message ──
--
-- Un message seul se prête à tous les malentendus. « D'accord, je le fais »
-- n'a pas le même sens après une plaisanterie qu'après une menace. Les
-- messages qui précèdent sont ce qui permet de trancher autrement qu'au
-- hasard — et ils sont fournis par la même personne, dans le même geste.
--
-- ── Ce qui ne doit JAMAIS arriver ici ──
--
-- Le contenu déchiffré d'un message que personne n'a signalé. Ces colonnes
-- sont alimentées par la seule route de signalement, jamais par un chemin de
-- lecture. Elles sont de la donnée personnelle sensible : elles suivent la
-- rétention du signalement et disparaissent avec lui (la table `report` est
-- déjà en ON DELETE CASCADE sur les comptes).

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'report'
    AND COLUMN_NAME = 'target_excerpt');
SET @sql := IF(@has = 0, 'ALTER TABLE report
    -- Texte du message signalé, tel que la personne qui signale le voyait.
    -- 2000 caractères : un message long passe en entier, et ce qui dépasse
    -- est tronqué côté client (un extrait tronqué reste exploitable, un
    -- signalement refusé pour cause de longueur ne l''est pas).
    ADD COLUMN target_excerpt  TEXT         NULL
      COMMENT ''message signale, en clair, fourni par la personne qui signale'',
    -- Les messages qui précèdent, en JSON : [{ senderID, sendAt, text }].
    -- JSON et non du texte pré-rendu : la console doit pouvoir afficher qui a
    -- dit quoi et quand, et une transcription en prose figerait une mise en
    -- forme que personne ne pourrait plus défaire.
    ADD COLUMN context_excerpt JSON         NULL
      COMMENT ''messages precedents, fournis par la personne qui signale'',
    -- 1 quand le message signalé était chiffré. C''est ce qui dit à la
    -- console si l''absence d''extrait vient d''un client trop ancien (et
    -- alors `message.content` est encore lisible) ou d''un refus de fournir.
    ADD COLUMN target_was_encrypted TINYINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
