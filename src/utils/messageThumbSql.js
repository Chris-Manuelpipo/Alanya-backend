/**
 * Expression SELECT de la vignette d'un message, à réutiliser partout où une
 * ligne `message` est rendue au client.
 *
 * `TO_BASE64` seul ne suffit pas : MySQL insère un saut de ligne tous les 76
 * caractères. Or `base64Decode` côté Dart refuse tout caractère hors alphabet
 * et lève une `FormatException` — une vignette dépassant 76 caractères, c'est
 * à dire n'importe laquelle, arrivait donc illisible et l'application la
 * laissait tomber en silence (`[VideoThumb] base64 invalide`). L'aperçu
 * instantané avant téléchargement ne fonctionnait pas.
 *
 * Le nettoyage se fait ici plutôt que côté application pour que toute lecture
 * rende la même forme que l'envoi temps réel de `message:send`, qui relaie le
 * base64 du client d'un seul tenant. Sans cela, une resynchronisation écraserait
 * une vignette qui s'affichait par une chaîne que le client ne sait pas lire.
 */
const MEDIA_THUMB_SELECT = "REPLACE(TO_BASE64(mt.thumb), '\\n', '') AS mediaThumb";

module.exports = { MEDIA_THUMB_SELECT };
