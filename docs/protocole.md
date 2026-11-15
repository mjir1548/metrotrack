# MetroTrack — Protocole boîtier ↔ serveur

Version : **v0, brouillon, à valider avec Yanis**.
Date : 2026-11-15.

Les points marqués **⚠️ À VALIDER (Yanis)** ne sont pas figés. Tout changement du contrat est consigné ici et dans [`decisions.md`](decisions.md).

---

## 1. Principe

Un **boîtier lecteur** (« boîtier fille », un par poste) lit l'UID d'une puce NFC et émet une **trame de scan** de 36 octets.

- La trame est **chiffrée et authentifiée de bout en bout**, du boîtier fille jusqu'au serveur (AEAD, clé propre à chaque boîtier).
- **La même trame, octet pour octet**, arrive au serveur quel que soit le chemin :

```
Aujourd'hui :  [ESP32 + NFC] --HTTPS (Wi-Fi)----------------------------------------> [Serveur]
Demain :       [Fille ESP32] --LoRa (trame brute)--> [Mère] --HTTPS/TLS (trame brute)--> [Serveur]
```

- Le serveur ne sait pas, et n'a pas besoin de savoir, par quel chemin une trame est arrivée. Le transport ne fait que livrer des octets. La vérification et le traitement sont identiques.
- Le boîtier mère est un **relais transparent** : il ne détient aucune clé de boîtier fille, ne déchiffre rien et n'ajoute rien à la trame. ⚠️ À VALIDER (Yanis)

**Minimisation** : la trame contient seulement la version, l'identifiant du lecteur, un compteur, l'UID chiffré et le tag d'authentification. Aucune donnée de fiche, aucun horodatage, aucune donnée personnelle.

---

## 2. Format de la trame v0

Taille **fixe : 36 octets**. Entiers non signés en **big-endian** (ordre réseau).

| Octets | Taille | Champ | Protection | Description |
|---|---|---|---|---|
| 0 | 1 | `version` | authentifié, en clair | `0x01` pour ce format |
| 1–4 | 4 | `reader_id` | authentifié, en clair | identifiant du lecteur (uint32, ≥ 1), sert au serveur à choisir la clé |
| 5–8 | 4 | `counter` | authentifié, en clair | compteur du lecteur (uint32), **strictement croissant**, commence à 1 (la valeur 0 est toujours rejetée) |
| 9–19 | 11 | `ciphertext` | chiffré + authentifié | contenu chiffré (voir ci-dessous) |
| 20–35 | 16 | `tag` | — | tag d'authentification AES-GCM (128 bits) |

**Contenu en clair** avant chiffrement (11 octets) :

| Octets | Taille | Champ | Description |
|---|---|---|---|
| 0 | 1 | `uid_len` | longueur de l'UID : `4`, `7` ou `10` |
| 1–10 | 10 | `uid` | UID de la puce, complété par des `0x00` jusqu'à 10 octets |

Pourquoi une taille fixe : le serveur rejette tout ce qui ne fait pas exactement 36 octets, ce qui simplifie la validation. La longueur de l'UID (donc le type de puce) n'est pas visible sur la radio. Le surcoût est d'au plus 6 octets.

⚠️ À VALIDER (Yanis) :
- type de puces NFC retenu et longueur d'UID (les NTAG21x ont un UID de 7 octets) ;
- les puces doivent avoir un **UID fixe** : certaines cartes renvoient un UID aléatoire à chaque lecture et sont inutilisables ici.

---

## 3. Cryptographie

| Élément | Valeur |
|---|---|
| Algorithme | **AES-256-GCM** |
| Clé | 32 octets, **une par lecteur**, générée par le serveur (CSPRNG) |
| Nonce (12 octets, non transmis) | `reader_id` (4) ‖ `counter` (4) ‖ `00 00 00 00` |
| Données associées (AAD) | les 9 premiers octets de la trame : `version` ‖ `reader_id` ‖ `counter` |
| Texte clair | les 11 octets du §2 |
| Sortie | `ciphertext` (11 octets) ‖ `tag` (16 octets) |

Raisons du choix :
- AES-GCM est le mode AEAD le plus classique dans les référentiels (ANSSI notamment) ;
- l'ESP32 dispose d'une accélération matérielle AES, et mbedTLS fournit `mbedtls_gcm_*` ;
- la clé de 256 bits ne coûte rien de plus en taille de trame.

L'UID est chiffré parce qu'une émission LoRa peut être captée à grande distance, y compris hors du site. En clair, elle révélerait quel objet se trouve où.

ChaCha20-Poly1305 reste une alternative équivalente si Yanis la préfère. ⚠️ À VALIDER (Yanis)

### Règle impérative côté firmware : un compteur ne sert jamais deux fois

Avec AES-GCM, chiffrer deux trames avec la même clé et le même nonce (donc le même compteur) est **catastrophique** :
- un observateur radio peut retrouver les UID ;
- il peut même fabriquer des trames valides.

Le serveur **ne peut pas** protéger contre cela, car les trames ont déjà été émises sur la radio. Donc :
- le compteur est **persistant** (NVS) et survit aux redémarrages et aux coupures d'alimentation ;
- pour ménager la flash, on peut réserver des blocs : écrire `compteur + N` en NVS tous les N scans, et repartir de la valeur stockée au démarrage. On perd au plus N valeurs, ce qui est sans conséquence ;
- **tout reflash ou réinitialisation de la NVS impose une nouvelle clé**, c'est-à-dire un nouveau provisionnement (voir §6) ;
- à 2³² − 1, le boîtier cesse d'émettre et doit être reprovisionné. C'est théorique : 4 milliards de scans.

⚠️ À VALIDER (Yanis) : mécanisme de persistance du compteur sur le prototype.

---

## 4. Transports

### 4.1 Aujourd'hui : Wi-Fi direct (prototype ESP32)

```
POST /api/frames HTTP/1.1
Host: <serveur>
Content-Type: application/octet-stream
Content-Length: 36

<36 octets de la trame>
```

- La cible de requête doit être le chemin `/api/frames` (pas d'URL absolue `http://hôte/...`), sinon la réponse est 404.
- **HTTPS** (TLS 1.2 au minimum). Le boîtier vérifie le certificat du serveur grâce à une CA locale embarquée dans le firmware.
- Depuis l'étape 2 du plan, le serveur n'écoute **qu'en HTTPS** (aucun port en clair, en-tête HSTS) :
  - TLS 1.2 minimum ; en TLS 1.2, uniquement des suites ECDHE + AEAD (AES-GCM, ChaCha20-Poly1305) ; TLS 1.3 avec ses suites par défaut ;
  - en développement, la CA et le certificat serveur (clés EC P-256, SAN `localhost`, `127.0.0.1`, `::1`) sont générés par `tools/devcert.sh` dans `dev/tls/` (non versionné) ;
  - le boîtier (ou la mère) **épingle la CA** : il n'accepte que les certificats signés par elle, et ne désactive jamais la vérification du certificat. Le simulateur fait de même (`--ca dev/tls/ca.crt`).
- ⚠️ À VALIDER (Yanis) :
  - le prototype sait-il faire un client HTTPS (ESP-IDF `esp_http_client` / mbedTLS) avec une CA épinglée ?
  - qu'envoie-t-il aujourd'hui (format, protocole), pour estimer l'écart avec ce document ?

### 4.2 Demain : LoRa puis boîtier mère

- **Fille → mère** : la charge utile radio est **exactement** la trame de 36 octets, en LoRa point à point.
  - LoRaWAN est écarté : il exigerait un serveur réseau LoRaWAN, donc un composant de plus.
- **Mère → serveur** : la même requête `POST /api/frames`, trame inchangée, sur TLS.
  - L'authentification de la mère par certificat client (mTLS) est envisagée, à discuter.
  - Sans mTLS, la sécurité des scans reste assurée par l'AEAD de chaque trame. Une machine du réseau pourrait seulement envoyer des trames invalides, qui sont rejetées.
- La mère ne détient aucune clé de boîtier fille. Si elle est compromise, elle peut retarder, bloquer ou supprimer des trames, mais ni les lire ni en fabriquer.

Ordre de grandeur radio pour 36 octets (BW 125 kHz, CR 4/5) :

| Facteur d'étalement | Temps d'antenne | Avec 1 % de rapport cyclique |
|---|---|---|
| SF7 | environ 80 ms | 1 trame toutes les ~8 s par boîtier |
| SF12 | environ 2 s | 1 trame toutes les ~3 min par boîtier |

⚠️ À VALIDER (Yanis) :
- LoRa point à point, bande et facteur d'étalement, rapport cyclique ;
- acquittement radio et retransmissions entre fille et mère ;
- file d'attente dans la mère si le serveur est indisponible.

---

## 5. Traitement côté serveur (ordre normatif)

Le point d'entrée HTTP extrait les octets du corps et note l'heure de réception. Il appelle ensuite **une seule fonction de traitement**, la même pour tous les transports.

Contrôles propres au transport HTTP, faits avant la fonction de traitement :
- `Content-Type: application/octet-stream` (casse et paramètres tolérés). Sinon : rejet, sans lire le corps ;
- corps plafonné à 64 octets. Au-delà, la lecture s'arrête et la requête est rejetée.

Fonction de traitement commune :

1. **Taille** = 36 octets exactement. Sinon : rejet.
2. **`version`** = `0x01`. Sinon : rejet.
3. **Lecteur** `reader_id` connu et actif. Sinon : rejet.
4. **Compteur** > dernier compteur accepté pour ce lecteur. Sinon : rejet (rejeu). Ce test est un filtre rapide ; il est refait de façon atomique à l'étape 7.
5. **Déchiffrement AES-GCM** avec la clé du lecteur. La vérification du tag se fait en temps constant, dans OpenSSL. Si le tag est invalide : rejet.
6. **Contenu** : `uid_len` ∈ {4, 7, 10} et octets de bourrage nuls. Sinon : rejet. Une trame authentifiée mais mal formée signale un bug firmware.
7. **Enregistrement atomique** du scan dans une transaction : nouvelle vérification du compteur, puis insertion.
   - L'insertion fige le poste auquel le lecteur est affecté à cet instant.
   - La contrainte d'unicité `(reader_id, counter)` sert de filet de sécurité.
8. Réponse **204**.

Le serveur n'ajoute ni ne modifie rien dans la trame. Il n'existe aucun chemin où une trame non authentifiée modifie l'état. Les rejets sont écrits dans le journal du serveur, mais pas dans la base, pour qu'un flot de trames invalides ne puisse pas la remplir.

### Réponses HTTP

| Code | Sens | Conduite du boîtier ou de la mère |
|---|---|---|
| 204 | trame acceptée | trame suivante (la connexion reste ouverte) |
| 400 | trame rejetée, **quelle que soit la cause**, sans corps | **ne pas renvoyer** cette trame |
| 404 | chemin autre que `/api/frames` | — (erreur de développement) |
| 405 | méthode autre que POST | — (erreur de développement) |
| 5xx, pas de réponse | incident serveur ou réseau | renvoyer **la même** trame plus tard |

- Toute réponse autre que 204 porte `Connection: close` : le boîtier ou la mère doit rouvrir une connexion avant la trame suivante. Ainsi les réponses de rejet sont strictement identiques, quelle que soit la cause.
- La cause d'un rejet n'est pas révélée à l'émetteur, pour ne pas renseigner un attaquant. Elle est consignée côté serveur.
- Renvoyer une trame déjà acceptée (réponse perdue) donne 400 (rejeu). Le scan a bien été enregistré une fois, et le boîtier passe à la suite.
- L'heure du scan est **l'heure de réception par le serveur**. La trame ne contient pas d'horodatage, car le boîtier fille n'a pas d'horloge fiable. Le serveur doit avoir une horloge juste (NTP local).

⚠️ À VALIDER (Yanis) :
- **mise en mémoire des scans hors ligne** : le boîtier ou la mère gardent-ils des scans plusieurs minutes avant de les transmettre ? Si oui, il faut ajouter un champ « âge du scan » (2 octets, authentifié), sinon l'heure enregistrée sera fausse ;
- **retour à l'utilisateur** : le bip ou la LED du boîtier est-il purement local (lecture NFC réussie), ou faut-il une confirmation du serveur (par exemple « puce inconnue ») ? Une confirmation par LoRa demande une voie descendante, coûteuse.

Limite connue (v0) : une trame retardée puis dépassée par une trame plus récente du même lecteur est rejetée comme rejeu, et ce scan est perdu. C'est rare pour un boîtier qui émet séquentiellement. Une fenêtre anti-rejeu glissante corrigerait cela, mais ajoute de la complexité : elle n'est pas prévue.

---

## 6. Gestion des clés et des identifiants

- **Création d'un lecteur** (dans l'interface, étape 6 du plan) : le serveur génère `reader_id` et une clé AES-256 aléatoire. La clé est affichée **une seule fois** (hexadécimal) pour être injectée dans le boîtier.
- **Stockage serveur** : dans la base SQLite, protégée par les droits du fichier. À présenter à la SSI.
- **Stockage boîtier** : NVS. Le chiffrement de la flash et le secure boot de l'ESP32 sont recommandés contre l'extraction physique.
- La clé ne circule **jamais** ensuite : ni sur la radio, ni sur le réseau, ni dans un journal.
- **Révocation** : désactiver le lecteur. Ses trames sont alors rejetées.
- **Remplacement de clé** (reflash, suspicion de compromission) : création d'un **nouveau lecteur** (nouvel identifiant et nouvelle clé), l'ancien est désactivé. Ainsi un même `reader_id` ne voit jamais son compteur repartir à zéro.

⚠️ À VALIDER (Yanis) :
- identifiant attribué par le serveur (proposé), ou identifiant matériel propre au boîtier ?
- procédure d'injection de l'identifiant et de la clé dans le boîtier (liaison série USB au provisionnement ?).

---

## 7. Menaces et parades (résumé)

| Menace | Parade v0 |
|---|---|
| Écoute radio ou réseau | UID chiffré. `reader_id` et compteur restent visibles (nécessaires) : ils révèlent seulement qu'un poste est actif. |
| Fabrication d'un faux scan | Tag GCM de 128 bits, clé propre à chaque lecteur. |
| Rejeu d'une trame | Compteur strictement croissant par lecteur, vérifié de façon atomique. |
| Vol ou compromission d'un boîtier fille | Seul ce boîtier est touché : on le désactive. Chiffrement de la flash recommandé. |
| Compromission du boîtier mère | Aucune clé de boîtier fille : il peut bloquer ou retarder, pas lire ni fabriquer. |
| Réutilisation de nonce (bug firmware) | Compteur persistant ; nouvelle clé à chaque reprovisionnement. Le serveur rejette tout compteur non croissant (le symptôme est visible) mais ne peut pas annuler l'émission. |
| Clonage de l'UID d'une puce NFC | **Limite intrinsèque** : l'UID n'est pas un secret, et une puce « magique » peut usurper un UID, d'où une fausse localisation. Accepté pour un inventaire (ce n'est pas du contrôle d'accès). À signaler à la SSI. |
| Saturation (flot de trames) | Pas de limitation de débit en v0. Un rejet coûte peu : contrôle de taille, recherche du lecteur, AES. Au plus 256 connexions simultanées, délais courts (poignée de main TLS 5 s, en-têtes 5 s, requête 10 s), et une saturation des connexions n'arrête pas le serveur. |
| Observation du temps de réponse | Un rejet précoce (taille, lecteur inconnu) répond plus vite qu'un rejet sur tag invalide, ce qui révèle si un `reader_id` existe. Accepté : `reader_id` circule déjà en clair. |

---

## 8. Vecteurs de test (v0 provisoire)

Calculés avec `node:crypto` (OpenSSL) et vérifiés avec une seconde implémentation (WebCrypto). Ils seront repris tels quels dans les tests du serveur. Ils permettent à Yanis de vérifier son implémentation firmware octet pour octet.

Clé commune (32 octets) :
```
000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

**Vecteur 1** : `reader_id = 1`, `counter = 1`, UID de 7 octets `04A1B2C3D4E5F6`
```
nonce      000000010000000100000000
AAD        010000000100000001
clair      0704a1b2c3d4e5f6000000
chiffré    b5d9723ff84416793eb9ac
tag        384529e207c863cdd16605bc9059b104
trame (36) 010000000100000001b5d9723ff84416793eb9ac384529e207c863cdd16605bc9059b104
```

**Vecteur 2** : `reader_id = 1`, `counter = 2`, UID de 4 octets `DEADBEEF`
```
nonce      000000010000000200000000
AAD        010000000100000002
clair      04deadbeef000000000000
chiffré    8f22de611bf05f4cf9d25f
tag        36131eda9cf50410fc51251c7b300745
trame (36) 0100000001000000028f22de611bf05f4cf9d25f36131eda9cf50410fc51251c7b300745
```

---

## 9. Récapitulatif des points à valider avec Yanis

1. Format binaire fixe de 36 octets, big-endian.
2. AES-256-GCM, nonce = `reader_id ‖ counter ‖ 0⁴` (ou ChaCha20-Poly1305).
3. Chiffrement de bout en bout fille → serveur ; mère = relais sans clé.
4. Persistance du compteur en NVS ; nouvelle clé à chaque reflash.
5. Type de puces NFC et longueur d'UID ; UID fixe.
6. Client HTTPS sur le prototype Wi-Fi ; format actuellement envoyé.
7. LoRa point à point (pas LoRaWAN) ; bande, facteur d'étalement, rapport cyclique ; acquittements fille ↔ mère.
8. Mise en mémoire des scans hors ligne (sur le boîtier ou la mère) ?
9. Retour utilisateur local seulement, ou confirmation serveur ?
10. Identifiant de lecteur attribué par le serveur ; procédure d'injection de la clé.

## Historique

| Version | Date | Changement |
|---|---|---|
| v0 | 2026-11-15 | Première proposition (cadrage). |
| v0 | 2026-11-15 | Précisions issues de l'étape 1, sans changement du format : contrôles propres au transport HTTP, `Connection: close` sur tout rejet, réponse 404, compteur 0 rejeté. |
