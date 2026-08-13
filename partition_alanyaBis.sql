Étape 1 : Activer l'Event Scheduler de MySQLPar défaut, le planificateur de tâches de MySQL peut être désactivé. 
Vous devez vous assurer qu'il est actif.
Exécutez cette commande SQL :

SET GLOBAL event_scheduler = ON;

(Pour que ce paramètre persiste après un redémarrage de MySQL, ajoutez event_scheduler=ON dans votre fichier de configuration my.cnf ou my.ini).

Étape 2 : Créer la Procédure Stockée (Stored Procedure)
Cette procédure calcule dynamiquement les dates. Elle crée la partition pour le jour suivant (Aujourd'hui + 2 jours pour la limite supérieure LESS THAN) 
et supprime celle d'il y a 31 jours.

DELIMITER $$

CREATE PROCEDURE manage_message_partitions()
BEGIN
    DECLARE target_date_create DATE;
    DECLARE target_date_drop DATE;
    DECLARE partition_name_create VARCHAR(30);
    DECLARE partition_name_drop VARCHAR(30);
    DECLARE max_value_date VARCHAR(30);

    -- 1. Définition des dates cibles
    SET target_date_create = DATE_ADD(CURDATE(), INTERVAL 2 DAY);
    SET target_date_drop = DATE_SUB(CURDATE(), INTERVAL 31 DAY);

    -- 2. Génération des noms de partitions (Format: pYYYY_MM_DD)
    SET partition_name_create = CONCAT('p', DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '%Y_%m_%d'));
    SET partition_name_drop = CONCAT('p', DATE_FORMAT(target_date_drop, '%Y_%m_%d'));
    SET max_value_date = DATE_FORMAT(target_date_create, '%Y-%m-%d 00:00:00');

    -- 3. AJOUT DE LA NOUVELLE PARTITION
    -- On utilise du SQL dynamique car les noms de partitions ne peuvent pas être des variables directes
    SET @alter_sql = CONCAT('ALTER TABLE messages REORGANIZE PARTITION p_future INTO (',
                            'PARTITION ', partition_name_create, ' VALUES LESS THAN (\'', max_value_date, '\'), ',
                            'PARTITION p_future VALUES LESS THAN (MAXVALUE));');
    
    PREPARE stmt_create FROM @alter_sql;
    EXECUTE stmt_create;
    DEALLOCATE PREPARE stmt_create;

    -- 4. SUPPRESSION DE LA VIEILLE PARTITION
    -- On vérifie d'abord si la partition existe pour éviter de faire planter le script
    IF EXISTS (
        SELECT 1 FROM information_schema.partitions 
        WHERE table_schema = DATABASE() 
          AND table_name = 'messages' 
          AND partition_name = partition_name_drop
    ) THEN
        SET @drop_sql = CONCAT('ALTER TABLE messages DROP PARTITION ', partition_name_drop, ';');
        PREPARE stmt_drop FROM @drop_sql;
        EXECUTE stmt_drop;
        DEALLOCATE PREPARE stmt_drop;
    END IF;

END$$

DELIMITER ;

Étape 3 : Créer l'Événement Planifié (Event)Maintenant que la logique est prête, on programme MySQL pour qu'il 
l'exécute automatiquement tous les jours à 01h00 du matin.

CREATE EVENT IF NOT EXISTS event_daily_partition_maintenance
ON SCHEDULE EVERY 1 DAY
STARTS TIMESTAMP(CURRENT_DATE, '01:00:00')
DO
    CALL manage_message_partitions();
	
	
	Comment vérifier que tout fonctionne ?Pour vous assurer que vos tâches s'exécutent bien et voir 
	vos partitions actuelles, vous pouvez lancer cette requête de contrôle :

SELECT partition_name, partition_expression, table_rows 
FROM information_schema.partitions 
WHERE table_schema = DATABASE() AND table_name = 'messages';


Pour maximiser la vitesse des recherches sur une table partitionnée de 5 millions d'utilisateurs, 
vous devez comprendre une règle fondamentale de MySQL : l'index doit être conçu pour pousser MySQL
 à faire du Partition Pruning (l'élagage de partitions). Cela signifie que MySQL doit savoir instantanément
 dans quel "tiroir quotidien" chercher, sans avoir à scanner les 30 partitions de la base.Voici la stratégie
 d'indexation chirurgicale pour votre modèle.
 
 1. L'Indexation de la table messagesAvec le partitionnement par date, la clé primaire composite obligatoire est :
 
 PRIMARY KEY (conversation_id, message_id, created_at)
 
 MySQL crée automatiquement un index sur cette clé. Cet index unique est d'une efficacité redoutable pour deux scénarios critiques :

Cas A : Charger les derniers messages d'une conversation

Lorsque l'utilisateur ouvre sa discussion, l'application demande les messages 
de la conversation 55 pour les dernières 24 heures

SELECT message_id, sender_id, message_text, created_at 
FROM messages 
WHERE conversation_id = 55 
  AND created_at >= '2026-07-27 00:00:00'
ORDER BY message_id DESC 
LIMIT 20;

Cas B : Récupérer un message spécifique (Lien de notification)
Si un utilisateur clique sur une notification pour voir un message précis.

SELECT message_text, sender_id 
FROM messages 
WHERE conversation_id = 55 
  AND message_id = 98451
  AND created_at = '2026-07-28 10:14:00';

Piège à éviter : Si vous oubliez de fournir le created_at dans votre code applicatif, MySQL devra fouiller 
dans les 30 partitions pour trouver le message_id, ce qui ralentira la requête par 30. 
Passez toujours la date du message dans vos requêtes de recherche directe.

2. L'Indexation de la table conversation_members

Cette table gère l'affichage de la liste des discussions de l'utilisateur 
(la page d'accueil de l'application). C'est un goulot d'étranglement fréquent.

ALTER TABLE conversation_members 
ADD PRIMARY KEY (user_id, conversation_id),
ADD INDEX idx_conversation_id (conversation_id);

3. L'Indexation de la table conversation_status (Statuts de lecture)
Pour afficher les badges de messages non lus (ex: "5 messages non lus"), 
l'application interroge cette table en boucle.

ALTER TABLE conversation_status 
ADD PRIMARY KEY (user_id, conversation_id);

Pourquoi aucun autre index n'est requis : L'application cherche toujours le statut pour un utilisateur précis 
dans une conversation précise. La clé primaire composite couvre 100 % des besoins de lecture et d'écriture (INSERT ... ON DUPLICATE KEY UPDATE).

Toujours mettre les id unsigned