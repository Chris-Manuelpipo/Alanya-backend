-- Migration 085 : `userAccess.origine`, ce que la ligne raconte
--
-- Appliquer après 084. Application manuelle, comme toutes les migrations d'ici.
--
-- ⚠ ORDRE DE DÉPLOIEMENT — APPLIQUER CETTE MIGRATION AVANT DE DÉPLOYER LE CODE.
-- L'agrégat `devices` de l'écran Analytics filtre sur `origine` ; code déployé
-- sans la colonne = ER_BAD_FIELD_ERROR, et c'est TOUT /api/admin/analytics qui
-- tombe, pas seulement le camembert des systèmes.
--
-- MySQL 8 ne supporte pas `ADD COLUMN IF NOT EXISTS` (cf. migration 026) : si
-- relancée après un premier passage réussi, ignorer l'erreur 1060 (Duplicate
-- column name) à l'exécution.
--
-- ── Pourquoi une colonne plutôt qu'un préfixe ──
--
-- `userAccess` n'a jamais distingué ce qui l'alimente. Quand le verrouillage
-- d'appareil a eu besoin de tracer une tentative REFUSÉE, faute de colonne, la
-- distinction a été écrite dans le libellé : `device = 'REFUS appareil non
-- reconnu — …'`. Un contrat de chaîne de caractères, partagé entre l'écriture,
-- l'écran d'administration et désormais l'agrégat des analytics — qui casse en
-- silence le jour où quelqu'un retouche le libellé.
--
-- L'arrivée d'une deuxième catégorie (l'approbation par QR, jusqu'ici pas
-- tracée du tout) rendait le procédé intenable : il aurait fallu un second
-- préfixe et un second `LIKE`. La colonne dit la même chose une fois, dans le
-- schéma.
--
-- ── Pourquoi 'login' par défaut, et pourquoi maintenant ──
--
-- Les lignes déjà posées deviennent toutes 'login'. C'est exact pour la grande
-- majorité d'entre elles ; les inscriptions anciennes sont indiscernables
-- rétroactivement et ce n'est pas grave, une inscription EST une première
-- connexion. Ce qui comptait, c'est qu'il n'y ait aucune ligne de refus à
-- reclasser : le verrouillage d'appareil n'a jamais été armé en production
-- (`security_settings` n'y existe pas encore), donc zéro ligne mal classée.
-- La colonne arrive avant la première tentative refusée, pas après.
--
-- ── Pourquoi pas d'index ──
--
-- La table tient dans quelques centaines de lignes, tenue par la purge à
-- 90 jours de dataRetentionService. Le `GROUP BY` des analytics reste un scan
-- de plage sur `idx_useraccess_datelogin` ; `origine` n'y est qu'un filtre
-- appliqué aux lignes déjà lues.

ALTER TABLE userAccess
  ADD COLUMN origine ENUM('login','inscription','qr','recovery','refus')
    NOT NULL DEFAULT 'login'
    COMMENT 'Ce qui a produit la ligne ; refus = tentative rejetée, pas une connexion'
    AFTER os_system;
