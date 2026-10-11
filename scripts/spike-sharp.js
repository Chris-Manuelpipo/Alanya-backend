/**
 * Spike T0 — `sharp` convient-il au pipeline d'upload des stickers ?
 *
 * Vérifie sur les 83 stickers fournis et sur des cas hostiles fabriqués :
 *   décodage PNG/WebP, 512×512, canal alpha, ré-encodage WebP avec perte,
 *   boucle de qualité vers ≤ 100 Ko, métadonnées retirées, rejet des fichiers
 *   corrompus, WebP animé.
 *
 * Usage : node scripts/spike-sharp.js <dossier stickers-export>
 * (`sharp` doit être résoluble : `npm i sharp` ou NODE_PATH.)
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BUDGET = 100 * 1024;
const QUALITES = [90, 80, 70, 60, 50, 40, 30];

async function reencoder(buf) {
  const img = sharp(buf, { animated: false, limitInputPixels: 4096 * 4096 });
  const meta = await img.metadata();
  if (meta.width !== 512 || meta.height !== 512) throw new Error(`dimensions ${meta.width}x${meta.height}`);
  if (!meta.hasAlpha) throw new Error('pas de canal alpha');
  for (const q of QUALITES) {
    // Sans withMetadata() : EXIF/XMP/ICC ne sont pas recopiés.
    const out = await sharp(buf).webp({ quality: q, alphaQuality: 100, effort: 4 }).toBuffer();
    if (out.length <= BUDGET) return { out, q };
  }
  throw new Error('budget 100 Ko inatteignable');
}

(async () => {
  const racine = process.argv[2];
  const res = { ok: 0, ko: [], plusLourd: 0 };
  for (const pack of fs.readdirSync(racine)) {
    const d = path.join(racine, pack);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.webp'))) {
      try {
        const { out, q } = await reencoder(fs.readFileSync(path.join(d, f)));
        res.ok++; res.plusLourd = Math.max(res.plusLourd, out.length);
        if (q < 90) console.log(`  ${pack}/${f}: qualité ${q}`);
      } catch (e) { res.ko.push(`${pack}/${f}: ${e.message}`); }
    }
  }
  console.log('stickers fournis :', res);

  // Cas fabriqués
  const cas = {};
  const base = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } });
  const png = await base.clone().png().toBuffer();
  cas.png_accepte = (await reencoder(png)).out.length;
  const exif = await base.clone().withExif({ IFD0: { Copyright: 'SECRET-GPS' } }).png().toBuffer();
  const sortie = (await reencoder(exif)).out;
  cas.metadonnees_retirees = !sortie.includes(Buffer.from('SECRET-GPS')) && !(await sharp(sortie).metadata()).exif;
  const bruit = Buffer.alloc(512 * 512 * 4); for (let i = 0; i < bruit.length; i++) bruit[i] = (i * 2654435761) >>> 24;
  const lourd = await sharp(bruit, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
  try { cas.bruit = (await reencoder(lourd)).q; } catch (e) { cas.bruit = 'rejet : ' + e.message; }
  for (const [nom, b] of Object.entries({
    corrompu: Buffer.concat([png.subarray(0, 80), Buffer.from('xxxx')]),
    faux_png: Buffer.from('GIF89a....'),
    mauvaise_taille: await sharp({ create: { width: 500, height: 512, channels: 4, background: '#0000' } }).png().toBuffer(),
    sans_alpha: await sharp({ create: { width: 512, height: 512, channels: 3, background: '#fff' } }).png().toBuffer(),
  })) { try { await reencoder(b); cas[nom] = 'ACCEPTÉ (anormal)'; } catch (e) { cas[nom] = 'rejeté : ' + e.message.slice(0, 40); } }
  // WebP animé : lecture et métadonnées de pages
  try {
    const frames = [];
    for (let i = 0; i < 3; i++) frames.push(await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: i * 80, g: 0, b: 0, alpha: 1 } } }).raw().toBuffer());
    const anim = await sharp(Buffer.concat(frames), { raw: { width: 64, height: 64 * 3, channels: 4, pageHeight: 64 } }).webp({ loop: 0, delay: [100, 100, 100] }).toBuffer();
    const m = await sharp(anim, { animated: true }).metadata();
    cas.webp_anime = `pages=${m.pages} delai=${m.delay}`;
  } catch (e) { cas.webp_anime = 'KO ' + e.message; }
  console.log('cas fabriqués :', cas);
})();
