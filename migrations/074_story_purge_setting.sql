-- Migration 074 : la purge des stories devient une purge à part entière
--
-- Jusqu'ici, la suppression des stories expirées (`statut`) était une cible
-- parmi sept dans la « Rétention générale » (`data_retention`) : historique
-- d'appels, journal de connexions, jobs en échec, appareils révoqués, jetons
-- push, OTP. Un seul interrupteur pour l'ensemble, et aucune durée réglable.
--
-- Deux conséquences, l'une visible et l'autre pas :
--
--  1. L'écran Analytics annonce « Stories publiées — cette période » pour des
--     fenêtres de 30, 90 ou 365 jours, alors qu'une story expire 24 h après sa
--     publication et disparaît 7 jours plus tard. Passé ~8 jours, il ne reste
--     rien à compter : le chiffre est le même quelle que soit la période
--     choisie. La table n'a d'ailleurs qu'une seule ligne à ce jour.
--  2. Desserrer cette fenêtre pour retrouver de l'historique imposait de
--     cesser aussi de purger les appels et les connexions — deux sujets qui
--     n'ont rien à voir : l'un est un arbitrage éditorial, l'autre une
--     question d'exploitation.
--
-- `story` reçoit donc son propre interrupteur et sa propre durée de rétention
-- (surcharge `retentionDays`, défaut 7 jours, bornée 1–365 par le registre).
--
-- Elle exclut les stories d'accueil, qui gardent leur purge `welcome_status` :
-- sans cette exclusion, couper l'une n'empêcherait pas l'autre de supprimer
-- les mêmes lignes, et l'interrupteur ne voudrait rien dire.
--
-- `story` HÉRITE de l'état de `data_retention` plutôt que de démarrer active :
-- c'est là que vivait la suppression des stories jusqu'ici, donc c'est cet
-- interrupteur-là qui décrit le comportement en cours. Insérer `enabled = 1`
-- en dur rallumerait la purge sur toute installation où la rétention générale
-- avait été coupée — une suppression définitive relancée par une migration,
-- exactement ce que l'interrupteur de la migration 068 servait à éviter.
--
-- Le COALESCE couvre l'installation neuve, où `data_retention` n'a pas encore
-- de ligne : absence de ligne = purge active, on démarre donc à 1.
--
-- La sous-requête est agrégée (MAX) pour deux raisons : elle rend exactement
-- une ligne même quand `data_retention` est absente, et sa matérialisation
-- lève l'interdiction MySQL de lire la table visée par l'INSERT.
--
-- Avec la durée qui était figée dans le SQL (7 jours), cette migration ne
-- change donc à elle seule aucun comportement.

INSERT IGNORE INTO purge_settings (name, enabled)
SELECT 'story', COALESCE(src.enabled, 1)
  FROM (SELECT MAX(enabled) AS enabled
          FROM purge_settings
         WHERE name = 'data_retention') AS src;
