const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { REDIS_ENABLED } = require('../config/redis');
const { getDataClient } = require('../config/redisData');

// Contrôle de vie réel, destiné à une sonde externe interrogeant toutes les
// minutes. L'ancienne version renvoyait un statut fixe : une base injoignable
// laissait le serveur se déclarer sain, ce qui est exactement le cas qu'une
// supervision doit détecter.
//
// Réponse volontairement avare : la sonde est publique, elle n'a pas à
// apprendre la version du serveur, son nom d'hôte, ni le message d'erreur brut
// de MySQL — celui-ci nomme la base et l'utilisateur. Le détail exploitable
// vit derrière l'authentification admin.

// Au-delà, on considère la dépendance morte. Sans ce plafond, une base qui ne
// répond plus (par opposition à une base qui refuse la connexion) laisse la
// requête pendre : la sonde conclut alors à un dépassement de délai réseau vers
// le serveur, et non à une base en panne — le diagnostic serait faux.
//
// 5 s et non 2 s : la base est distante, et la toute première requête après un
// redémarrage paie l'établissement de la connexion. Mesuré sur la base de
// production : 1665 ms à froid, ~300 ms ensuite. Un plafond de 2 s tombait donc
// à pile ou face au premier passage de la sonde après chaque redéploiement, et
// aurait annoncé « dégradé » sur un serveur parfaitement sain — une fausse
// alerte coûte la crédibilité de toutes les suivantes.
//
// Le plafond ne concerne que l'hôte qui absorbe les paquets sans répondre : un
// refus de connexion revient en une dizaine de millisecondes. La sonde externe
// passant une fois par minute, 5 s de pire cas ne coûtent rien.
const DELAI_SONDE_MS = 5000;

// La sonde externe passe une fois par minute, mais rien n'empêche un second
// outil, un équilibreur de charge ou un curieux de marteler l'URL. Mémoïser
// évite qu'un contrôle de vie ne devienne lui-même une charge sur la base.
const FRAICHEUR_MS = 10_000;

let dernier = null; // { instant, corps, sain }

function avecDelai(promesse, etiquette) {
  return Promise.race([
    promesse,
    new Promise((_, rejeter) => {
      setTimeout(() => rejeter(new Error(`${etiquette}: délai dépassé`)), DELAI_SONDE_MS);
    }),
  ]);
}

async function sonder(etiquette, executer) {
  const debut = Date.now();
  try {
    await avecDelai(executer(), etiquette);
    return { etat: 'ok', ms: Date.now() - debut };
  } catch (e) {
    // Le message est journalisé, jamais renvoyé : il porte le nom de la base,
    // l'utilisateur et l'hôte.
    console.error(`[Health] ${etiquette} en échec:`, e.message);
    return { etat: 'ko', ms: Date.now() - debut };
  }
}

async function mesurer() {
  const dependances = {};

  dependances.mysql = await sonder('mysql', () => pool.query('SELECT 1'));

  if (REDIS_ENABLED) {
    const client = getDataClient();
    // `REDIS_ENABLED` dit que Redis est configuré ; `getDataClient()` dit s'il
    // a effectivement été connecté au démarrage. Les deux peuvent diverger le
    // temps que `start()` s'exécute — et un client absent alors que l'URL est
    // configurée est précisément une anomalie à signaler.
    dependances.redis = client
      ? await sonder('redis', () => client.ping())
      : { etat: 'ko', ms: 0 };
  }

  const sain = Object.values(dependances).every((d) => d.etat === 'ok');
  return { sain, corps: { status: sain ? 'ok' : 'degraded', dependances } };
}

router.get('/health', async (_req, res) => {
  const maintenant = Date.now();
  if (!dernier || maintenant - dernier.instant > FRAICHEUR_MS) {
    const { sain, corps } = await mesurer();
    dernier = { instant: maintenant, corps, sain };
  }
  res.status(dernier.sain ? 200 : 503).json({
    ...dernier.corps,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
