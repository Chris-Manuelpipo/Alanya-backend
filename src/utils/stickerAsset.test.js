/**
 * Pipeline d'upload des stickers — `node src/utils/stickerAsset.test.js`.
 * Pur : ni base, ni Redis, ni stockage. Les images sont fabriquées par `sharp`.
 */
const assert = require('assert');
const sharp = require('sharp');
const {
  LIMITES, StickerAssetError, mimeAccepte, reencoder, preparerAsset,
} = require('./stickerAsset');

const carre = (w, h, canaux = 4, alpha = 0.5) => sharp({
  create: { width: w, height: h, channels: canaux, background: { r: 200, g: 30, b: 30, alpha } },
});

async function refuse(promesse, code, motif) {
  try {
    await promesse;
  } catch (e) {
    assert.ok(e instanceof StickerAssetError, `${motif} : mauvaise classe d'erreur (${e.message})`);
    assert.strictEqual(e.code, code, motif);
    return e;
  }
  assert.fail(`${motif} : accepté à tort`);
  return null;
}

(async () => {
  const png = await carre(512, 512).png().toBuffer();

  // ── Entrées valides : PNG et WebP ─────────────────────────────────────────
  {
    const r = await reencoder(png);
    assert.strictEqual(r.width, 512);
    assert.ok(r.bytes <= LIMITES.SORTIE_MAX_OCTETS, 'sous le budget de 100 Ko');
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    const m = await sharp(r.webp).metadata();
    assert.strictEqual(m.format, 'webp');
    assert.ok(m.hasAlpha, 'la transparence survit au ré-encodage');
    const t = await sharp(r.thumb).metadata();
    assert.strictEqual(`${t.width}x${t.height}`, '96x96');

    const webp = await carre(512, 512).webp().toBuffer();
    assert.strictEqual((await reencoder(webp)).width, 512, 'WebP accepté en entrée');
    // Déterministe : même entrée, même empreinte (déduplication par propriétaire).
    assert.strictEqual((await reencoder(png)).sha256, r.sha256);
  }

  // ── Faux Content-Type : ce que disent les octets l'emporte ───────────────
  assert.ok(mimeAccepte('image/png') && mimeAccepte('IMAGE/WEBP'));
  assert.ok(!mimeAccepte('image/gif') && !mimeAccepte('image/svg+xml') && !mimeAccepte(undefined));
  await refuse(reencoder(Buffer.from('GIF89a\x01\x00\x01\x00')), 'STICKER_ASSET_INVALID', 'GIF déclaré PNG');
  await refuse(
    reencoder(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512"/></svg>')),
    'STICKER_ASSET_INVALID', 'SVG refusé en V1a',
  );
  await refuse(reencoder(await carre(512, 512).jpeg().toBuffer()), 'STICKER_ASSET_INVALID', 'JPEG (pas de format PNG/WebP)');
  await refuse(reencoder(await carre(512, 512).gif().toBuffer()), 'STICKER_ASSET_INVALID', 'GIF réel');

  // ── Fichiers corrompus ───────────────────────────────────────────────────
  await refuse(reencoder(Buffer.alloc(0)), 'STICKER_ASSET_INVALID', 'vide');
  await refuse(reencoder(null), 'STICKER_ASSET_INVALID', 'pas un tampon');
  await refuse(reencoder(Buffer.concat([png.subarray(0, 80), Buffer.from('xxxx')])), 'STICKER_ASSET_INVALID', 'PNG tronqué');
  const webp = await carre(512, 512).webp().toBuffer();
  const abime = Buffer.from(webp);
  abime.fill(0xff, 40, Math.min(abime.length, 200));
  await refuse(reencoder(abime), 'STICKER_ASSET_INVALID', 'WebP corrompu');
  await refuse(reencoder(webp.subarray(0, 30)), 'STICKER_ASSET_INVALID', 'WebP tronqué');

  // ── Dimensions et alpha ──────────────────────────────────────────────────
  await refuse(reencoder(await carre(500, 512).png().toBuffer()), 'STICKER_ASSET_INVALID', '500x512');
  await refuse(reencoder(await carre(1024, 1024).png().toBuffer()), 'STICKER_ASSET_INVALID', '1024x1024');
  await refuse(reencoder(await carre(512, 512, 3).png().toBuffer()), 'STICKER_ASSET_INVALID', 'sans alpha');

  // ── Poids : entrée > 1 Mo, et sortie qui ne tient pas dans 100 Ko ────────
  await refuse(reencoder(Buffer.alloc(LIMITES.ENTREE_MAX_OCTETS + 1, 1)), 'STICKER_ASSET_INVALID', 'entrée > 1 Mo');
  {
    // Bruit aléatoire sur 2 bits par canal : un PNG sous 1 Mo, mais dont le
    // WebP ne tient pas dans 100 Ko, même à qualité 30.
    const bruit = require('crypto').randomBytes(512 * 512 * 4);
    for (let i = 0; i < bruit.length; i++) bruit[i] &= 0xc0;
    const lourd = await sharp(bruit, { raw: { width: 512, height: 512, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    assert.ok(lourd.length < LIMITES.ENTREE_MAX_OCTETS, `précondition : entrée ${lourd.length} o < 1 Mo`);
    const e = await refuse(reencoder(lourd), 'STICKER_ASSET_INVALID', 'bruit incompressible');
    assert.ok(/lourd/.test(e.message), `message attendu sur le poids : ${e.message}`);
  }

  // ── Métadonnées retirées ─────────────────────────────────────────────────
  {
    const piege = await carre(512, 512).withExif({ IFD0: { Copyright: 'SECRET-GPS-42' } }).png().toBuffer();
    assert.ok((await sharp(piege).metadata()).exif, 'précondition : le fichier piégé porte de l\'EXIF');
    const r = await reencoder(piege);
    assert.ok(!r.webp.includes(Buffer.from('SECRET-GPS-42')), 'la valeur EXIF a disparu des octets');
    const m = await sharp(r.webp).metadata();
    assert.ok(!m.exif && !m.xmp && !m.icc, 'ni EXIF, ni XMP, ni ICC en sortie');
  }

  // ── Animé refusé en V1a ──────────────────────────────────────────────────
  {
    // `sharp` 0.33 n'assemble pas d'animation depuis des tampons bruts : le
    // conteneur WebP animé (VP8X + ANIM + ANMF) est écrit à la main.
    const chunk = (tag, data) => {
      const h = Buffer.alloc(8);
      h.write(tag, 0, 'ascii');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, Buffer.alloc(data.length % 2)]);
    };
    const u24 = (n) => { const b = Buffer.alloc(3); b.writeUIntLE(n, 0, 3); return b; };
    const animer = (frames, cote) => {
      const anmf = frames.map((f) => {
        const parts = [];
        for (let pos = 12; pos < f.length;) {
          const tag = f.toString('ascii', pos, pos + 4);
          const len = f.readUInt32LE(pos + 4);
          const pad = len + (len % 2);
          if (['VP8 ', 'VP8L', 'ALPH'].includes(tag)) parts.push(f.subarray(pos, pos + 8 + pad));
          pos += 8 + pad;
        }
        const entete = Buffer.concat([u24(0), u24(0), u24(cote - 1), u24(cote - 1), u24(100), Buffer.from([0])]);
        return chunk('ANMF', Buffer.concat([entete, ...parts]));
      });
      const corps = Buffer.concat([
        Buffer.from('WEBP'),
        chunk('VP8X', Buffer.concat([Buffer.from([0x12, 0, 0, 0]), u24(cote - 1), u24(cote - 1)])),
        chunk('ANIM', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0])])),
        ...anmf,
      ]);
      const riff = Buffer.alloc(8);
      riff.write('RIFF', 0);
      riff.writeUInt32LE(corps.length, 4);
      return Buffer.concat([riff, corps]);
    };
    for (const cote of [64, 512]) {
      const images = [];
      for (let i = 0; i < 2; i++) {
        images.push(await carre(cote, cote, 4, 0.5).modulate({ hue: i * 90 }).webp({ lossless: true }).toBuffer());
      }
      const anime = animer(images, cote);
      assert.strictEqual((await sharp(anime).metadata()).pages, 2, 'précondition : WebP animé valide');
      const e = await refuse(reencoder(anime), 'STICKER_ASSET_INVALID', `WebP animé ${cote}x${cote}`);
      if (cote === 512) assert.ok(/anim/.test(e.message), `refus motivé par l'animation : ${e.message}`);
    }
  }

  // ── Étape 4 : liste de blocage (par empreinte) et quotas ─────────────────
  {
    const { sha256 } = await reencoder(png);
    const bloque = new Set([sha256]);
    const deps = { estBloque: async (h) => bloque.has(h) };
    await refuse(preparerAsset(png, { ownerId: 12 }, deps), 'STICKER_ASSET_BLOCKED', 'empreinte bloquée');
    // Même image, autre propriétaire : bloquée aussi (le blocage est global).
    await refuse(preparerAsset(png, { ownerId: 99 }, deps), 'STICKER_ASSET_BLOCKED', 'autre compte');
    // Une autre image passe.
    const autre = await carre(512, 512, 4, 0.9).png().toBuffer();
    assert.ok((await preparerAsset(autre, { ownerId: 12 }, deps)).sha256 !== sha256);

    const quota = (assets, h) => ({ usage: async () => ({ assets, uploadsDerniereHeure: h }) });
    await preparerAsset(png, { ownerId: 12 }, quota(LIMITES.ASSETS_PAR_COMPTE - 1, 0));
    await refuse(preparerAsset(png, { ownerId: 12 }, quota(LIMITES.ASSETS_PAR_COMPTE, 0)), 'STICKER_QUOTA_EXCEEDED', 'quota 200');
    await refuse(preparerAsset(png, { ownerId: 12 }, quota(0, LIMITES.UPLOADS_PAR_HEURE)), 'STICKER_QUOTA_EXCEEDED', 'quota horaire');
    // L'officiel n'a pas de quota, et n'appelle même pas la lecture d'usage.
    let appels = 0;
    await preparerAsset(png, { ownerId: 0 }, { usage: async () => { appels++; return { assets: 9999, uploadsDerniereHeure: 9999 }; } });
    assert.strictEqual(appels, 0, 'owner 0 : aucune lecture de quota');
  }

  // Statuts du contrat (fixtures/erreurs.json)
  assert.strictEqual(new StickerAssetError('X', 'x', 422).status, 422);

  console.log('stickerAsset.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
