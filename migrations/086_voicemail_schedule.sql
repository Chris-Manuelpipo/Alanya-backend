-- Migration 086 : `user_voicemail_schedule`, la planification du répondeur
--
-- Appliquer après 085. Application MANUELLE (pas de runner dans package.json),
-- réexécutable sans erreur (CREATE TABLE IF NOT EXISTS). Addition pure : aucun
-- code ne lit cette table avant le déploiement qui l'accompagne, donc elle peut
-- être posée des jours à l'avance.
--
-- ── Pourquoi une table et pas une colonne de plus sur `user_dnd_schedule` ──
--
-- Le « Ne pas déranger » de la migration 033 ne coupe QUE les notifications de
-- messages : `notifyIncomingCall` ne passe pas par `notificationFilter`, et un
-- appel sonne aujourd'hui même en plein créneau DND. C'est délibéré — un appel
-- peut être une urgence.
--
-- Greffer le répondeur sur le drapeau `user_dnd_schedule.enabled` aurait donc un
-- effet qu'aucun utilisateur n'a demandé : tous ceux qui ont déjà réglé
-- 22 h–7 h verraient, du jour au lendemain, leurs appels de nuit détournés vers
-- un répondeur. Deux fonctionnalités, deux interrupteurs. La FORME du créneau
-- est en revanche reprise telle quelle (mêmes colonnes, même convention de
-- bitmask), parce qu'elle a fait ses preuves.
--
-- ── `untilAt` : pourquoi une activation ponctuelle TOUJOURS datée ──
--
-- Un répondeur qu'on oublie d'éteindre est pire que pas de répondeur du tout :
-- l'utilisateur croit son téléphone joignable. L'activation rapide (« 1 h »,
-- « 4 h », « jusqu'à demain 8 h ») écrit donc toujours une échéance ; il n'y a
-- aucun mode « actif jusqu'à nouvel ordre ». La règle récurrente ci-dessus est
-- l'autre moitié du dispositif, et elle s'éteint d'elle-même chaque jour.
--
-- `untilAt` est un INSTANT ABSOLU, jamais une heure murale : le pool fixe
-- `timezone: 'Z'` (src/config/db.js), le client calcule l'échéance sur son
-- appareil et l'envoie en UTC, et la comparaison est un simple `untilAt > NOW()`.
-- Le chemin que la plupart des gens emprunteront est ainsi structurellement
-- insensible au fuseau. Une valeur passée vaut « inactif » : rien ne la purge,
-- il n'y a donc pas de tâche de ménage à écrire ni à surveiller.
--
-- ── `timezone` NULL par défaut : une cascade, pas une source unique ──
--
-- La règle récurrente, elle, est en heure murale et a besoin d'un fuseau.
-- `isDndActive` (033) s'appuie sur `now.getHours()`, c'est-à-dire l'heure LOCALE
-- DU SERVEUR : acceptable pour décaler une notification d'une heure,
-- inacceptable pour décider qu'un téléphone ne sonnera pas.
--
-- NULL n'est donc pas « pas de fuseau » mais « je n'ai rien de mieux que ce que
-- le compte dit déjà » : la lecture retombe sur `pays.timeZone` (via
-- `users.idPays`), qui contient de vrais identifiants IANA et que le backend
-- joint déjà partout — c'est le choix documenté par la migration 017. L'app
-- renseigne cette colonne quand elle connaît mieux (l'utilisateur voyage, ou son
-- compte est rattaché au mauvais pays) ; sinon elle ne l'écrit jamais et le
-- comportement reste correct.
--
-- ── `bypassListId` : l'exception, et ce qu'elle vaut quand elle disparaît ──
--
-- UNE liste de contacts (migration 038) peut être autorisée à faire sonner
-- malgré le répondeur. Une seule, pas plusieurs : le contrôle devient alors une
-- lecture de clé primaire sur `contact_list_member`, gratuite dans le chemin
-- critique de `call_user`. Qui veut un ensemble sur mesure crée une liste.
--
-- ON DELETE SET NULL, et pas CASCADE : supprimer la liste ne doit pas supprimer
-- la planification. Le répondeur retombe alors sur « personne ne passe », qui
-- est le défaut sûr — l'inverse rendrait tout le monde joignable sans que
-- personne ne l'ait demandé.

CREATE TABLE IF NOT EXISTS user_voicemail_schedule (
  alanyaID     INT              NOT NULL,
  enabled      TINYINT          NOT NULL DEFAULT 0
                                  COMMENT '1 = la règle récurrente ci-dessous s''applique',
  startTime    TIME             NOT NULL DEFAULT '22:00:00',
  endTime      TIME             NOT NULL DEFAULT '07:00:00',
  daysBitmask  TINYINT UNSIGNED NOT NULL DEFAULT 127
                                  COMMENT 'bit0=lundi … bit6=dimanche (127 = tous les jours), cf. migration 033',
  untilAt      DATETIME         NULL
                                  COMMENT 'Activation ponctuelle, en UTC. NULL ou passé = inactive. Jamais indéterminée.',
  timezone     VARCHAR(64)      NULL
                                  COMMENT 'Identifiant IANA. NULL = retomber sur pays.timeZone, puis env.TZ.',
  bypassListId BIGINT           NULL
                                  COMMENT 'Liste de contacts autorisée à faire sonner malgré le répondeur. NULL = personne.',
  updatedAt    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID),
  KEY idx_voicemail_bypass_list (bypassListId),
  CONSTRAINT fk_voicemail_schedule_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_voicemail_schedule_list FOREIGN KEY (bypassListId)
    REFERENCES contact_list(idList) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
