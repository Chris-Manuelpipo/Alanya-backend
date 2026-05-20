# Meeting E2E Checklist (Etape 6)

Objectif: valider en conditions reelles les correctifs meeting (video distante, leave, disconnect brutal, auto-end).

## Prerequis

- Backend lance avec logs visibles.
- Deux appareils (A et B) connectes avec deux comptes differents.
- Une reunion video (type_media = 0).

## Commandes utiles

Lancer le serveur:

```bash
npm run dev
```

Verifier l'etat d'un meeting en base:

```bash
npm run meeting:state -- <meetingId>
```

## Scenario 1 - Join normal et video bilaterale

1. A cree la reunion et rejoint.
2. B rejoint la meme reunion.
3. Verifier sur A et B:
   - audio OK
   - video locale OK
   - video distante OK
4. Logs attendus cote frontend:
   - onTrack <- kind=video streams>=0
   - addTrack offer/answer kind=video

## Scenario 2 - Leave explicite d'un participant

1. A et B sont connectes au meme meeting.
2. B appuie sur quitter.
3. Verifier:
   - A recoit meeting:user_left.
   - Le tile video de B disparait.
   - meeting:ended NE DOIT PAS etre emis si A est encore connecte.
4. Verifier DB:
   - B connecte = 0
   - A connecte = 1

## Scenario 3 - Disconnect brutal

1. A et B dans la meme reunion.
2. B force-ferme l'application (kill process / swipe app).
3. Verifier:
   - A recoit meeting:user_left.
   - B passe a connecte = 0 en base.
   - Pas de peer stale cote A.

## Scenario 4 - Auto-end quand plus personne

1. A et B connectes au meeting.
2. B quitte puis A quitte (ou force-close).
3. Verifier:
   - Le backend emet meeting:ended.
   - meeting.isEnd = 1 en base.
   - Tous les participants connecte = 0.

## Scenario 5 - Meeting audio-only

1. Creer une reunion avec type_media = 1.
2. Verifier:
   - Pas de bouton camera / switch camera.
   - Pas de demande permission camera.
   - Audio bidirectionnel OK.

## Requete SQL de controle rapide

```sql
SELECT idMeeting, isEnd, type_media, room FROM meeting WHERE idMeeting = ?;
SELECT IDparticipant, connecte, status, duree FROM participant WHERE idMeeting = ?;
```

## Criteres de validation

- Aucun cas "audio OK / video KO" sur reunion video stable.
- Leave explicite et disconnect brutal produisent le meme resultat fonctionnel.
- Aucun meeting ne reste actif en base quand tous les participants sont sortis.
