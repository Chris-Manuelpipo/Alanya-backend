-- Seed villes principales (exemple Cameroun idPays=5 — ajuster selon référentiel pays)
INSERT IGNORE INTO ville (libelle, libelle_norm, idPays) VALUES
  ('Douala', 'douala', 5),
  ('Yaoundé', 'yaounde', 5),
  ('Bafoussam', 'bafoussam', 5);
