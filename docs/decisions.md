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
- **Amendement (2026-11-25, étape U0)** :
  - « 400 sans corps » et « 500 sans corps » ne valent plus que pour `POST /api/frames`, avec le contrat des boîtiers inchangé.
  - L'interface web renvoie maintenant des pages au texte constant pour les 400, 404, 405, 413 et 500, et « Action refusée » pour le 403, toujours avec `Connection: close`. Rien de la requête n'y est repris.
  - Si la page d'erreur elle-même échoue : 500 sans corps.

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
- **Amendement (2026-11-25, étape U0)** :
  - Nouveau cas « page de connexion restée ouverte » : `Origin` correcte, champ CSRF bien formé, mais cookie `__Host-mt_login_csrf` absent (expiré au bout de 10 min). La page de connexion est réaffichée en 200, avec un message et un nouveau jeton. Il n'y a ni argon2, ni session, ni délai, puisque aucun mot de passe n'est vérifié. Ce chemin ne permet donc pas d'essayer des mots de passe plus vite.
  - L'identifiant saisi est réaffiché uniquement s'il respecte `USERNAME_FORMAT`, et toujours échappé par le gabarit.
  - Tous les autres écarts donnent toujours 403 : `Origin` absente ou fausse, champ absent ou mal formé, cookie présent mais différent.
  - `/login?info=session` affiche un message pris dans une liste fermée (`LOGIN_INFO`). Cette redirection n'est utilisée que si un cookie de session, devenu invalide, était présent ; sans cookie, la redirection va vers `/login`, sans message.
  - Cas restant : un vieil onglet de connexion renvoyé après l'ouverture d'un autre onglet (cookie présent mais différent) reçoit toujours 403.

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
- Complétée par D-016 (heure d'arrivée).

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

## D-015 — Numéros de poste jamais réutilisés (sans changement de schéma)

- **Date** : 2026-11-18 · **Statut** : Validée (2026-11-19, accord de l'humain)
- **Décision** : un nouveau poste reçoit le plus grand numéro déjà attribué plus 1. Ce plus grand numéro tient compte des postes existants et des postes supprimés, retrouvés dans les lignes `station.delete` d'`audit_log`. Le calcul est fait dans la transaction de création.
- **Raison** : même risque que pour D-014.
  - Les lignes d'audit `station.*` et `reader.assign` pourraient désigner deux postes différents.
  - Un formulaire « Changer de poste » resté ouvert pourrait affecter un lecteur au poste qui a repris le numéro : ses scans iraient alors au mauvais endroit.
- **Alternative écartée** : AUTOINCREMENT comme D-014. `stations` est référencée par trois clés étrangères (readers, scans, location_corrections). La reconstruire exige `foreign_keys = OFF`, ce qui n'est pas possible dans la transaction de migration.
- **Coût** : une lecture d'`audit_log` à chaque création de poste, opération rare (de l'ordre de la milliseconde).

## Limites acceptées pour le MVP (étape 6)

- La clé d'un lecteur s'affiche dans la réponse au formulaire de création ou de remplacement. Recharger cette page, ou cliquer deux fois, crée un lecteur de plus dont personne n'a la clé. Ce lecteur est inutilisable : il suffit de le désactiver. La page en avertit. Ce lecteur porte le même nom que l'original (D-019) : on le reconnaît à son numéro, affiché dans les listes.
- Malgré `Cache-Control: no-store`, certains navigateurs peuvent remontrer la page de clé avec le bouton Retour dans le même onglet. La page demande de fermer l'onglet une fois la clé injectée.
- Un lecteur désactivé ne se réactive pas et ne change plus de poste. Le poste auquel il était affecté ne peut donc plus être supprimé, mais il peut être renommé. Le lecteur désactivé peut lui aussi être renommé (D-019).

## Limites acceptées pour le MVP (étape 7)

- **Réutilisation d'une puce.** Une puce détachée d'une fiche (remplacement de puce ou suppression de la fiche) redevient une puce inconnue et garde ses scans. Si on l'associe ensuite à une autre fiche, celle-ci hérite de cet historique et de la dernière localisation. Le modèle reste inchangé (D-006, cadrage §3.1). Les pages de création et d'association avertissent quand la puce a déjà appartenu à une fiche. La règle d'usage reste : ne pas réutiliser une puce.
- **Puces inconnues.** La liste affiche au plus les 200 puces les plus récentes, avec la mention qu'il y en a d'autres. Son coût dépend du nombre d'UID distincts dans le journal. Un lecteur compromis qui inonderait le journal de faux UID ferait durer chaque affichage de cette page environ 0,45 s à 300 000 UID distincts. Pendant ce temps, tout le serveur attend, y compris la réception des trames. C'est une limite résiduelle acceptée pour le MVP.
- **Partage du serveur.** `node:sqlite` répond de façon synchrone : quand beaucoup de pages sont demandées en même temps, la réception d'un scan attend qu'elles soient servies (mesuré : environ 290 ms au lieu de 3 ms avec 8 clients qui rechargent sans arrêt la liste des puces). C'est acceptable pour un usage local à quelques utilisateurs.
- **Pas de compteur de puces inconnues dans le bandeau.** Il coûterait environ 20 ms par page.
- **UID dans les adresses `/chips/<UID>` : majuscules seulement, sans normalisation.** Une adresse en minuscules donne 404. Les liens de l'application sont toujours en majuscules.
- **Association.** La confirmation porte la puce que la fiche avait au moment de l'affichage. Si elle a changé entre-temps, l'association est refusée (409) sans rien écrire.

## D-016 — « Depuis » = heure d'arrivée à l'emplacement actuel, calculée

- **Date** : 2026-11-25 · **Statut** : Proposée (étape U0)
- **Décision** :
  - « Depuis » affiche l'heure du **premier** événement de la dernière série ininterrompue au même emplacement. Un événement est un scan de la puce actuelle ou une correction manuelle. « Lecteur non affecté » compte comme un emplacement à part.
  - L'ordre des événements est celui de la vue : heure, puis scan avant correction, puis numéro.
  - Rien n'est stocké (D-006, CLAUDE.md §5.3) : la colonne `arrived_at` est recalculée à chaque lecture par `withLocations` (`server/inventory.js`).
  - Migration 006 : l'index `scans_by_uid` devient `(uid_nfc, received_at, id, station_id)`. La remontée se fait alors dans l'index seul (index couvrant).
  - La remontée est bornée à `MAX_RUN_SCANS` (voir « Limites acceptées pour le MVP (étape U0) »).
- **Coûts mesurés** (5 000 objets, 300 000 scans) :
  - `GET /` de +21 à +37 % ;
  - pire cas, des objets toujours scannés au même poste : 89 ms avec l'index, 1,8 s sans.
- **Alternatives écartées** :
  - une colonne `arrived_at` stockée : un doublon ;
  - garder l'heure du dernier scan : affichage trompeur, audit UX G1 (« depuis 20 min » pour un objet présent depuis 3 jours).
- **Raison** : audit UX, parcours « Où est cet objet ? ».

## Limites acceptées pour le MVP (étape U0)

- **Coût de « Depuis »**. Le calcul remonte la dernière série de scans d'une même puce au même poste. Deux situations peuvent la rendre très longue :
  - une puce posée en permanence sur un lecteur, si le firmware émet une trame à chaque lecture ;
  - un lecteur compromis.

  Pour borner ce coût, la remontée ne lit que les `MAX_RUN_SCANS = 2000` scans les plus récents de la puce (`server/inventory.js`). Si ces 2 000 scans sont tous au poste actuel, l'heure affichée est celle du plus ancien d'entre eux, précédée de « au moins » (liste, fiche poste) ou de « depuis au moins » (fiche objet). C'est vrai aussi pour une puce qui a exactement 2 000 scans au même poste : « au moins » reste exact.
  - Coût mesuré : le temps ne croît plus avec la longueur de la série (liste à environ 23 ms avec 2 000, 50 000 ou 300 000 scans d'affilée).
  - Sur des données ordinaires, la borne coûte environ 2 µs par objet : `GET /` passe à +30 % par rapport à l'état d'avant U0.
  - Pire cas global : environ 0,2 ms par objet dont la série atteint la borne, soit environ 1 s si les 5 000 objets l'atteignent. Il faudrait pour cela plus de 10 millions de trames injectées, ce qui se verrait dans le journal. Même ordre de grandeur que la limite des puces inconnues (étape 7).
  - La recherche de la dernière correction vers un autre poste n'est pas bornée : seuls des utilisateurs connectés peuvent créer des corrections. **Question pour Yanis** : le boîtier émet-il une trame à chaque lecture, ou seulement quand la puce arrive ?
- **Page de connexion**. Un navigateur qui refuse les cookies affiche en boucle « page restée ouverte trop longtemps ».

## D-017 — Direction visuelle B « Clair et aéré »

- **Date** : 2026-11-26 · **Statut** : Validée (2026-11-26, choix de l'humain)
- **Décision** : l'interface reprend la direction B de `docs/maquettes/direction-b/` :
  - une barre supérieure claire et fine, sans bloc sombre ;
  - une colonne de contenu aérée ;
  - des bordures fines plutôt que des ombres ;
  - le bleu nuit pour le texte, le vert canard pour les actions, l'orange pour l'attention ;
  - les polices Space Grotesk, Inter et JetBrains Mono, embarquées ;
  - le jeu d'icônes du projet.

- **Mise en œuvre (étape U1, 2026-11-26)** :
  - **mode sombre activé**, selon le réglage du système (`prefers-color-scheme`), avec des contrastes AA vérifiés par `test/design-system.test.js` ;
  - rôle de couleur **« danger »** (#B3261E, #F2958C en sombre) ajouté pour les actions irréversibles et les erreurs ;
  - **route statique** (`server/web.js`) : une liste blanche de 6 chemins exacts, chargés en mémoire au démarrage. Types MIME fixes, `nosniff`, CSP inchangée. `no-cache` pour les CSS et le SVG, une semaine pour les polices. Aucun chemin de fichier n'est dérivé de l'URL ;
  - polices OFL 1.1 embarquées dans `web/static/fonts/`, avec leurs licences. Provenance : dépôt officiel `google/fonts`, branche main, téléchargées le 2026-11-25. Empreintes SHA-256 :
    - Inter-Variable.ttf : `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` ;
    - JetBrainsMono-Variable.ttf : `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda` ;
    - SpaceGrotesk-Variable.ttf : `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72`.
  - Logo officiel fourni par l'humain, redessiné en vectoriel (`web/static/logo.svg` : formes seules, sans script ni ressource externe). Icône du raccourci : `tools/metrotrack.ico` (SHA-256 `5d0f161e6bf0695127b0c05e825560555a7ea8ad6fe337ac16239bf328e87269`).
- **Alternatives écartées** : A « Atelier chaleureux » et C « Plan des postes ».
- **Raison** : choix de l'humain après consultation des maquettes.

## D-018 — Lanceur de démonstration sur Windows (avant le vrai .exe)

- **Date** : 2026-11-26 · **Statut** : Proposée
- **Constat** : Smart App Control est **activé** sur le PC de développement. Il bloque tout `.exe` non signé, ce qui a été vérifié avec un exécutable Node empaqueté.
- **Décision** :
  - pour voir le logiciel tout de suite, un raccourci « MetroTrack » (bureau et menu Démarrer) lance `node.exe`, signé par la fondation OpenJS, avec `tools/lanceur.mjs` ;
  - le lanceur démarre le serveur s'il ne tourne pas, puis ouvre une fenêtre Edge en mode application, avec un profil dédié ;
  - la fenêtre ne fait confiance qu'au certificat de CE serveur (empreinte de sa clé publique), sans ajouter d'autorité de certification au magasin de Windows.
- **Options d'Edge utilisées** (`tools/lanceur.mjs`) :
  - `--app`, `--user-data-dir=%LOCALAPPDATA%\MetroTrack\fenetre` (profil dédié), `--no-first-run`, `--window-size=1440,900` ;
  - `--ignore-certificate-errors-spki-list=<empreinte>` : seule la clé publique du serveur de la configuration est acceptée, et jamais l'option globale `--ignore-certificate-errors` ;
  - `--disable-sync` et `--disable-features=msImplicitSignin` : le profil ne se relie pas au compte Microsoft. `msImplicitSignin` n'est pas documenté par Microsoft ; son effet a été vérifié sur des profils neufs. Le profil créé avant ces options (relié au compte) a été supprimé par l'humain ;
  - **`--test-type`** : une option de test de Chromium qui masque le bandeau « indicateur de ligne de commande non pris en charge ». Elle peut aussi masquer d'autres avertissements. Acceptée **pour le lanceur de démonstration seulement**, à retirer ou remplacer dans le vrai `.exe`. **Choix à confirmer par l'humain** : la garder, ou l'enlever et accepter le bandeau.
- **Appels sortants d'Edge** : Edge reste un navigateur Microsoft (télémétrie, SmartScreen, mises à jour). Ce ne sont pas des appels de MetroTrack, mais un audit SSI les relèvera. Pour un déploiement réel, il faudra brider Edge par des stratégies de groupe, ou passer à WebView2 avec une configuration contrôlée.
- **À venir** : le vrai `.exe` signé (étapes U8 et U9 de `docs/ux/plan.md`). Pour l'instant, l'humain a choisi de garder le raccourci.

## D-019 — Nom libre pour les lecteurs

- **Date** : 2026-11-26 · **Statut** : Validée (2026-11-26, accord de l'humain)
- **Décision** :
  - les lecteurs reçoivent un nom libre et facultatif (par exemple « Boîtier établi gauche »), modifiable dans l'interface ;
  - à l'écran, le lecteur est désigné par son nom s'il en a un, sinon par « Lecteur du <poste> » s'il est affecté, et en dernier recours par « Lecteur n° X » ;
  - le numéro reste visible sur la fiche du lecteur et sur la page de clé, car c'est lui qu'on configure dans le boîtier ;
  - migration 007 : colonne `name` sur `readers`, texte borné et nettoyé comme les autres noms ;
  - le contrat avec les boîtiers est inchangé : la trame porte toujours le numéro.
- **Raison** : l'audit UX relève que « Lecteur n° 7 » ne permet pas de savoir de quel boîtier physique il s'agit.
- **Mise en œuvre (2026-11-26)** :
  - une seule fonction construit la désignation : `readerLabel` (`server/views.js`). Libellé retenu : « Lecteur du poste <nom> », plutôt que « Lecteur du <nom> », qui donnerait « Lecteur du Atelier » (**à confirmer par l'humain**) ;
  - nom facultatif, 100 caractères au plus (CHECK en base, migration 007), nettoyé par `cleanLine` ; s'il n'est pas vide, il doit contenir au moins un caractère visible ;
  - pas d'unicité : un lecteur remplacé et son remplaçant portent le même nom (le remplaçant reprend le nom), et le poste et l'état les distinguent ;
  - « Renommer » reste possible sur un lecteur désactivé. Audit : `reader.rename` `{name: {before, after}}`. Le nom figure aussi dans `reader.create` ;
  - frise des scans d'un objet : « Scanné par <nom> » seulement si le lecteur a un nom. C'est le nom **actuel** du lecteur : seul le poste du scan est historique. La pastille « lecteur non affecté » reste un état, sans nom ;
  - le numéro reste affiché comme « Numéro à configurer dans le boîtier » (fiche et page de clé), et en information secondaire dans les listes de lecteurs et sur la fiche poste ;
  - le nom n'existe que côté serveur : il ne transite jamais par la radio, et `docs/protocole.md` est inchangé ;
  - limite acceptée : un nom peut imiter un libellé automatique (par exemple « Lecteur n° 3 »). Seuls les utilisateurs connectés peuvent renommer un lecteur.

## D-020 — Ouverture concurrente de la base

- **Date** : 2026-11-26 · **Statut** : Proposée
- **Décision** (`server/db.js`) :
  - `busy_timeout` est réglé en premier ;
  - le passage en WAL est réessayé sur `SQLITE_BUSY` seulement, toutes les 10 ms et au plus pendant 5 s ;
  - `user_version` est relu sous `BEGIN IMMEDIATE`, ce qui rend toute double migration impossible.
- **Raison** : sur une base neuve, deux processus qui l'ouvraient en même temps pouvaient échouer tous les deux (« database is locked »). Cas constaté avec le lanceur.
- **Alternative écartée** : un verrou de fichier externe, plus complexe.

## D-021 — Un fichier JavaScript local, en amélioration progressive

- **Date** : 2026-11-26 · **Statut** : Validée (2026-11-26, accord de l'humain pour lancer U2 avec du JavaScript local)
- **Décision** :
  - fin de la règle « aucun JavaScript client » : un seul fichier `web/static/app.js`, écrit à la main, sans dépendance, servi par la route statique en liste blanche ;
  - aucun script en ligne, aucun gestionnaire `on…=`, CSP `default-src 'self'` inchangée ;
  - le DOM est construit uniquement avec `textContent` et `createElement`, jamais avec `innerHTML` ;
  - chaque page reste utilisable sans JavaScript (formulaires classiques) ;
  - premiers usages (U2) : recherche `Ctrl K`, résultats pendant la frappe.
- **Raison** : parcours « Où est cet objet ? » (docs/ux/carte-et-parcours.md §3), audit UX.
- **Alternative écartée** : un framework (dépendances, D-002).
- **Mise en œuvre (étape U2, 2026-11-27)** :
  - recherche par mots (`server/inventory.js`) : chaque mot doit se trouver dans le nom, dans une valeur de propriété, ou (mot hexadécimal) dans le numéro de puce. La saisie entière reste cherchée comme numéro de puce. Classement : nom qui commence par le premier mot, puis mots entiers, puis morceaux de mots, puis propriétés et puce, puis ordre alphabétique. Les emplacements ne sont calculés que pour les fiches retenues ;
  - `GET /api/recherche?q=` (et `&tout=1` pour la page Inventaire) :
    - session obligatoire (401 JSON sinon) ; refus 403 si `Sec-Fetch-Site` est présent et différent de `same-origin` ; q de plus de 200 caractères refusé (400) ;
    - réponse JSON en `no-store`, avec `<`, `>`, `&`, U+2028 et U+2029 échappés ;
    - au plus 8 résultats et le total. Le numéro de puce n'est renvoyé que s'il correspond à la saisie ;
  - `app.js` est servi en `no-cache` et chargé avec `defer` sur les pages connectées seulement ; `/items/new?nom=` pré-remplit le nom ;
  - mesure (5 000 objets, 5 propriétés chacun, 100 000 scans) : de 25 à 38 ms côté serveur, et de 27 à 32 ms en requête HTTPS complète.

## D-022 — Méthode pendant la phase UX : priorité à l'expérience, audit de sécurité différé

- **Date** : 2026-11-27 · **Statut** : Validée (2026-11-27, demande de l'humain : « tout ce qui est sécurité, on verra dans un second temps ; il faut que ça marche, que ce soit beau et adapté à un utilisateur lambda »)
- **Décision** :
  - la boucle par étape devient `dev`, puis `testeur`, puis **`revue-ux`** (nouvel agent, `.claude/agents/revue-ux.md`, en lecture seule) ;
  - la `revue-securite` n'est plus lancée à chaque étape : un audit de sécurité complet sera fait avant toute livraison à un client ;
  - les garde-fous déjà en place restent dans le code et dans les tests : HTTPS, CSRF, échappement, CSP, zéro dépendance, aucune ressource externe. Les étapes ne doivent pas les retirer. Les tests existants le vérifient.
- **Raison** : priorité de l'humain sur l'expérience utilisateur.

### Compléments (étape U2, aller-retour 2, 2026-11-27)
- **D-019** : désignation d'un lecteur sans nom.
  - Si le nom du poste commence déjà par « Poste » : « Lecteur du Poste 2 ».
  - Sinon : « Lecteur · Atelier ».
- **D-021** : classement de la recherche en 6 rangs.
  1. Mots entiers, en commençant par les noms qui débutent par le premier mot.
  2. Débuts de mots, dans le même ordre (les noms sont aussi coupés entre lettres et chiffres : « fluke 87 » met 87V en tête).
  3. Morceaux de mots.
  4. Correspondance dans une propriété ou dans le numéro de puce.
  5. À rang égal, ordre alphabétique.
- **D-021, page Inventaire** : quand le champ est vidé, la liste de départ est réaffichée sans appel au serveur. La réponse `&tout=1` est allégée.
- **D-021, association d'une puce** : la recherche s'y fait aussi pendant la frappe, avec les fiches sans puce en tête.
- **D-021, page de clé** : bouton « Copier la clé » (`navigator.clipboard.writeText`, écriture seule). Le texte de la page est réduit à une phrase. L'avertissement « ne rechargez pas » a été retiré de la page ; le risque reste décrit dans les limites de l'étape 6.
