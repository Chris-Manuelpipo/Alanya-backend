/**
 * Garde de couverture — `node src/utils/errorCodeCoverage.test.js`.
 *
 * Deux invariants, issus de l'audit des erreurs de 09/2026 :
 *
 * 1. **Toute réponse 4xx/5xx porte un `code`.** Sans lui, l'application ne peut
 *    distinguer les cas qu'en lisant la prose de `error` — c'est ce qui la
 *    conduisait à afficher cette prose, écrite en français et jamais traduite.
 * 2. **Aucun message d'exception ne part au client.** Un `err.message` de
 *    driver nomme les tables et les colonnes ; il appartient aux journaux.
 *
 * Le test lit les sources plutôt que d'appeler les routes : il n'a besoin ni de
 * base, ni de serveur, et couvre les 62 contrôleurs d'un coup.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let ok = 0;
const test = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

const RACINE = path.join(__dirname, '..');

/** Tous les .js de `src/`, tests exclus. */
function sources() {
  const out = [];
  (function marcher(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) marcher(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
    }
  })(RACINE);
  return out.sort();
}

// `.set()`, `.type()` ou `.header()` peuvent s'intercaler entre `status` et
// `json` — parfois sur plusieurs lignes. Sans cette tolérance, la réponse
// « média expiré » échappait au garde, et c'est ainsi qu'elle est restée sans
// code jusqu'au recoupement avec le catalogue de l'application.
const APPEL = /res\s*\.\s*status\(\s*(\d{3})\s*\)\s*(?:\.\s*(?:set|type|header|append|links|vary|cookie)\([^;]*?\)\s*)*?\.\s*json\(/g;

/**
 * Isole le bloc `res.status(N).json({ … })` en équilibrant les parenthèses.
 *
 * Une simple expression régulière ne suffit pas : beaucoup de réponses tiennent
 * sur plusieurs lignes, et leur `code` est alors sur une autre ligne que le
 * `res.status(...)`.
 */
function blocsErreur(src) {
  const blocs = [];
  APPEL.lastIndex = 0;
  let m;
  while ((m = APPEL.exec(src)) !== null) {
    const statut = Number(m[1]);
    if (statut < 400) continue;
    let prof = 0;
    let j = APPEL.lastIndex - 1;
    for (; j < src.length; j += 1) {
      if (src[j] === '(') prof += 1;
      else if (src[j] === ')') {
        prof -= 1;
        if (prof === 0) break;
      }
    }
    blocs.push({
      statut,
      texte: src.slice(m.index, j + 1),
      ligne: src.slice(0, m.index).split('\n').length,
    });
  }
  return blocs;
}

const fichiers = sources();

test('des sources sont bien analysées', () => {
  assert.ok(fichiers.length > 50, `seulement ${fichiers.length} fichiers trouvés`);
});

test('toute réponse 4xx/5xx porte un code', () => {
  const fautifs = [];
  for (const f of fichiers) {
    const src = fs.readFileSync(f, 'utf8');
    for (const b of blocsErreur(src)) {
      if (/\bcode\s*:/.test(b.texte)) continue;
      const rel = path.relative(RACINE, f);
      fautifs.push(`  src/${rel}:${b.ligne} [${b.statut}] ${b.texte.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepStrictEqual(
    fautifs,
    [],
    `${fautifs.length} réponse(s) d'erreur sans code :\n${fautifs.join('\n')}\n\n`
      + "Ajouter un `code:` stable, ou passer par fail(res, statut, code, message)\n"
      + 'de src/utils/apiError.js. Catalogue : docs/error-codes.md.'
  );
});

test("aucun message d'exception ne part au client", () => {
  // `err.message` dans un corps de réponse. Les journaux ne sont pas concernés :
  // c'est justement là que le détail doit aller.
  const fuite = /res\s*\.\s*status\(\s*\d{3}\s*\)\s*\.\s*json\(\s*\{[^}]*\b(?:err|error|e|ex)\s*\.\s*message\b/;
  const fautifs = [];
  for (const f of fichiers) {
    const src = fs.readFileSync(f, 'utf8');
    for (const b of blocsErreur(src)) {
      if (!fuite.test(b.texte)) continue;
      // Exception admise : une erreur de validation posée volontairement, dont
      // la prose est écrite pour être lue.
      if (/VALIDATION_FAILED|INVALID_EXTENSION/.test(b.texte)) continue;
      const rel = path.relative(RACINE, f);
      fautifs.push(`  src/${rel}:${b.ligne} ${b.texte.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepStrictEqual(
    fautifs,
    [],
    `${fautifs.length} réponse(s) exposant un message d'exception :\n${fautifs.join('\n')}\n\n`
      + 'Journaliser le détail (console.error) et répondre par failInternal(res).'
  );
});

test('les codes respectent la forme MAJUSCULES_SOULIGNÉES', () => {
  // Un code est un contrat : `code: 'notFound'` et `code: 'NOT_FOUND'` sont
  // deux codes différents pour l'application, et l'un des deux est un oubli.
  const decl = /\bcode\s*:\s*'([^']+)'/g;
  const fautifs = [];
  for (const f of fichiers) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    decl.lastIndex = 0;
    while ((m = decl.exec(src)) !== null) {
      const code = m[1];
      // Les codes de driver et de plateforme lus (non émis) sont hors sujet.
      if (/^(ER_|LIMIT_FILE_SIZE$)/.test(code)) continue;
      if (!/^[A-Z][A-Z0-9_]*$/.test(code)) {
        const ligne = src.slice(0, m.index).split('\n').length;
        fautifs.push(`  src/${path.relative(RACINE, f)}:${ligne} → '${code}'`);
      }
    }
  }
  assert.deepStrictEqual(fautifs, [], `Codes mal formés :\n${fautifs.join('\n')}`);
});

console.log(`errorCodeCoverage : ${ok} tests passés`);
