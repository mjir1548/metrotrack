# CLAUDE.md — MetroTrack

Ce fichier donne le contexte permanent du projet. Lis-le en entier avant toute action et respecte-le pour toute la durée du travail.

## 1. Le projet

MetroTrack est un logiciel d'inventaire de matériel basé sur des puces NFC et des lecteurs fixes. Cible : les entreprises dont le matériel circule entre des postes de travail.

**Principe directeur : friction minimale.** L'utilisation doit être un plaisir, pas une corvée. Chaque écran, chaque étape, chaque champ obligatoire doit justifier son existence.

**Objectif actuel** : un logiciel fonctionnel, visuellement soigné, qui respecte toutes les exigences techniques de ce fichier. La qualité visuelle de l'interface fait partie des critères de réussite de chaque étape qui la touche.

## 2. Périmètre du MVP (strict)

Dans le périmètre :
- Chaque objet porte une puce NFC (identifiée par son UID).
- Chaque poste a un boîtier lecteur. On scanne un objet en arrivant au poste, avant de s'en servir.
- L'application tient l'inventaire : une fiche par objet (nom, propriétés libres, notes, informations, **localisation actuelle déduite du dernier scan**).
- Les fiches sont modifiables à la main (y compris pour corriger une localisation).
- Gestion minimale des postes et des lecteurs (créer, nommer, associer un lecteur à un poste).
- Association d'une puce inconnue à une nouvelle fiche ou à une fiche existante.

**Hors périmètre, à ne PAS implémenter, même partiellement, même « pour plus tard » :**
- gestion d'étalonnage, échéances, alertes, notifications ;
- certificats ou rapports PDF ;
- tout ce qui découle de ces fonctionnalités.

Le projet s'est dispersé dans ces sujets par le passé. Si une demande ou une idée y touche, **arrête-toi et signale-le** au lieu de coder.

## 3. Architecture cible

```
[Boîtier fille ESP32 + NFC]  --radio (LoRa, à confirmer)-->  [Boîtier mère]  --Ethernet/TLS-->  [Serveur local]  <--HTTPS--  [Navigateurs]
       (un par poste)                                         (passerelle)                     (API + UI + BDD)
```

- Un prototype ESP32 existe et fonctionne aujourd'hui **en Wi-Fi**. Le serveur doit pouvoir le recevoir dès maintenant, puis accepter la chaîne LoRa → mère sans changer de logique métier.
- Le firmware n'est **pas** dans ton périmètre (il est géré par Yanis). Tu travailles sur le serveur, l'application, et la **spécification du contrat** boîtier ↔ serveur.
- La couche « transport » (Wi-Fi direct ou passerelle mère) doit être isolée de la couche métier : un scan arrive, il est vérifié, puis traité de la même façon quelle que soit son origine.

## 4. Contraintes de sécurité (non négociables)

Cible : des environnements très sécurisés. Aucun site pilote n'est au plan pour l'instant (l'ONERA est une piste pour plus tard, voir D-012). Ces contraintes restent toutes en vigueur : l'ensemble doit pouvoir être audité et validé par une équipe SSI.

- **Hébergement 100 % local, aucune dépendance à Internet à l'exécution** : pas de CDN, pas de polices ou scripts distants, pas de télémétrie, pas d'appel sortant. Tous les assets sont servis localement.
- **Échanges authentifiés et chiffrés** sur tous les liens :
  - navigateur ↔ serveur : HTTPS ;
  - boîtier mère ↔ serveur : TLS (mTLS envisageable, à discuter) ;
  - boîtier fille ↔ mère (radio) : TLS impossible vu la bande passante LoRa → chiffrement authentifié par message (AEAD : AES-GCM ou ChaCha20-Poly1305), clé par boîtier, compteur monotone anti-rejeu. **Proposition à valider, ne pas figer seul.**
- **Minimisation des données** : un message de scan ne contient que le strict nécessaire (ID lecteur, UID puce, compteur/horodatage, tag d'authentification). Aucune donnée de fiche ne transite par la radio.
- Authentification des utilisateurs de l'application (comptes locaux, mots de passe hachés avec un algorithme moderne type argon2id ou bcrypt).
- Journal des scans conservé (c'est la source de vérité de la localisation) et journal des modifications manuelles de fiches.
- Dépendances : le moins possible, maintenues, versions épinglées. Chaque dépendance ajoutée doit être justifiée en une ligne.
- Aucun secret dans le dépôt. Configuration via fichier local ou variables d'environnement, avec un fichier d'exemple versionné.

## 5. Principes de développement

1. **La version la plus simple d'abord.** Si une proposition ajoute de la complexité (nouveau service, file de messages, conteneurs multiples, framework lourd, abstraction anticipée), signale-le explicitement et propose d'abord l'alternative simple.
2. **Un seul déployable** de préférence : un serveur qui expose l'API, sert l'interface web et accède à la base. Base SQLite par défaut (un fichier, facile à sauvegarder et à auditer).
3. **La localisation n'est pas stockée en double** : elle est dérivée du dernier scan (ou de la dernière correction manuelle). Une vue ou une requête suffit.
4. **Pas de fonctionnalité spéculative.** Pas de code « au cas où ».
5. **Tests** sur la logique métier et sur la vérification des messages de scan (authentification, rejeu, message malformé).
6. **Code lisible par un auditeur** : structure claire, noms explicites, commentaires sur les choix de sécurité.
7. **Demande avant de décider** sur tout choix structurant : langage, framework, format de message, schéma crypto, modèle de données.

## 6. Modèle de données de départ (à affiner)

- `items` : objet inventorié (id, uid_nfc unique, nom, propriétés libres, notes, dates).
- `stations` : poste de travail (id, nom, description).
- `readers` : boîtier lecteur (id, identifiant matériel, poste associé, clé/identité, actif).
- `scans` : journal append-only (id, reader_id, uid_nfc, compteur, reçu_le, item_id résolu ou null).
- `users` : comptes de l'application.
- `audit_log` : modifications manuelles (qui, quoi, quand).

## 7. Répartition de l'équipe

- **Yanis** : fondateur, produit, matériel et firmware.
- **Développeur associé** (la personne avec qui tu travailles) : serveur, application, et interface boîtiers ↔ serveur en lien avec Yanis.

Tout changement du contrat boîtier ↔ serveur doit être documenté dans `docs/protocole.md` pour que Yanis puisse l'implémenter côté firmware.

## 8. Dépôt

Dépôt GitHub commun. Commits petits et explicites. Pas de push ni de merge sans demande explicite.

Structure suggérée (à adapter selon la stack choisie) :
```
/server      code du serveur (API, logique métier, accès BDD)
/web         interface utilisateur (si séparée du serveur)
/docs        protocole.md, securite.md, decisions.md (journal des décisions)
/tools       scripts utilitaires (ex. simulateur de boîtier pour tester sans matériel)
```

Toute décision structurante est consignée en quelques lignes dans `docs/decisions.md` (date, décision, alternatives écartées, raison).

## 9. Méthode de travail avec les sous-agents

Tu es l'**orchestrateur**. Tu planifies, tu délègues, tu vérifies et tu rends compte. Trois sous-agents sont définis dans `.claude/agents/` :

| Agent | Rôle | Modifie le code ? |
|---|---|---|
| `dev` | implémente une étape du plan | oui |
| `testeur` | prouve que l'étape fonctionne de bout en bout, cas limites inclus | tests uniquement |
| `revue-securite` | audit sécurité, simplicité, périmètre MVP | non (lecture seule) |

**Boucle pour chaque étape du plan :**
1. Tu découpes l'étape en une tâche claire et autonome, avec critères de réussite vérifiables.
2. `dev` implémente.
3. `testeur` vérifie. Si ❌ → renvoie à `dev` avec le rapport précis.
4. `revue-securite` relit. Si BLOQUANT → renvoie à `dev`, puis repasse par `testeur`.
5. Maximum **3 allers-retours** par étape. Au-delà, arrête-toi et explique-moi le blocage.
6. Quand tout est vert : résumé court (fait / comment vérifier / points à valider) et proposition de message de commit. **Tu attends mon accord avant de commiter**, puis tu passes à l'étape suivante.

**Règles d'orchestration :**
- Une étape = un incrément petit, testable et livrable. Pas d'étape « tout le backend ».
- Lance des agents en parallèle uniquement sur des tâches réellement indépendantes (fichiers différents). Ne lance jamais deux `dev` sur les mêmes fichiers.
- Donne à chaque agent tout le contexte utile dans sa tâche : il ne voit pas notre conversation.
- Ne crée pas d'autres agents sans me le proposer d'abord.
- Les choix structurants (stack, format de message, crypto, modèle de données) ne sont **jamais** tranchés par un sous-agent : ils remontent jusqu'à moi.
