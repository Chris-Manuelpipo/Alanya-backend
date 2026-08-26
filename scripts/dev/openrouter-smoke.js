/**
 * Smoke-test de l'assistance éditoriale — un vrai aller-retour OpenRouter,
 * sans DB, sans Firebase, sans serveur HTTP.
 *
 * Ce que les tests unitaires ne peuvent pas dire : la clé est-elle valable, le
 * modèle configuré existe-t-il, et surtout — tient-il la consigne ? La qualité
 * d'une traduction ne s'assert pas ; elle se lit. Ce script la met sous les
 * yeux, avec les deux vérifications mécaniques qui, elles, se tranchent :
 * le balisage a-t-il survécu, et le chinois est-il bien du chinois.
 *
 * Prérequis : OPENROUTER_API_KEY dans .env (ou dans l'environnement).
 * Usage :
 *   node scripts/dev/openrouter-smoke.js
 *   OPENROUTER_MODEL=qwen/qwen-2.5-72b-instruct node scripts/dev/openrouter-smoke.js
 *
 * Comparer deux modèles avant de trancher, c'est deux exécutions et un
 * coup d'œil — c'est tout l'intérêt de passer par OpenRouter.
 */

require('dotenv').config();

const {
  translateContent,
  reviewContent,
  isConfigured,
} = require('../../src/services/ai/editorialAssist');
const { currentModel } = require('../../src/services/ai/openrouter');

// Volontairement piégeux : du balisage collé au texte, un émoji, un nom de
// marque, une URL. C'est là que les modèles faibles se voient — ils
// « nettoient » les astérisques ou traduisent « Alanya ».
const SOURCE = 'Bienvenue sur *Alanya* 👋\n'
  + 'Votre compte est prêt. _Complétez votre profil_ pour être retrouvé par vos proches.\n'
  + 'Besoin d\'aide ? https://www.alanya237.com/aide';

const MARQUEURS = ['*', '_'];

function compteMarqueur(texte, marqueur) {
  return texte.split(marqueur).length - 1;
}

async function main() {
  if (!isConfigured()) {
    console.error('✗ OPENROUTER_API_KEY absente — rien à tester.');
    process.exit(1);
  }

  console.log(`Modèle : ${currentModel()}\n`);
  console.log('── Source (fr) ──');
  console.log(SOURCE);

  const t0 = Date.now();
  const { translations, missing, notes } = await translateContent({
    content: SOURCE,
    kind: 'welcome',
    sourceLocale: 'fr',
  });
  console.log(`\n── Traductions (${Date.now() - t0} ms) ──`);

  let echecs = 0;

  for (const [locale, texte] of Object.entries(translations)) {
    console.log(`\n[${locale}]`);
    console.log(texte);

    // Le balisage doit arriver en nombre pair et identique à la source :
    // un marqueur perdu produit un texte juste et un rendu faux, et ça ne se
    // voit qu'après publication.
    for (const m of MARQUEURS) {
      const attendu = compteMarqueur(SOURCE, m);
      const obtenu = compteMarqueur(texte, m);
      if (obtenu !== attendu) {
        console.log(`  ✗ balisage « ${m} » : ${obtenu} au lieu de ${attendu}`);
        echecs++;
      }
    }
    if (!texte.includes('Alanya')) {
      console.log('  ✗ le nom de marque « Alanya » a été traduit ou perdu');
      echecs++;
    }
    if (!texte.includes('https://www.alanya237.com/aide')) {
      console.log('  ✗ l\'URL n\'est pas revenue intacte');
      echecs++;
    }
    if (locale === 'zh' && !/[一-鿿]/.test(texte)) {
      console.log('  ✗ le chinois ne contient aucun caractère han');
      echecs++;
    }
    if (locale === 'en' && /[一-鿿]/.test(texte)) {
      console.log('  ✗ des caractères han se sont glissés dans l\'anglais');
      echecs++;
    }
  }

  if (missing.length) console.log(`\n⚠ langues non rendues : ${missing.join(', ')}`);
  if (notes.length) console.log(`\nRemarques du modèle :\n  - ${notes.join('\n  - ')}`);

  // Second aller-retour : la relecture doit savoir ne rien trouver. Un modèle
  // qui invente des remarques sur son propre texte rendra la fonction
  // inutilisable — on l'apprend ici, pas en production.
  const t1 = Date.now();
  const { findings } = await reviewContent({
    translations: { fr: SOURCE, ...translations },
    kind: 'welcome',
  });
  console.log(`\n── Relecture (${Date.now() - t1} ms) — ${findings.length} remarque(s) ──`);
  for (const f of findings) {
    console.log(`  [${f.locale}] ${f.severity} : ${f.message}`);
  }

  console.log(
    echecs === 0
      ? '\n✓ Contraintes de forme tenues. La justesse du sens, elle, se lit ci-dessus.'
      : `\n✗ ${echecs} contrainte(s) de forme non tenue(s) — essayez un autre modèle.`,
  );
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`✗ ${e.status || ''} ${e.message}`);
  process.exit(1);
});
