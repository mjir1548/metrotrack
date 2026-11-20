# MetroTrack — Journal de suivi et de passation

Ce fichier est tenu à jour par l'orchestrateur (Claude Code) **après chaque action significative**.
Il sert à reprendre le travail depuis une autre session ou un autre compte Claude Code.

> **Pour un Claude qui reprend le projet** :
> 1. Lis ce fichier en entier, puis `CLAUDE.md`, puis `docs/decisions.md`, `docs/protocole.md` et `docs/cadrage.md`.
> 2. Tu es l'orchestrateur décrit dans `CLAUDE.md` §9. Reprends à la section « Où on en est » ci-dessous.
> 3. Continue à tenir ce fichier à jour à chaque étape (ajoute une entrée datée dans « Historique »).

Dernière mise à jour : 2026-11-17

---

## Où on en est

- **Phase 0 (cadrage)** : terminée et validée.
- **Étape 1 (squelette : un scan simulé met à jour la localisation)** : terminée, commitée (`2aea8e8`).
- **Étape 2 (HTTPS)** : terminée, commitée (voir `git log`).
  - Implémentée et vérifiée par le testeur (2 écarts corrigés).
  - Revue sécurité, 1er passage : « À corriger », sans bloquant. Deux points importants : `.gitattributes` pour `*.sh` (fins de ligne LF) et limite de connexions (`maxConnections = 256`, une saturation ne doit pas arrêter le serveur). S'y ajoutent des suggestions TLS et `devcert.sh` : renégociation et tickets désactivés, journal des erreurs TLS, `umask`, `trap`, contrainte de nom sur la CA de dev.
  - Correctifs appliqués par `dev` (aller-retour 2/3), 75 tests verts. Docs mises à jour : `protocole.md` §7 (saturation) et `decisions.md` D-009.
  - Les certificats déjà présents dans `dev/tls/` du projet datent d'avant la contrainte de nom : supprimer `dev/tls/` puis relancer `sh tools/devcert.sh` pour en bénéficier.
  - Re-vérification du testeur : aucun défaut, 78 tests verts. Elle couvre les certificats forgés hors contrainte (rejetés), la renégociation refusée, l'absence de tickets, la saturation à 300 connexions (serveur vivant) et l'absence de régression de l'étape 1.
  - Revue sécurité finale : **OK pour commit**, sans bloquant ni point important.
  - Commitée avec l'accord de l'humain. **Prochaine étape : 3 (comptes et connexion)**, à lancer sur son feu vert.
  - À garder en tête pour l'étape 3 : les navigateurs ignorent HSTS sur une adresse IP, il faudra un nom d'hôte. L'option `maxConnections` de `createFrameServer` est réservée aux tests et ne doit pas être branchée sur `config.json` sans nouvelle décision.
- **Étape 3 (comptes et connexion)** : terminée, commitée (`9eb48ec`) avec l'accord de l'humain. 151 tests verts. Sans rôles (D-010) ; paramètres d'authentification en D-011 (**Proposée**, reste à faire valider explicitement par l'humain ; le silence ne vaut pas validation).
- **Étape 4 (inventaire en lecture)** : terminée, commitée (`ced50be`) avec l'accord de l'humain. 241 tests verts. Questions soumises à l'humain, sans réponse pour l'instant :
  - D-011 et D-013 (Proposées) ;
  - le pipelining des trames après un rejet (protocole).
- **Étape 5 (édition des fiches et journal)** : terminée, commitée (`487041f`) avec l'accord de l'humain. 315 tests verts. D-014 (AUTOINCREMENT) validée.
- **Pour l'étape 6** :
  - message propre au trigger anti-doublon (`scans: duplicate`) ;
  - suppression d'un poste qui a des corrections : message clair (FOREIGN KEY), pas de 500.
- **(Historique) Pour l'étape 5** :
  - borner la longueur des textes saisis (nom, notes, propriétés) ;
  - filtrer les caractères bidi des noms à la saisie ;
  - adapter le libellé de la source de localisation (scan ou correction manuelle) ;
  - garder la forme de vue de D-013.
- **Étapes suivantes** du plan (`docs/cadrage.md` §4) :
  - 3 : comptes et connexion ;
  - 4 : inventaire en lecture ;
  - 5 : édition des fiches et journal des modifications ;
  - 6 : postes et lecteurs ;
  - 7 : puces inconnues et association ;
  - ~~8 : préparation du pilote~~ : retirée du plan pour l'instant (D-012). Objectif : un logiciel fonctionnel, visuellement correct, conforme à toutes les exigences techniques. La qualité visuelle est un critère de chaque étape d'interface.

## Décisions validées par l'humain

- Stack : **Node.js 26 LTS, zéro dépendance npm** (modules intégrés `node:https`, `node:crypto`, `node:sqlite`, `node:test`). Voir D-002.
- On implémente le **protocole v0** sans attendre le retour de Yanis. Ses points à valider sont listés dans `docs/protocole.md` §9.
- **Dépôt git local** (`git init`, branche `main`). Aucun dépôt distant relié, **pas de push** sans demande explicite.
- Le `.gitattributes` global (`* text=auto eol=lf`) n'est **pas validé**. Seul `*.sh text eol=lf` est ajouté, parce que la revue sécurité l'exige pour `devcert.sh`.

## Questions ouvertes

- **À l'humain** (non bloquantes, `docs/cadrage.md` §5) :
  - rôles des utilisateurs ;
  - sens de « informations » dans la fiche ;
  - Wi-Fi direct en production ;
  - stockage des clés de lecteurs en clair dans la base ;
  - suppression des postes et lecteurs qui ont un historique ;
  - OS du serveur pilote et acceptation de Node par la SSI de l'ONERA.
- **À Yanis** : les 10 points de `docs/protocole.md` §9 (format, AES-GCM, persistance du compteur, type de puce NFC, client HTTPS de l'ESP32, LoRa, mise en mémoire hors ligne, retour utilisateur, provisionnement).

## Méthode de travail (comment l'orchestrateur fonctionne)

Boucle par étape (`CLAUDE.md` §9) : `dev` → `testeur` → `revue-securite`, au plus 3 allers-retours, puis résumé, proposition de commit, et attente de l'accord de l'humain.

- Les agents sont définis dans `.claude/agents/` (`dev.md`, `testeur.md`, `revue-securite.md`). S'ils ne sont pas chargés comme types d'agent (cas où la session a démarré avant leur création), on lance un agent généraliste en lui demandant d'appliquer le fichier de rôle correspondant, et on lui donne tout le contexte dans la tâche.
- Le `testeur` ne modifie que `test/`. La `revue-securite` est en lecture seule. L'orchestrateur tient `docs/decisions.md`. `dev` met à jour `docs/protocole.md` si le contrat change.
- Avant chaque commit, l'orchestrateur relance lui-même `node --test`.

## Comment vérifier l'état actuel

Les commandes ci-dessous correspondent à l'état après l'étape 2 (HTTPS sur le port 8443).

```bash
node --test
sh tools/devcert.sh                      # CA + certificat de dev dans dev/tls/
cp config.example.json config.json
node server/main.js dev-seed             # poste, lecteur 1 (clé dans dev/reader-1.key), objet de démo
node server/main.js serve                # https://127.0.0.1:8443
node tools/simulateur.js --reader 1 --key-file dev/reader-1.key --uid 04A1B2C3D4E5F6 --counter 1 --ca dev/tls/ca.crt
```

Résultat attendu : `HTTP 204`. La même commande relancée donne `HTTP 400` (rejeu). `config.json`, `data/` et `dev/` sont ignorés par git et contiennent des clés : **ne jamais les versionner ni les transmettre**.

Prérequis : Node 26.13+, OpenSSL en ligne de commande, et `sh` (Git Bash sous Windows) pour `devcert.sh`.

---

## Historique

### 2026-11-15 — Phase 0 : cadrage
- Fichiers de configuration Claude (`CLAUDE.md`, `.claude/agents/`) remontés à la racine du projet.
- Rédigés et validés :
  - `docs/cadrage.md` : stack, schéma SQL, plan en 8 étapes, questions ;
  - `docs/protocole.md` v0 : trame de 36 octets, AES-256-GCM, vecteurs de test ;
  - `docs/decisions.md` : D-001 à D-007.
- Validé par l'humain : Node 26 zéro dépendance, protocole v0, `git init` local.

### 2026-11-15 — Étape 1 : squelette de réception des scans (commit `2aea8e8`)
- Code :
  - `server/protocol.js`, `ingest.js`, `db.js`, `http.js`, `main.js` ;
  - `server/migrations/001_init.sql` ;
  - `tools/simulateur.js` ;
  - 57 tests.
- Testeur : 2 défauts mineurs corrigés (clé de `dev-seed` qui ignorait `METROTRACK_CONFIG`, en-têtes de rejet non uniformes en keep-alive).
- Revue sécurité : 1 bloquant corrigé (une requête `POST //[` arrêtait le serveur) ; docs alignées ; D-008 (rejets HTTP uniformes).
- Commit validé par l'humain.

### 2026-11-15 — Étape 2 : HTTPS (commitée)
- Implémenté :
  - `node:https` seul, TLS ≥ 1.2, suites ECDHE + AEAD, HSTS, refus de démarrer sans certificat ;
  - `tools/devcert.sh` ;
  - simulateur avec `--ca` et vérification de certificat non désactivable ;
  - certificats de test générés à l'exécution ;
  - D-009 (politique TLS).
- Testeur : 2 écarts corrigés (`devcert.sh` sans dossier de sortie, contournement possible par `NODE_TLS_REJECT_UNAUTHORIZED=0`). 72 tests verts.
- Revue sécurité, 1er passage : à corriger (I1 fins de ligne, I2 saturation, suggestions).
- Correctifs appliqués : `.gitattributes` (`*.sh text eol=lf`), `maxConnections = 256`, erreur d'écoute fatale seulement avant `listening`, pas de renégociation ni de tickets TLS 1.2, journal `TLS refusé : <code>`, `devcert.sh` durci (`umask`, `trap`, `--`, contrainte de nom sur la CA). 75 tests verts.
- Re-vérification du testeur : aucun défaut, 78 tests. Revue sécurité finale : OK pour commit.
- Nouvelle consigne de l'humain : tenir ce fichier `SUIVI.md` à jour après chaque action, pour pouvoir transmettre le projet à un autre Claude Code.

### 2026-11-17 — Passation vers un autre compte Claude Code
- L'humain change de conversation et de compte Claude Code, sur le même dossier.
- Rédigé `PROMPT-REPRISE.md` (non commité) : prompt complet à coller dans la nouvelle conversation (rôle, règles, état, décisions, code existant, étape 3, questions ouvertes, environnement).
- État au moment de la passation : étapes 1 et 2 commitées (`2aea8e8`, `3ff1c05`), 78 tests verts, étape 3 non commencée (attend le feu vert de l'humain).

### 2026-11-17 — Reprise par le nouveau Claude Code
- Relu : `CLAUDE.md`, `SUIVI.md`, `docs/decisions.md`, `docs/cadrage.md`, `docs/protocole.md`.
- Vérifié : `git log` (2 commits attendus), agents `dev`, `testeur`, `revue-securite` disponibles, `node --test` → 78/78 verts. `config.json` local déjà à jour (port 8443, section `tls`).
- En attente : feu vert de l'humain pour l'étape 3, et réponse sur les rôles (proposition : aucun rôle dans le MVP).

### 2026-11-17 — Étape 3 lancée (comptes et connexion)
- Feu vert de l'humain, **sans rôles** : D-010 consignée (Validée).
- D-011 consignée (Proposée, à valider par l'humain) : paramètres argon2id (OWASP), file argon2 unique, cookie `__Host-mt_session` de 8 h, jeton CSRF dérivé du jeton de session par HMAC, double soumission pour la connexion, `Origin` comparé à `Host`, délai d'1 s par échec, identifiant limité à `[A-Za-z0-9._-]`.
- Agent `dev` lancé sur l'étape 3 (aller-retour 1/3).
- L'agent `dev` a été coupé à la fin de la session précédente, sans rapport. Déjà sur disque : migration 002, `server/password.js`, `sessions.js`, `web.js`, `web/static/`, modifications de `http.js`. Manquaient `user-add` et les tests. Agent `dev` relancé pour terminer (toujours l'aller-retour 1/3).
- Consigne de l'humain : enchaîner la boucle sans interruption et faire un rapport simplifié en fin d'étape.
- Recentrage (D-012) : l'ONERA sort du plan pour l'instant, l'étape 8 est retirée et la qualité visuelle devient un critère. Les exigences de sécurité restent inchangées.
- `CLAUDE.md` adapté à la demande de l'humain : ONERA retiré comme premier site pilote (§4), objectif « fonctionnel et visuellement soigné » ajouté (§1). Mention ONERA retirée de `.claude/agents/revue-securite.md`.
- Aperçu visuel prévisionnel montré à l'humain (maquette indicative : connexion, liste d'inventaire, fiche objet).
- Consigne de l'humain : ne pas le solliciter pour les étapes mineures ; il veut seulement le rapport de fin d'étape.
- Rapport de `dev` (aller-retour 1/3) : étape 3 implémentée, 125 tests verts (78 + 47), aucune dépendance.
  - Fichiers : migration 002, `password.js`, `sessions.js`, `web.js`, `web/static/style.css` ; `http.js` délègue le web à `web.js` ; commande `user-add` dans `main.js`.
  - Écart justifié : `Referrer-Policy: same-origin` (`no-referrer` ferait envoyer `Origin: null`), ajouté à D-011.
  - Limite : sous Git Bash (mintty), `user-add` ne masque pas la saisie et affiche un avertissement ; utiliser PowerShell ou `winpty`.
  - Corps de formulaire > 4 Kio → 413.
- Agent `testeur` lancé.
- Rapport du `testeur` : les 11 critères sont vérifiés sur le vrai serveur. 141 tests : 140 verts, 1 todo. Ajouts : `test/e2e-connexion.test.js`, `test/web-limites.test.js`.
  - Défaut mineur (❌) : l'adresse source est perdue dans le journal des échecs de connexion quand le client coupe tôt (`web.js`, `login` lit `remoteAddress` après `verifyPassword`).
  - Remarques : `charset=utf-16` accepté ; 403 CSRF non journalisés ; mot de passe non normalisé en NFC ; saisie sans écho non testable ici.
- Revue sécurité lancée avant le retour à `dev`, pour regrouper ses remarques avec ce défaut dans un seul aller-retour.
- Rapport de la revue sécurité : **À corriger**.
  - BLOQUANT B1 : la file argon2 n'a pas de limite. Un client qui envoie puis coupe aussitôt, ou qui enchaîne les requêtes sur une connexion, sature la mémoire et rend la connexion indisponible.
  - IMPORTANT I1 : l'adresse source est perdue dans le journal quand le client coupe tôt (le défaut du testeur).
  - Suggestions : journaliser les 403 CSRF ; normaliser le mot de passe en NFC ; refuser tout charset autre que utf-8 ; sortir `USERNAME_FORMAT` de `web.js` ; documenter le cas Git Bash ; ne pas commiter `PROMPT-REPRISE.md`.
  - Tout le reste est jugé conforme : temps constant, cookies, sessions, énumération, XSS, CSP, journaux, `/api/frames` inchangé, zéro dépendance.
- Retour à `dev` (aller-retour 2/3) : B1 (plafond de 16 calculs argon2, 503 au-delà, pas de calcul si le client est parti), I1, et les suggestions S1, S2, S3, S6.
- Rapport de `dev` (aller-retour 2/3) : tout est corrigé ; 148 tests verts, aucun todo.
  - Le test du testeur « 20 connexions simultanées » est ramené à 16 (le plafond), et le 503 a son propre test.
  - Point de fragilité possible : le test du 503 dépend du temps de calcul.
  - D-011 mise à jour : file bornée à 16, NFC, charset, journal des refus, limite du délai d'1 s.
- Re-vérification par le testeur et re-relecture par la revue lancées en parallèle (le code applicatif ne change plus pendant ce temps).
- Re-relecture par la revue : **OK pour commit**.
  - B1 et I1 sont fermés. Sonde de 15 200 tentatives : 5 calculs argon2, au plus 16 en attente, +1,5 Mo de mémoire, 32 ms pour un client légitime. Le compteur revient toujours à 0.
  - Suggestions restantes : journal qui grossit sous attaque (rotation, plus tard) ; tester une erreur réelle d'argon2 (facultatif) ; ne pas ajouter `PROMPT-REPRISE.md` au commit.
- Re-vérification par le testeur : aucun bogue, 151 tests verts sur 3 exécutions. Ajout : `test/web-attaque.test.js` (pipelining, rafale, NFC).
  - Sous attaque, la mémoire reste bornée (pic de 88 Mo) et une connexion légitime est servie en 76 ms.
  - Points de conception signalés : la page 503 est vide (page blanche) ; un attaquant seul peut occuper la file en continu ; le journal grossit sous attaque.
- Vérification de l'orchestrateur : `node --test` → 151/151 verts. Aucune clé ni donnée personnelle dans les fichiers à commiter, `package.json` toujours sans dépendance.
- **Étape 3 terminée, en attente de l'accord de l'humain pour le commit** (aller-retour 2/3). `PROMPT-REPRISE.md` est exclu du commit.
- Accord de l'humain → commit `9eb48ec` « Étape 3 : comptes et connexion ». Les fichiers ont été ajoutés nommément ; `PROMPT-REPRISE.md` reste non versionné.

### 2026-11-17 — Étape 4 lancée (inventaire en lecture)
- Lancée selon CLAUDE.md §9 (après un commit, on passe à l'étape suivante).
- Contenu :
  - liste des objets avec localisation et ancienneté, recherche par nom ou UID ;
  - fiche objet avec propriétés, notes, localisation et derniers scans ;
  - fonction d'échappement HTML et gabarit à échappement automatique, testés ;
  - bandeau de navigation commun ;
  - page 503 de connexion lisible.
- Agent `dev` lancé (aller-retour 1/3).
- Rapport de `dev` : étape 4 implémentée, 205 tests verts, aucune dépendance.
  - Nouveaux fichiers : `server/html.js` (gabarit à échappement automatique ; `sendHtml` refuse tout HTML qui n'en vient pas), `dates.js`, `inventory.js`, `views.js`.
  - dev-seed ajoute « Poste 2 » et 5 objets de démonstration.
  - Captures vérifiées par l'orchestrateur (liste et fiche, bureau) : rendu propre.
  - 3 tests existants adaptés : corps du 503, regex `href="/"`, pipelining. Pour ce dernier, les 503 désormais plus volumineux font couper la connexion par Node (`HPE_PAUSED`).
  - Limite relevée : la recherche par nom tient compte des accents et de la casse hors ASCII (« étuve » ne trouve pas « Étuve »). À corriger au prochain aller-retour (friction minimale).
- Testeur et revue sécurité lancés en parallèle.
- Rapport de la revue sécurité : **OK pour commit**, aucun bloquant. XSS, SQL, contrôle d'accès, en-têtes, page 503, dev-seed et non-régression sont jugés conformes.
  - I1 : la vue `item_locations` est entièrement matérialisée à chaque page (`row_number`). Mesure : 555 ms pour 300 000 scans, et `node:sqlite` est synchrone, donc tout le serveur bloque.
    - Proposition : réécrire la vue avec une sous-requête corrélée sur l'index (migration 003), mêmes colonnes et mêmes résultats, 20 ms environ.
    - L'orchestrateur la traite comme une optimisation, pas comme un changement de modèle : la sémantique de D-006 est inchangée. Elle est signalée à l'humain.
  - I2 : `raw()` est du code mort, à supprimer.
  - I3 : un mot court en lettres hexadécimales (`de`, `a`) remonte des UID ; ne chercher dans les UID qu'à partir de 4 caractères hexadécimaux ou s'il y a un chiffre.
  - Suggestions :
    - libellé de la source de localisation (pour l'étape 5) ;
    - ordre des propriétés ;
    - pas de pagination ;
    - recherche sans accents : coût à surveiller ;
    - D-011 ne doit pas être considérée comme validée par le silence (SUIVI corrigé) ;
    - test de pipelining à préciser.
- Rapport du testeur : les 11 critères tiennent sur le serveur réel, sans bogue de sécurité. 223 tests (221 verts, 2 todo).
  - Ajouts : `test/inventaire-verif.test.js`, `test/inventaire-charge.test.js`.
  - Défaut moyen : un nom de poste long sans espace déborde (puce `.etat`, 375 px et bureau).
  - Défaut faible : un NUL dans `q` fausse le LIKE.
  - Confirme la lenteur de la vue (I1).
  - Remarques cosmétiques : RLO dans un nom, `dd` sans `pre-wrap`, texte d'aide rogné à 375 px.
- Retour à `dev` (aller-retour 2/3) :
  - vue réécrite (migration 003, sous-requête corrélée, mêmes résultats, test d'équivalence) ;
  - suppression de `raw()` ;
  - recherche insensible aux accents et à la casse ;
  - UID cherché seulement à partir de 4 caractères hexadécimaux ;
  - caractères de contrôle retirés de `q` ;
  - débordements CSS et `pre-wrap` sur `dd` ;
  - commentaire corrigé, test de pipelining précisé, todo retirés.
- Rapport de `dev` (aller-retour 2/3) : tout est corrigé, 233 tests verts, aucun todo.
  - Migration 003 : avec 300 000 scans, la liste passe de 1,9 s à 44 ms et la fiche de 1,9 s à 0,2 ms. Équivalence avec l'ancienne vue testée.
  - Recherche filtrée en JS par `fold` : plus de LIKE.
  - Règle UID : au moins 4 caractères hexadécimaux, dont un chiffre.
  - Changement non demandé : un seul 503 par connexion dans `web.js`.
  - Capture du poste long à 375 px vérifiée par l'orchestrateur : plus de débordement.
- Re-vérification par le testeur et re-relecture par la revue lancées en parallèle.
- Re-relecture par la revue : **OK pour commit**. Ancien I1 (vue), I2 (`raw`), I3 (UID) et le « 503 unique » sont jugés sûrs ; la vue est équivalente sur 300 000 scans.
  - Nouveau I1 : caractères bidi invisibles écrits littéralement dans une regex de `inventory.js:24` (motif « Trojan Source ») → les remplacer par des échappements `\u`.
  - Nouveau I2 : cadrage §3 et D-006 montrent encore l'ancienne vue → faits par l'orchestrateur (note dans cadrage.md, D-013 « Proposée », complément à D-011 sur le 503).
  - Suggestions :
    - S1 : retrouver un UID complet sans chiffre (8 caractères hexadécimaux ou plus) ;
    - S2 : borner la longueur des textes à l'étape 5 ;
    - S3 : libellé de la source de localisation à l'étape 5 ;
    - S5 : une recherche vide une fois normalisée équivaut à une recherche vide.
- Re-vérification du testeur : les 8 points sont vérifiés, 236 tests verts.
  - Migration 003 testée sur une vraie base en version 2 (issue de 9eb48ec) : localisations identiques.
  - Charge : 300 000 scans → liste en 30 ms et fiche en 3 ms ; `/api/frames` reste réactif.
  - **Point remonté à l'humain (protocole, hérité de l'étape 1)** : sur une connexion avec pipelining, des trames valides envoyées après un rejet sont enregistrées, mais leur réponse est perdue (à cause de `Connection: close` sur le rejet). Sans effet pour le prototype Wi-Fi (une trame par requête) ; cela compte pour le futur boîtier mère. Deux options : une règle dans `protocole.md` (« ne pas enchaîner ») ou un changement côté serveur.
- Retour à `dev` (aller-retour 3/3, le dernier) :
  - caractères bidi écrits en échappements, avec un test anti-caractères invisibles ;
  - un UID complet sans chiffre est trouvable ;
  - une recherche vide après normalisation équivaut à une recherche vide ;
  - espace insécable dans le résumé de recherche.
- Rapport de `dev` (aller-retour 3/3) : les 4 retouches sont faites, 241 tests verts.
  - L'outil d'écriture de `dev` avait converti des échappements `\u` en caractères réels, y compris dans 3 fichiers de test. Tout est corrigé.
  - Nouveau test anti-caractères invisibles : `test/sources-invisibles.test.js`.
  - L'orchestrateur a vérifié : 241/241, aucun caractère invisible dans `server/`, `web/`, `test/` ni `docs/`.
- Vérification ciblée par le testeur et relecture ciblée par la revue lancées en parallèle.
- Relecture finale par la revue : **OK pour commit**. Le problème des caractères invisibles est fermé, sans régression ; les fichiers du cœur sont identiques à HEAD. Deux suggestions mineures :
  - étendre le contrôle anti-caractères invisibles à `tools/` et `docs/` ;
  - remettre D-013 après D-012 (fait par l'orchestrateur).
- Vérification finale du testeur : ✅ sur les 4 retouches et la non-régression. Il reste une capture périmée (cosmétique) et le point de protocole sur le pipelining.
- Vérification de l'orchestrateur : 241/241, `package.json` toujours sans dépendance.
- **Étape 4 terminée, en attente de l'accord de l'humain pour le commit** (3 allers-retours sur 3). `PROMPT-REPRISE.md` est exclu du commit.
- Accord de l'humain → commit `ced50be` « Étape 4 : inventaire en lecture seule ».

### 2026-11-17 — Étape 5 lancée (édition des fiches et journal)
- Contenu :
  - migration 004 : `location_corrections`, `audit_log` (ajout seul) et vue avec correction manuelle, sous la forme de D-013 ;
  - créer, modifier et supprimer une fiche ;
  - corriger la localisation à la main ;
  - historique des modifications sur la fiche ;
  - longueurs des textes bornées ; caractères bidi et de contrôle filtrés à la saisie.
- L'UID ne se modifie pas à cette étape (association de puce : étape 7).
- Agent `dev` lancé (aller-retour 1/3).
- Rapport de `dev` (étape 5, aller-retour 1/3) : implémentée, 292 tests verts.
  - Fichiers : migration 004, `server/items.js` ; routes `/items/new`, `/items/<id>/edit`, `/items/<id>/delete`, `/items/<id>/location` ; postForm commun (session → Origin → corps → CSRF) ; historique sur la fiche.
  - Écarts signalés :
    - plafond du corps à 256 Kio (64 Kio ne suffisait pas pour une fiche pleine) ;
    - index `audit_by_entity` hors cadrage ;
    - numéros de fiche réutilisés par SQLite (sans AUTOINCREMENT), donc `audit_log.entity_id` ambigu ; contourné à l'affichage.
  - Capture du formulaire en erreur vérifiée par l'orchestrateur : rendu propre.
- Testeur et revue sécurité lancés en parallèle. Avis demandé à la revue sur la réutilisation des numéros de fiche (AUTOINCREMENT = changement de modèle, à remonter à l'humain).
- Rapport de la revue sécurité (étape 5) : **À corriger**.
  - B1 : le nombre de lignes de propriétés n'est pas borné. Un formulaire de 256 Kio produit une page d'environ 16 Mo (risque mémoire). Correction : refuser plus de `MAX_PROPERTIES + BLANK_ROWS` lignes.
  - I1 : l'ajout seul se contourne par `INSERT OR REPLACE` (sur `audit_log`, sur `scans` depuis l'étape 1, et sur `location_corrections`). Correction : `PRAGMA recursive_triggers = ON`.
  - I2 : numéros de fiche réutilisés. Le journal reste ambigu, et un formulaire ouvert peut viser la nouvelle fiche qui a repris le numéro. Recommandation : `items` en AUTOINCREMENT dans la migration 004, avant son commit. **Changement de modèle : question posée à l'humain.**
  - Suggestions :
    - S1 : écritures concurrentes, la dernière l'emporte (accepté) ;
    - S2 : la suppression de poste doit être traitée à l'étape 6 ;
    - S3 : retirer aussi U+200E, U+200F, U+061C et les caractères invisibles ;
    - S4 : compter les longueurs en `text.length` et corriger le commentaire du plafond ;
    - S5 : casse des clés (ß) ;
    - S6 : documentation (D-014, plafond de 256 Kio, index `audit_by_entity`).
- Rapport du testeur (étape 5) : fonctionne sur le serveur réel, aucun bogue bloquant ni de sécurité. 302 tests verts ; ajout de `test/edition-verif.test.js`.
  - Confirme l'ambiguïté des numéros de fiche réutilisés : la fiche 79 a été reprise par 4 fiches pendant les essais.
  - Défauts mineurs :
    - nom fait d'un seul U+200B accepté ;
    - doublons de clés NFC/NFD non détectés ;
    - ordre des clés numériques non respecté ;
    - `maxlength` compté en UTF-16 côté navigateur ;
    - écrasement concurrent possible ;
    - double clic qui crée deux fiches ;
    - alignement à 375 px.
- Retour à `dev` (aller-retour 2/3) :
  - B1 : lignes de propriétés bornées ;
  - I1 : `recursive_triggers` et trigger anti-REPLACE sur `location_corrections` ;
  - caractères invisibles retirés, NFC, casse pliée pour les clés, longueurs en UTF-16 ;
  - commentaire du plafond, alignement CSS.
  - AUTOINCREMENT **non** fait, en attente de la décision de l'humain.
  - Accepté pour le MVP, à documenter : ordre des clés numériques, écrasement concurrent, double clic.
- **Décision de l'humain (2026-11-18)** : oui à AUTOINCREMENT sur `items` → D-014 (Validée). Limites acceptées pour le MVP consignées dans `decisions.md`.
- L'agent `dev` (aller-retour 2/3) a été coupé par la limite d'usage avant toute modification. Il est relancé avec les corrections et AUTOINCREMENT.
- Rapport de `dev` (étape 5, aller-retour 2/3) : tout est corrigé, 310 tests verts.
  - B1 : au plus 53 lignes de propriétés, sinon 400.
  - I1 : `recursive_triggers` ; trigger `location_corrections_no_replace`.
  - Caractères invisibles retirés, NFC, casse pliée pour les clés, longueurs en UTF-16.
  - AUTOINCREMENT dans la migration 004 (reconstruction de `items`) ; contournement de l'historique supprimé.
  - Alignement CSS.
- Re-vérification par le testeur et re-relecture par la revue lancées en parallèle.
- Re-relecture de la revue (étape 5) : **OK pour commit**. B1, I1 et I2 sont fermés (sondes à l'appui) ; la migration 004 avec reconstruction est atomique et fidèle à 001.
  - Point I1' : la base de démo a-t-elle déjà reçu l'ancienne migration 004 ? Vérifié par l'orchestrateur, en lisant uniquement le schéma : `data/metrotrack.db` est en version 1 (étape 1). Les migrations 002 à 004 s'y appliqueront au prochain `serve`. **Rien à faire.**
  - Suggestions :
    - commentaire sur un numéro libéré avant la migration 004, qui peut resservir une fois ;
    - nom fait seulement de caractères invisibles légitimes (U+200C, U+200D…) ;
    - ne pas commiter `PROMPT-REPRISE.md`.
- Re-vérification du testeur (étape 5) : les 7 points passent sur le serveur réel, 312 tests verts. Points relevés :
  - **moyen** : le refus de REPLACE sur `scans` et `audit_log` dépend du PRAGMA de la connexion ; un outil externe peut encore écraser une ligne ;
  - un numéro supprimé avant la migration 004 peut resservir une fois → ajouté dans D-014 ;
  - noms faits seulement de caractères invisibles encore acceptés (U+2060, U+3164…).
- Retour à `dev` (aller-retour 3/3, le dernier) :
  - triggers BEFORE INSERT anti-REPLACE sur `scans` (id et couple lecteur/compteur) et sur `audit_log`, en vérifiant que le rejeu reste un 400 propre dans `ingest.js` ;
  - règle « au moins un caractère visible » pour le nom et les clés.
- Rapport de `dev` (étape 5, aller-retour 3/3) : 315 tests verts.
  - Triggers `audit_log_no_replace` et `scans_no_replace` (indépendants du PRAGMA).
  - `ingest.js` : le code 1811 (trigger) avec le message `scans: append-only` est traité comme un rejeu, comme le code 2067 (unicité). Le contrat ne change pas.
  - Règle « au moins un caractère visible » pour le nom et les clés.
  - Orchestrateur : diff de `ingest.js` relu, 315/315.
- Vérification ciblée par le testeur et relecture ciblée par la revue lancées (priorité : ingestion).
- Relecture finale de la revue (étape 5) : **OK pour commit**.
  - `ingest.js` : diff minimal, ordre normatif intact, contrat inchangé.
  - Triggers : tous les chemins d'écrasement refusés, pour un coût de 7,5 µs par scan.
  - Regex : valide.
  - Suggestion S1 (reportée à l'étape 6, les 3 allers-retours étant épuisés) : message propre au trigger anti-doublon (`scans: duplicate`).
  - I1' (base de démo) : déjà vérifié par l'orchestrateur, base en version 1.
- Vérification finale du testeur (étape 5) : tout est ✅, 315/315.
  - Refus de REPLACE sans le PRAGMA.
  - Ingestion concurrente : 2 serveurs sur la même base, 200 trames → 30 × 204, 170 × 400, aucun 500, aucun doublon.
  - Noms invisibles refusés.
  - Parcours complet et migration v3 → v4 corrects.
- Vérification de l'orchestrateur : 315/315, aucune dépendance.
- **Étape 5 terminée, en attente de l'accord de l'humain pour le commit** (3 allers-retours sur 3). `PROMPT-REPRISE.md` est exclu du commit.
- Accord de l'humain → commit `487041f` « Étape 5 : édition des fiches et journal des modifications ».

### 2026-11-18 — Étape 6 lancée (postes et lecteurs)
- Contenu :
  - postes : créer, renommer, décrire ; suppression seulement sans historique ;
  - lecteurs : création (identifiant et clé AES-256 générés par le serveur, clé affichée une seule fois), affectation à un poste, désactivation définitive, remplacement de clé (= nouveau lecteur, l'ancien est désactivé) ;
  - `audit_log` sans jamais la clé ;
  - migration 005 : message propre au trigger anti-doublon (S1 de l'étape 5).
- Choix par défaut appliqués aux questions ouvertes, à confirmer par l'humain :
  - un poste ou un lecteur qui a un historique ne se supprime pas (cadrage Q9) ;
  - un lecteur désactivé ne se réactive pas ;
  - les clés restent stockées en clair dans la base (Q8).
- Agent `dev` lancé (aller-retour 1/3).
- Rapport de `dev` (étape 6, aller-retour 1/3) : implémentée, 364 tests verts, aucune dépendance.
  - Nouveaux fichiers : migration 005 (`scans: duplicate`, index `scans_by_station`), `server/stations.js`, `server/readers.js`.
  - Routes `/stations…` et `/readers…`. Une action impossible renvoie 409 avec une explication.
  - `docs/protocole.md` §6 précisé, sans changement du contrat.
  - Test de bout en bout : la clé lue sur la page est acceptée par le simulateur.
  - Écart non demandé : un numéro de poste n'est jamais réutilisé, grâce à une recherche dans `audit_log`. À arbitrer.
  - Limite : un double clic ou un rechargement de la page de clé crée un autre lecteur (la page en avertit).
  - Capture de la page de clé vérifiée par l'orchestrateur : claire.
- Testeur et revue sécurité lancés en parallèle.
- Rapport de la revue (étape 6) : **OK pour commit**, sous réserve de deux points IMPORTANTS.
  - I1 : décisions non consignées → l'orchestrateur ajoute D-015 (numéros de poste non réutilisés, **Proposée, à faire valider par l'humain**) et les limites acceptées de l'étape 6.
  - I2 : retirer de la page de clé le bloc « Tester avec le simulateur », qui pousse à écrire une vraie clé dans un fichier.
  - Suggestions :
    - S2 : ligne d'audit `reader.create` pour le nouveau lecteur lors d'un remplacement ;
    - S3 : « fermez cet onglet » ;
    - S4 : utiliser `EXISTS` plutôt que `count(*)` sur la page d'un poste ;
    - S5 : désactivation définitive à préciser dans `protocole.md` ;
    - S6 : `aria-labelledby`.
  - Tout le reste est jugé conforme : clé jamais lue hors `ingest.js`, cycle de vie, limite uint32, migration 005, CSRF, XSS, coûts.
- Rapport du testeur (étape 6) : fonctionne de bout en bout, aucun bogue bloquant. 369 tests verts ; ajout de `test/postes-lecteurs-verif.test.js`.
  - Vérifications complètes : clé introuvable ailleurs (636 requêtes analysées), concurrence avec 2 serveurs, migration 4 → 5 depuis `487041f`.
  - Défaut mineur : des noms de poste identiques à l'œil (espaces multiples ou insécables) échappent au contrôle de doublon.
- Retour à `dev` (aller-retour 2/3) :
  - retirer le bloc simulateur de la page de clé et déplacer la procédure dans `protocole.md` ;
  - ajouter « fermez cet onglet » ;
  - écrire une ligne d'audit `reader.create` pour le nouveau lecteur lors d'un remplacement ;
  - utiliser `EXISTS` ;
  - préciser la désactivation définitive dans `protocole.md` ;
  - réduire les blancs internes à une seule espace dans `cleanLine` ;
  - corriger `aria-labelledby`.
- `dev` (étape 6, aller-retour 2/3) a été coupé par la limite d'usage, puis repris. Rapport : tout est corrigé, 372 tests verts.
  - Bloc simulateur retiré de la page de clé ; procédure « développement uniquement » ajoutée dans `protocole.md` §6, avec la désactivation définitive.
  - Ligne d'audit `reader.create` écrite lors d'un remplacement.
  - `stationHasHistory` en EXISTS.
  - Blancs réduits à une seule espace dans `cleanLine`.
  - Captures régénérées.
  - Détail : une tabulation dans un nom est supprimée et non remplacée par une espace (non traité, mineur).
- Re-vérification par le testeur et re-relecture par la revue lancées en parallèle.
- Testeur et revue (étape 6) coupés par la fin de session, puis relancés (2026-11-19).
- Re-relecture de la revue : **OK pour commit**.
  - I1 et I2 fermés ; texte de `protocole.md` §6 sûr ; double audit cohérent ; `cleanLine` sans risque.
  - Suggestions mineures : `cleanLine` aussi dans `stationNameKey` (S-a) ; réduction des blancs dans la recherche (S-b).
- Re-vérification du testeur (étape 6) : les 7 points ✅. Un test de l'étape 5 est instable (`edition-web.test.js:398`, ECONNRESET au lieu de 413 une fois sur 13 sous Windows) : c'est une course dans le test, pas un défaut du serveur.
- Retour à `dev` (aller-retour 3/3, le dernier) : S-a (`cleanLine` dans `stationNameKey`), S-b (réduction des blancs dans la recherche), test stabilisé.
- Rapport de `dev` (étape 6, aller-retour 3/3) : S-a, S-b et test stabilisé (`test/coupure.js`). 375 tests verts, 3 fois de suite.
  - Doute : une fiche ancienne dont le nom contient des espaces multiples n'est pas trouvée tant qu'elle n'est pas réenregistrée (aucune donnée de production à ce jour).
- Vérification ciblée par le testeur et relecture ciblée par la revue lancées.
- Relecture finale de la revue (étape 6) : **OK pour commit**.
  - S-a et S-b corrects ; aucun caractère invisible ; l'assouplissement des tests de corps trop gros est légitime (le 413 strict de `web.test.js` est gardé).
  - Suggestions reportées à l'étape 7 :
    - ajouter un test 413 strict sur une route d'édition (Content-Length seul) ;
    - commenter l'usage de la regex `LINE_BLANKS`, qui porte le drapeau `/g`.
- Vérification finale du testeur (étape 6) : ✅ 375/375, 5 fois de suite.
  - Doublons avec espaces insécables refusés ; recherche avec espaces multiples correcte.
  - Tests de plafond non affaiblis : avec un plafond multiplié par 1 000, les trois tests échouent bien.
- Vérification de l'orchestrateur : 375/375, aucune dépendance.
- **Étape 6 terminée, commitée (8034cea)** (3 allers-retours sur 3). D-015 à faire valider. `PROMPT-REPRISE.md` est exclu du commit.
- **Accord de l'humain (2026-11-19)** : D-015 validée, et commit de l'étape 6.
- Commit `8034cea` « Étape 6 : gestion des postes et des lecteurs ».

### 2026-11-19 — Étape 7 lancée (puces inconnues et association)
- Contenu :
  - liste des puces scannées sans fiche (poste et heure du dernier scan, nombre de scans) ;
  - « Créer une fiche » avec l'UID déjà rempli ;
  - « Associer à une fiche existante », avec confirmation si la fiche avait déjà une puce : l'ancienne puce est détachée et la modification tracée ;
  - `audit_log`.
- Ajouts reportés de l'étape 6 : un test 413 strict sur une route d'édition, et un commentaire sur le drapeau `/g` de `LINE_BLANKS`.
- Agent `dev` lancé (aller-retour 1/3).
- Rapport de `dev` (étape 7, aller-retour 1/3) : implémentée, 416 tests verts, aucune dépendance.
  - `server/chips.js` ; routes `/chips…` ; onglet « Puces inconnues » sans badge (le compte coûterait 19 ms par page).
  - Liste des puces inconnues en 22 ms pour 300 000 scans, par lecture de l'index `scans_by_uid` par sauts.
  - Ajout non demandé : champ caché `previous` sur la confirmation, avec 409 si la fiche a changé de puce entre-temps.
  - Reliquats de l'étape 6 traités : commentaire sur `LINE_BLANKS`, test 413 strict.
  - Capture de la confirmation de remplacement vérifiée par l'orchestrateur : avertissement clair.
- Testeur et revue sécurité lancés en parallèle.

### 2026-11-20 — Démonstration tangible demandée par l'humain
- Reprise : testeur et revue de l'étape 7 relancés (ils avaient été coupés par la fin de session).
- Instance de démonstration créée dans `dev/demo/` (ignoré par git) :
  - certificats propres, port 18443, base `dev/demo/data/demo.db` ;
  - compte `demo`, mot de passe aléatoire noté dans `dev/demo/identifiants.txt` (local uniquement, jamais recopié ailleurs) ;
  - 4 postes, 5 lecteurs (dont un non affecté) ;
  - 8 scans simulés, dont 2 puces inconnues.
- Serveur de démonstration lancé avec `METROTRACK_CONFIG=dev/demo/config.json node server/main.js serve`.
- Le navigateur intégré refuse la CA de développement (ERR_CERT_AUTHORITY_INVALID) : l'humain doit choisir lui-même de continuer vers le site dans le panneau.
- L'humain a ouvert la démo dans son propre navigateur, après avoir accepté lui-même l'avertissement de certificat. Visite guidée et commande de scan en direct fournies.
- Rapport de la revue (étape 7) : **À corriger**.
  - B1 : `/chips` n'a pas de limite ; avec 300 000 UID distincts, le serveur est bloqué 7 s. Correction : `LIMIT`, total affiché, test à 50 000 puces.
  - I1 : la réutilisation d'une puce se fait sans avertissement. Correction : un avertissement tiré d'`audit_log`, sans changement de modèle.
  - I2 : les limites acceptées de l'étape 7 sont consignées par l'orchestrateur dans `decisions.md`.
  - Suggestions :
    - S1 : préciser le commentaire de la lecture « en sauts » ;
    - S2 : la page de suppression doit prévenir que la puce redeviendra inconnue.
- En attente du testeur avant le retour à `dev`.
- Serveur de démo arrêté de l'extérieur (code 127, probablement par le ménage d'un agent), puis relancé. Consigne donnée aux agents : n'arrêter que leurs propres processus, par PID.
- Rapport du testeur (étape 7) : les 10 critères ✅, 426 tests verts ; ajout de `test/puces-verif.test.js`. Points mineurs :
  - `/api/frames` ralentit quand `/chips` est très sollicitée (consigné dans les limites acceptées) ;
  - UID de l'historique pas en chasse fixe ;
  - `previous` répété (sans danger) ;
  - ordre des contrôles 409/404 (cohérent).
- Retour à `dev` (aller-retour 2/3) :
  - B1 : limite sur `/chips` et test à 50 000 puces ;
  - I1 : avertissement de réutilisation tiré d'`audit_log` ;
  - S1 : commentaire de la lecture en sauts ;
  - S2 : avertissement sur la page de suppression ;
  - UID en chasse fixe dans l'historique.
- Le testeur reconnaît avoir arrêté la démo (`Stop-Process` sur un filtre de ligne de commande trop large). Base de démo vérifiée par l'orchestrateur : `integrity_check` ok, 8 scans et 6 objets, rien de perdu.
- Rapport de `dev` (étape 7, aller-retour 2/3) : 437 tests verts.
  - B1 : `/chips` limité à 200 puces ; 92 ms à 50 000 UID et 452 ms à 300 000 (parcours d'index résiduel, accepté comme limite).
  - I1 : avertissement de réutilisation (`chipPreviousOwner`, `json_extract` sur `audit_log`).
  - S1, S2 et UID en chasse fixe dans l'historique.
- Re-vérification par le testeur et re-relecture par la revue lancées (consigne : n'arrêter que leurs propres PID).
- **Nouvelle demande de l'humain (2026-11-20)** : des explications intégrées au site sur le fonctionnement de chaque écran, en commençant par Inventaire et Nouvelle fiche.
  - Planifié comme petite étape dédiée (« aide intégrée »), juste après le commit de l'étape 7, pour ne pas perturber la vérification en cours des mêmes fichiers.
  - Forme proposée : un encadré repliable « Comment ça marche ? » en `<details>` (sans JavaScript, CSP inchangée), en tête de chaque page.
- Re-vérification du testeur (étape 7) : ✅ sur tout, 438 tests verts (il a ajouté 1 test).
  - Point mineur : `chipPreviousOwner` parcourt `audit_log` (environ 120 ms pour 200 000 lignes, sur des pages rarement affichées). Acceptable pour le MVP.
- En attente de la revue.
- Re-relecture de la revue (étape 7) : **OK pour commit**, après correction d'une phrase fausse dans `decisions.md` (limite de `/chips`), corrigée par l'orchestrateur.
  - S1 (`chipPreviousOwner` appelé inutilement sur la recherche) reportée à l'étape d'aide intégrée.
- Vérification de l'orchestrateur : 438/438, aucune dépendance.
- **Étape 7 terminée, en attente de l'accord de l'humain pour le commit** (2 allers-retours). `PROMPT-REPRISE.md` et `dev/` sont exclus.
- Classeur `MetroTrack-point-etape.xlsx` (à la racine, non versionné) demandé par l'humain. Quatre onglets : Fait, À faire, À valider, Matériel. Généré sans dépendance par un script du scratchpad ; ouverture vérifiée dans Excel.
