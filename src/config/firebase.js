// Configuration et initialisation de Firebase Admin SDK pour les notifications push
const admin = require('firebase-admin');

// Sous test, on n'initialise pas le SDK. Il ouvre des connexions HTTP/2 qui
// restent vivantes, et le seul fait de charger un handler d'appel suffisait
// alors à empêcher le processus de rendre la main — c'est la véritable cause de
// l'entrée C6 de l'audit, qu'on croyait due à des minuteries restées armées.
// Les deux appelants du SDK testent déjà `admin.apps.length` avant d'envoyer
// quoi que ce soit : sans app, ils passent leur tour proprement.
if (process.env.NODE_ENV === 'test') {
  console.log('[Firebase] Admin SDK non initialisé (NODE_ENV=test)');
} else if (!admin.apps.length) {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT manquant dans .env');
    }

    const serviceAccount = JSON.parse(raw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log('[Firebase] Admin SDK initialisé avec succès');
  } catch (err) {
    console.error('[Firebase] Échec initialisation:', err.message); 
  }
}

module.exports = admin;