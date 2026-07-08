# Migration 015 — Numéros réservés (patterns)

Exécuter **après** `010_reserved_alanya_phone.sql` :

```bash
node scripts/seed-reserved-alanya-phones.js
```

## Contenu inséré

| Catégorie | Volume |
|-----------|--------|
| Tous les numéros à 3 chiffres | 1 000 |
| Tous les numéros à 4 chiffres | 10 000 |
| 8 chiffres, positions paires égales (`d0 X d0 X d0 X d0 X`) | 100 000 |
| **Total** | **111 000** |

Les doublons éventuels (ex. `000`, `0000`, `00000000` de la migration 010) sont mis à jour via `ON DUPLICATE KEY UPDATE`.

## Comportement applicatif

- Inscription utilisateur : génération **8 chiffres uniquement** (numéros non réservés).
- Admins et super-admins : peuvent attribuer un numéro réservé libre à un utilisateur.
