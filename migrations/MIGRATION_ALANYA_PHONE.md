# Migration AlanyaPhone 3 / 4 / 8

Exécuter **offline** (maintenance) dans l'ordre :

```bash
mysql -u USER -p DATABASE < migrations/009_alanya_phone_pad_6_to_8.sql
mysql -u USER -p DATABASE < migrations/010_reserved_alanya_phone.sql
# Si un ancien seed bulk a rempli la table :
node scripts/cleanup-bulk-reserved-alanya-phones.js
```

Voir aussi `migrations/015_reserved_alanya_phone_patterns.md` (patterns en code + liste admin manuelle).

## Vérifications post-migration

```sql
-- Aucun numéro hors longueurs 3, 4 ou 8
SELECT alanyaPhone, LENGTH(alanyaPhone) AS len FROM users
WHERE LENGTH(alanyaPhone) NOT IN (3, 4, 8);

-- Exemple : 482917 → 00482917
SELECT alanyaPhone FROM users WHERE alanyaPhone LIKE '%482917%';
```

## Déploiement

1. Backend (API + utilitaire `alanyaPhone.js`)
2. Talky + alanya-admin
3. Tester création admin, login formaté, numéros réservés

Variables optionnelles :

- `AVATAR_DEFAULT_MALE` — URL avatar homme
- `AVATAR_DEFAULT_FEMALE` — URL avatar femme
