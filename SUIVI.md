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
- **Étape 3 (comptes et connexion)** : terminée et validée par le testeur et la revue (151 tests verts). **En attente de l'accord de l'humain pour le commit.** Sans rôles (D-010) ; paramètres d'authentification en D-011 (Proposée, à faire valider).
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
