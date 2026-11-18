# MetroTrack — Journal des décisions

Chaque décision structurante en quelques lignes : date, décision, alternatives écartées, raison.
Statuts : **Proposée** (en attente de validation), **Validée**, **Remplacée par D-xxx**.
Les décisions qui touchent au contrat boîtier ↔ serveur doivent aussi être validées par Yanis.

---

## D-001 — Journal des décisions

- **Date** : 2026-11-15 · **Statut** : Validée
- **Décision** : les décisions structurantes sont consignées ici, numérotées, et jamais effacées : une décision changée est marquée « Remplacée ».
- **Raison** : CLAUDE.md §8 ; traçabilité pour l'audit SSI.

## D-002 — Stack : Node.js 26 LTS sans dépendance npm

- **Date** : 2026-11-15 · **Statut** : Validée (2026-11-15)
- **Décision** : serveur unique en Node.js 26 LTS, avec uniquement les modules intégrés (`node:https`, `node:crypto`, `node:sqlite`, `node:test`). Interface en HTML rendu côté serveur, avec CSS et JS locaux, sans étape de build.
- **Alternatives écartées** :
  - Go : binaire unique et échappement HTML automatique, mais 2 dépendances, dont un pilote SQLite difficile à auditer, et la chaîne d'outils à installer ;
  - Python ou frameworks Node : plus de dépendances tierces.
- **Raison** : zéro code tiers à auditer, rien à installer ni à compiler.
- **Condition** : la SSI doit accepter un runtime Node sur le serveur.
- **Détail** : [`cadrage.md`](cadrage.md) §1.

## D-003 — Trame de scan binaire fixe de 36 octets

- **Date** : 2026-11-15 · **Statut** : Proposée (à valider avec Yanis)
- **Décision** : la trame a la forme `version ‖ reader_id ‖ counter ‖ AES-GCM(uid_len ‖ uid complété à 10 octets) ‖ tag`, soit 36 octets, et elle est identique en Wi-Fi et en LoRa.
- **Alternatives écartées** : JSON ou CBOR (environ 2 à 3 fois plus gros, et analyse plus complexe) ; taille variable selon l'UID (gain de 6 octets au plus).
- **Raison** : compatible avec la charge utile LoRa, validation triviale (taille exacte), même logique serveur quel que soit le transport.
- **Détail** : [`protocole.md`](protocole.md) §2.

## D-004 — AES-256-GCM de bout en bout, clé par lecteur, mère sans clé

- **Date** : 2026-11-15 · **Statut** : Proposée (à valider avec Yanis)
- **Décision** :
  - AEAD AES-256-GCM entre le boîtier fille et le serveur ;
  - nonce = `reader_id ‖ counter ‖ 0⁴`, AAD = en-tête ;
  - le boîtier mère relaie la trame telle quelle, sans détenir de clé.
- **Alternatives écartées** :
  - ChaCha20-Poly1305 : équivalent, mais sans accélération matérielle sur ESP32 et moins classique dans les référentiels ;
  - déchiffrement par la mère et re-chiffrement en TLS : une compromission de la mère suffirait alors à forger des scans.
- **Raison** : sécurité indépendante du transport ; mère plus simple et moins critique.

## D-005 — Anti-rejeu par compteur strictement croissant, sans état supplémentaire

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - une trame est acceptée seulement si son compteur est supérieur au dernier accepté pour ce lecteur, c'est-à-dire `MAX(counter)` de ses scans ;
  - la vérification est atomique, avec `UNIQUE (reader_id, counter)` en filet de sécurité ;
  - remplacer la clé d'un boîtier crée un nouveau lecteur.
- **Alternatives écartées** :
  - colonne `last_counter` sur le lecteur : un état en double ;
  - fenêtre glissante : plus complexe ;
  - horodatage dans la trame : pas d'horloge fiable sur le boîtier.
- **Raison** : simple, vérifiable en base, cohérent avec le principe « pas de donnée en double ».
- **Limite** : une trame dépassée par une plus récente est perdue.

## D-006 — Localisation dérivée par une vue

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - la localisation actuelle est l'événement le plus récent entre le dernier scan de la puce de l'objet et sa dernière correction manuelle (vue `item_locations`) ;
  - `scans` n'a pas d'`item_id` : l'objet est retrouvé par l'UID ;
  - `scans` fige `station_id` au moment du scan.
- **Alternatives écartées** :
  - colonne « localisation » sur la fiche : un doublon ;
  - `item_id` résolu à la réception : l'association d'une puce inconnue obligerait à modifier le journal.
- **Raison** : CLAUDE.md §5.3 ; journal strictement en ajout seul ; une puce associée après coup donne une localisation immédiate.
- **Détail** : [`cadrage.md`](cadrage.md) §3.

## D-007 — Heure du scan = heure de réception par le serveur

- **Date** : 2026-11-15 · **Statut** : Proposée (à valider avec Yanis)
- **Décision** : aucune heure dans la trame ; le serveur horodate à la réception.
- **Alternative écartée** : horodatage par le boîtier, qui n'a pas d'horloge fiable sans réseau.
- **Raison** : minimisation, simplicité.
- **À revoir** : si les scans peuvent être mis en mémoire hors ligne, ajouter un champ « âge du scan ».

## D-008 — Rejets uniformes côté HTTP

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - le Content-Type et le plafond de corps (64 octets) sont vérifiés par la couche HTTP ; la fonction de traitement commune ne connaît que les octets de la trame ;
  - tout rejet renvoie 400 sans corps avec `Connection: close`, quelle que soit la cause ;
  - toute exception dans le gestionnaire HTTP donne un 500 sans corps, sans jamais arrêter le serveur.
- **Alternative écartée** : garder la connexion ouverte après un rejet. Les en-têtes différeraient alors selon la cause (rejet précoce ou non).
- **Raison** : ne rien révéler à l'émetteur ; garder le traitement indépendant du transport ; résister aux requêtes mal formées.

## D-009 — Politique TLS du serveur

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - HTTPS uniquement (`node:https`), aucun port en clair ; le serveur refuse de démarrer sans certificat ni clé ;
  - TLS 1.2 au minimum. En TLS 1.2, seulement les suites ECDHE + AEAD (AES-GCM, ChaCha20-Poly1305). En TLS 1.3, les suites par défaut ;
  - pas de renégociation initiée par le client ni de tickets de session TLS 1.2 (leur clé ne serait jamais renouvelée) ;
  - au plus 256 connexions simultanées ; les échecs de poignée de main sont journalisés (code d'erreur seulement) ;
  - HSTS sur toutes les réponses ;
  - en développement, une CA locale générée par `tools/devcert.sh` (OpenSSL), restreinte par contrainte de nom à la boucle locale ; le boîtier épingle la CA ;
  - la clé privée du serveur est protégée par les droits du système de fichiers (ACL sous Windows), point à présenter à la SSI ;
  - l'adresse d'écoute devient configurable (127.0.0.1 par défaut).
- **Alternatives écartées** : TLS 1.3 seul (risque d'incompatibilité avec le client TLS du firmware ESP32, à revoir avec Yanis) ; certificats de test versionnés (des clés privées dans le dépôt).
- **Raison** : CLAUDE.md §4 ; recommandations courantes de l'ANSSI pour TLS.
- **À voir** : la PKI du site pilote (CA ONERA ?) et le mTLS pour le boîtier mère.

## D-010 — Aucun rôle utilisateur dans le MVP

- **Date** : 2026-11-17 · **Statut** : Validée (2026-11-17)
- **Décision** : tout compte actif peut tout faire, y compris gérer les postes, les lecteurs et leurs clés. Les comptes sont créés uniquement en ligne de commande (`user-add`), sur le serveur.
- **Alternative écartée** : un rôle « administrateur » séparé. Il faudrait des contrôles d'accès sur chaque route et leurs tests, pour une équipe pilote réduite.
- **Raison** : principe « la version la plus simple d'abord ». La création de comptes reste réservée à qui a accès au serveur. À rouvrir si la SSI l'exige.

## D-011 — Authentification des utilisateurs : paramètres

- **Date** : 2026-11-17 · **Statut** : Proposée
- **Décision** :
  - argon2id (`node:crypto`), m = 19 456 Kio, t = 2, p = 1, sel de 16 octets, empreinte de 32 octets, format PHC. Ce sont les paramètres minimaux recommandés par l'OWASP. Les calculs argon2 passent un par un dans une file unique et **bornée à 16** calculs en attente ou en cours. Au-delà, le serveur répond 503 sans calcul. Si le client a déjà coupé, aucun calcul n'est lancé. Ainsi la mémoire et le CPU restent bornés (revue de l'étape 3, B1). Le 503 réaffiche la page de connexion avec un message, et ferme la connexion : les requêtes enchaînées derrière lui sur la même connexion ne reçoivent pas de réponse (étape 4). Effets : plus de 16 tentatives de connexion simultanées reçoivent 503 ; un attaquant peut occuper la file en continu, ce qui est accepté sur réseau local pour le MVP ;
  - mot de passe d'au moins 12 caractères ; identifiant limité à `[A-Za-z0-9._-]`, de 1 à 64 caractères, pour qu'il puisse s'afficher sans échappement à l'étape 3 ;
  - session : jeton aléatoire de 32 octets dans le cookie `__Host-mt_session` (`HttpOnly; Secure; SameSite=Strict; Path=/`), seul son SHA-256 est stocké ; durée absolue de 8 h, sans prolongation ; nouveau jeton à chaque connexion ;
  - CSRF : tout POST de l'interface exige un en-tête `Origin` égal à `https://` + `Host`, et un jeton. Avec une session, le jeton est HMAC-SHA256(jeton de session, « csrf »), il n'est donc pas stocké. Pour le formulaire de connexion, c'est un cookie court `__Host-mt_login_csrf` comparé au champ du formulaire (double soumission) ;
  - mot de passe normalisé en NFC avant le hachage et la vérification ; formulaire refusé si son `charset` n'est pas UTF-8 ; requêtes refusées journalisées avec seulement la cause et l'adresse ;
  - échec de connexion : message générique, réponse retardée d'1 s (ce délai ralentit chaque réponse mais ne limite pas le débit global d'essais, environ 50 par seconde ; pas de verrouillage de compte, acceptable avec 12 caractères minimum), et calcul argon2 sur une empreinte factice si le compte n'existe pas ou est désactivé (pas d'énumération des comptes par le temps de réponse) ;
  - `POST /api/frames` n'est pas concerné (boîtiers authentifiés par l'AEAD, D-004) ;
  - `Referrer-Policy: same-origin` et non `no-referrer` : avec `no-referrer`, les navigateurs envoient `Origin: null` sur un POST de formulaire, et le contrôle d'`Origin` refuserait toute connexion. `same-origin` n'envoie aucun Referer vers un autre site.
- **Alternatives écartées** : paramètres argon2 RFC 9106 (64 Mio, p = 4), plus coûteux en mémoire par tentative ; jeton CSRF stocké en base, une colonne de plus pour le même effet ; expiration glissante, plus de code.
- **Raison** : CLAUDE.md §4, cadrage.md §4 étape 3.

## D-012 — Recentrage : un logiciel fonctionnel et soigné, sans préparation du pilote

- **Date** : 2026-11-17 · **Statut** : Validée (2026-11-17, demande de l'humain)
- **Décision** :
  - l'étape 8 « Préparation du pilote » (cadrage.md §4 : dossier SSI, installation hors ligne, systemd) sort du plan pour l'instant ;
  - l'objectif devient un logiciel fonctionnel, visuellement correct, qui respecte toutes les exigences techniques déjà fixées (CLAUDE.md §4 et §5, D-002 à D-011). Elles restent toutes en vigueur : HTTPS, AEAD, aucune ressource externe, zéro dépendance, journaux ;
  - la qualité visuelle de l'interface devient un critère de réussite de chaque étape qui touche à l'interface (3 à 7).
- **Raison** : priorité de l'humain. L'ONERA reste un pilote possible plus tard.

## D-013 — Calcul de la localisation par sous-requête indexée

- **Date** : 2026-11-17 · **Statut** : Proposée
- **Décision** : la vue `item_locations` (D-006) est réécrite par la migration 003. Pour chaque objet, une sous-requête corrélée lit le dernier scan de sa puce dans l'index `scans_by_uid`, au lieu d'un `row_number()` sur tous les scans. La sémantique et les colonnes sont identiques, ainsi que le départage (heure de réception, puis id). L'équivalence est testée.
- **Raison** : mesure de la revue sécurité. Avec 300 000 scans, la liste passait de 1,9 s à 44 ms et la fiche de 1,9 s à 0,2 ms. `node:sqlite` est synchrone : une vue lente bloquait tout le serveur, réception des trames comprise.
- **Pour l'étape 5** : garder cette forme, avec une sous-requête pour le dernier scan, une pour la dernière correction manuelle, et la plus récente des deux l'emporte.
- **Alternative écartée** : une colonne de localisation stockée sur la fiche. Elle serait un doublon (CLAUDE.md §5.3).

## D-014 — Numéros de fiche jamais réutilisés (AUTOINCREMENT)

- **Date** : 2026-11-18 · **Statut** : Validée (2026-11-18, accord de l'humain)
- **Décision** : la table `items` est reconstruite avec `INTEGER PRIMARY KEY AUTOINCREMENT` dans la migration 004 (étape 5). Un numéro de fiche supprimée n'est jamais redonné à une autre fiche.
- **Raison** (revue sécurité et testeur, étape 5) :
  - sans AUTOINCREMENT, SQLite redonne le plus grand numéro libéré : `audit_log.entity_id` pouvait alors désigner plusieurs objets successifs ;
  - un formulaire ouvert avant une suppression pouvait viser, sans le savoir, la nouvelle fiche qui avait repris le numéro ;
  - le contournement à l'affichage de l'historique devient inutile.
- **Alternatives écartées** :
  - contournement à l'affichage seul : journal brut ambigu ;
  - jeton de version dans les formulaires : plus de code, journal toujours ambigu ;
  - suppression logique : sémantique changée, UID bloqué.
- **Coût** : reconstruction de la table au moment de la migration (copie des lignes, mêmes contraintes). Aucune clé étrangère ne visait `items` avant la migration 004. La séquence repart du plus grand numéro existant : un numéro supprimé AVANT la migration 004 peut donc resservir une fois. Sans effet sur le journal, qui n'existait pas encore, mais un ancien lien `/items/<n>` peut alors désigner une autre fiche.

## Limites acceptées pour le MVP (étape 5)

- Deux personnes qui modifient la même fiche en même temps : la dernière enregistrée l'emporte. L'audit garde les deux versions.
- Un double clic sur « Créer la fiche » peut créer deux fiches identiques. On en supprime une à la main, et l'audit le montre.
- Les propriétés dont le nom est un nombre entier (« 10 ») s'affichent en tête. Le schéma impose un objet JSON, dont l'ordre des clés est fixé.
