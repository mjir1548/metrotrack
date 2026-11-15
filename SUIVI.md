# MetroTrack — Journal de suivi et de passation

Ce fichier est tenu à jour par l'orchestrateur (Claude Code) **après chaque action significative**.
Il sert à reprendre le travail depuis une autre session ou un autre compte Claude Code.

> **Pour un Claude qui reprend le projet** :
> 1. Lis ce fichier en entier, puis `CLAUDE.md`, puis `docs/decisions.md`, `docs/protocole.md` et `docs/cadrage.md`.
> 2. Tu es l'orchestrateur décrit dans `CLAUDE.md` §9. Reprends à la section « Où on en est » ci-dessous.
> 3. Continue à tenir ce fichier à jour à chaque étape (ajoute une entrée datée dans « Historique »).

Dernière mise à jour : 2026-11-15

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
- **Étapes suivantes** du plan (`docs/cadrage.md` §4) :
  - 3 : comptes et connexion ;
  - 4 : inventaire en lecture ;
  - 5 : édition des fiches et journal des modifications ;
  - 6 : postes et lecteurs ;
  - 7 : puces inconnues et association ;
  - 8 : préparation du pilote (à confirmer).

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
