-- 055 — Sonneries de liste synchronisées entre les appareils d'un compte
--
-- La sélection de sonnerie d'une liste (son de message + sonnerie d'appel)
-- vivait uniquement dans les SharedPreferences de l'appareil qui l'avait
-- faite. Elle devient une préférence DU COMPTE : chaque appareil connecté la
-- récupère avec les listes elles-mêmes (GET /contact-lists).
--
-- Deux natures de son, d'où la colonne `*_type` :
--   builtin → `*_id` est l'identifiant stable d'un son fourni avec l'app
--             (`notif_pop`, `bundled_son3`, `__system_default__`). Le fichier
--             existe sur TOUS les appareils : rien d'autre à transporter.
--   custom  → `*_id` est le SHA-256 (hex, 64) du CONTENU du fichier importé
--             par l'utilisateur. Le fichier audio, lui, N'EST PAS envoyé au
--             serveur et reste local. Un appareil qui possède un fichier de
--             même hash rejoue exactement le même son ; sinon il retombe sur
--             son de remplacement SANS que la préférence soit effacée — elle
--             se rebranchera toute seule le jour où le fichier sera importé.
--             `*_name` ne sert QU'À L'AFFICHAGE (« MaSonnerie.mp3 ») : deux
--             fichiers de même nom et de contenu différent sont deux sons
--             différents, seul le hash fait foi.
--   NULL    → liste jamais configurée (distinct de « explicitement système »,
--             qui vaut builtin/__system_default__).
--
-- sound_priority : rang de la liste dans l'arbitrage « un contact appartient à
-- plusieurs listes, laquelle sonne ? ». Synchronisé lui aussi, sinon deux
-- appareils bien synchronisés sur les sons pouvaient encore diverger sur le
-- son joué pour un contact multi-listes. NULL = jamais ordonnée (passe après
-- les listes ordonnées, dans l'ordre d'affichage habituel).
--
-- ⚠ Migrations appliquées À LA MAIN (pas de runner) : exécuter ce SQL AVANT de
-- déployer le code — contactListController lit ces colonnes.

ALTER TABLE contact_list
  ADD COLUMN msg_sound_type  ENUM('builtin','custom') NULL DEFAULT NULL AFTER member_limit,
  ADD COLUMN msg_sound_id    VARCHAR(80)              NULL DEFAULT NULL AFTER msg_sound_type,
  ADD COLUMN msg_sound_name  VARCHAR(120)             NULL DEFAULT NULL AFTER msg_sound_id,
  ADD COLUMN call_sound_type ENUM('builtin','custom') NULL DEFAULT NULL AFTER msg_sound_name,
  ADD COLUMN call_sound_id   VARCHAR(80)              NULL DEFAULT NULL AFTER call_sound_type,
  ADD COLUMN call_sound_name VARCHAR(120)             NULL DEFAULT NULL AFTER call_sound_id,
  ADD COLUMN sound_priority  INT                      NULL DEFAULT NULL AFTER call_sound_name;
