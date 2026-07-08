# Numéros réservés — patterns + liste admin

## Règles (en code, pas en bulk SQL)

Un numéro est **réservé pour l’inscription auto** s’il matche :

| Règle | Exemples |
|-------|----------|
| 3 chiffres | `007`, `123` |
| 4 chiffres | `1234`, `0000` |
| 8 chiffres `XXYYZZTT` | `11223344`, `00001122`, `99887766` |

Implémentation : `isPatternReserved` dans `src/utils/alanyaPhone.js`, utilisé par `isReserved` / `generateUniquePhone`.

## Table `reserved_alanya_phone`

Contient **uniquement** les numéros que l’admin ajoute explicitement (avec libellé), pour les lister / attribuer. L’ajout exige que le numéro respecte les patterns ci-dessus.

## Migration depuis un ancien seed bulk

Si la table contient encore ~20k–100k lignes auto-insérées :

```bash
node scripts/cleanup-bulk-reserved-alanya-phones.js
```

Supprime les lignes avec `created_by IS NULL` (seed), conserve les ajouts manuels admin.

## Comportement

- Inscription : génère un 8 chiffres **hors** pattern et **hors** table admin.
- Admin : peut ajouter / retirer des entrées dans la liste (pattern obligatoire).
- Admin / super-admin : peuvent attribuer un numéro de la liste à un compte.
