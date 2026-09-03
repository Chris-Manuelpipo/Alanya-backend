-- Migration 076 : index pour la garde d'échéance et le balayage des réunions
--
-- ── Le défaut ──
-- La table `meeting` n'a, depuis la 001, aucun index sur `start_time` ni sur
-- `room`. Les seuls présents sont la clé primaire, l'index implicite de la
-- contrainte `fk_meeting_organiser`, et `idx_reminder_sent (reminder_sent, isEnd)`
-- posé par la 002.
--
-- Tant que rien ne lisait la table autrement que par son identifiant, c'était
-- sans conséquence. Deux chemins neufs changent ça :
--
--   · le balayage des réunions échues, qui tourne toutes les 60 secondes et
--     filtre sur `isEnd = 0 AND DATE_ADD(start_time, INTERVAL duree MINUTE) < …`
--     (src/services/meetingClosure.js) ;
--   · `GET /meetings/by-room/:room`, désormais gardée par une vérification
--     d'appartenance qui résout d'abord la réunion par son code de salon.
--
-- Sans ces index, le premier fait un parcours complet chaque minute, et le
-- second un parcours complet à chaque appel.
--
-- ── Les lignes déjà écrites ──
-- Aucune n'est modifiée : cette migration ne touche que le schéma.
--
-- ── Rejouabilité ──
-- MySQL 8 ne connaît pas `ADD KEY IF NOT EXISTS`. Les deux blocs ci-dessous
-- consultent `information_schema` et ne font rien si l'index est déjà posé,
-- ce qui rend la migration rejouable telle quelle.

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'meeting'
         AND INDEX_NAME = 'idx_meeting_isend_start'
    ),
    'SELECT ''idx_meeting_isend_start déjà présent''',
    'ALTER TABLE meeting ADD KEY idx_meeting_isend_start (isEnd, start_time)'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'meeting'
         AND INDEX_NAME = 'idx_meeting_room'
    ),
    'SELECT ''idx_meeting_room déjà présent''',
    'ALTER TABLE meeting ADD KEY idx_meeting_room (room, isEnd)'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
