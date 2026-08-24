/**
 * Exécution de scripts Lua Redis — un seul aller-retour réseau, atomique côté
 * serveur par construction (Redis sérialise l'exécution des scripts). Préféré
 * à WATCH/MULTI/EXEC pour tous les CAS de cette phase : pas de boucle de
 * retry applicative à écrire/maintenir. `redis` v4 expose `.eval()`
 * nativement, aucune dépendance supplémentaire.
 *
 * Pas de scriptLoad/EVALSHA ici : le volume actuel ne justifie pas cette
 * micro-optimisation réseau (un script Lua envoyé à chaque appel plutôt que
 * son SHA1 mis en cache côté serveur).
 */
async function runScript(client, script, keys, args = []) {
  return client.eval(script, {
    keys,
    arguments: args.map((a) => String(a)),
  });
}

module.exports = { runScript };
