-- Migration 046 : réparation des boutons du message de bienvenue
--
-- La migration 042 utilisait LAST_INSERT_ID() après une insertion multi-lignes.
-- MySQL y renvoie l'identifiant de la PREMIÈRE ligne insérée, pas de la
-- dernière : les boutons ont donc été écrits sur le premier bloc *texte*, et le
-- bloc `cta` est resté à NULL.
--
-- Conséquence en production : `blockToMessagePayload` ne trouvait aucun bouton
-- et livrait `{"buttons":[]}`, affiché comme un bloc vide dans l'app.
--
-- 042 est corrigée pour les nouvelles installations ; cette migration répare
-- les bases où elle est déjà passée. Elle est idempotente et ne touche qu'aux
-- blocs manifestement mal remplis.

-- 1. Le bloc texte qui porte des boutons par erreur : on les lui retire.
UPDATE welcome_block
SET cta_json = NULL
WHERE block_type <> 'cta' AND cta_json IS NOT NULL;

-- 2. Les blocs CTA restés vides reçoivent les boutons par défaut.
UPDATE welcome_block
SET cta_json = JSON_OBJECT(
  'buttons', JSON_ARRAY(
    JSON_OBJECT('labelFr', 'Compléter mon profil', 'labelEn', 'Complete my profile', 'action', 'route', 'target', 'profile'),
    JSON_OBJECT('labelFr', 'Aide et FAQ', 'labelEn', 'Help and FAQ', 'action', 'route', 'target', 'help')
  )
)
WHERE block_type = 'cta' AND cta_json IS NULL;

-- 3. Les messages déjà livrés portent `{"buttons":[]}` et resteraient vides :
--    la livraison est unique, republier ne les rattrape pas. On réécrit leur
--    contenu à partir du bloc CTA de la configuration qui les a produits.
--
--    `clientID` a la forme `welcome:{config}:{utilisateur}:{ordre}` — on y
--    retrouve la configuration et le rang du bloc.
UPDATE message m
JOIN welcome_block wb
  ON wb.config_id  = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(m.clientID, ':', 2), ':', -1) AS UNSIGNED)
 AND wb.sort_order = CAST(SUBSTRING_INDEX(m.clientID, ':', -1) AS UNSIGNED)
 AND wb.block_type = 'cta'
SET m.content = JSON_OBJECT(
  'buttons',
  COALESCE(
    (SELECT JSON_ARRAYAGG(JSON_OBJECT(
       'label',  JSON_UNQUOTE(JSON_EXTRACT(b.btn, '$.labelFr')),
       'action', JSON_UNQUOTE(JSON_EXTRACT(b.btn, '$.action')),
       'target', JSON_UNQUOTE(JSON_EXTRACT(b.btn, '$.target'))
     ))
     FROM JSON_TABLE(
       wb.cta_json, '$.buttons[*]' COLUMNS (btn JSON PATH '$')
     ) AS b),
    JSON_ARRAY()
  )
)
WHERE m.type = 8
  AND m.clientID LIKE 'welcome:%'
  AND JSON_LENGTH(JSON_EXTRACT(m.content, '$.buttons')) = 0
  AND wb.cta_json IS NOT NULL;
