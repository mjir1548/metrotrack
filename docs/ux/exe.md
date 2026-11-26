# MetroTrack en logiciel de bureau (.exe) — options et recommandation

Statut : **proposition, à valider**. Rien n'est construit. Date : 2026-11-25.

## 1. Ce qu'on vérifie concrètement sur ce PC

| Constat | Conséquence |
|---|---|
| Node 26.13 sait fabriquer un exécutable unique (`node --build-sea`), y compris avec plusieurs fichiers en modules ESM (option `useVfs`, marquée « en début de développement »). Essai fait : un `.exe` de **100 Mo** est produit en quelques secondes. | Option A techniquement faisable, sans aucune dépendance. |
| **Windows a bloqué cet `.exe` au lancement** : « Une stratégie de contrôle d'application a bloqué ce fichier ». L'exécutable fabriqué n'est plus signé (l'injection casse la signature d'origine de `node.exe`). | Sur Windows 11, un `.exe` non signé peut être **bloqué net** (Smart App Control, politiques d'entreprise), pas seulement averti. **La signature devient quasi obligatoire**, quelle que soit l'option. |
| Microsoft Edge et le moteur WebView2 sont présents (livrés avec Windows 10 et 11). | On peut ouvrir une vraie fenêtre d'application sans embarquer de navigateur. |

## 2. Les options

| | **A. Node « exécutable unique » + fenêtre Edge en mode application** (recommandée) | **B. Electron** | **C. Tauri** |
|---|---|---|---|
| Principe | Le serveur actuel tel quel, empaqueté. Un lanceur démarre le serveur (s'il ne tourne pas déjà) puis ouvre `msedge --app=https://localhost:…` : une fenêtre sans barre d'adresse, avec sa propre icône dans la barre des tâches. | Chromium + Node embarqués ; fenêtre native. | Fenêtre native WebView2, cœur en Rust ; notre serveur Node tournerait à côté (« sidecar »). |
| Fenêtre | Fenêtre Edge « application » : propre, mais menus et titre à la manière d'Edge. | Totalement native, menus personnalisables. | Native et légère. |
| Poids | ~100 Mo (Node) — ou ~35 Mo zippé | ~150–250 Mo | ~10 Mo + Node à côté (~100 Mo) |
| Dépendances | **0** (Node + Edge fournis par Windows) | Electron + outils de construction : des centaines de paquets npm | Chaîne Rust + des centaines de crates, **et** Node quand même |
| Règle « zéro dépendance » (D-002) | Respectée | **Cassée** | **Cassée** (et deux langages) |
| Audit de sécurité | Inchangé : on audite notre code + Node + Edge (déjà présent et mis à jour par Windows) | Chromium embarqué à mettre à jour nous-mêmes à chaque faille ; surface énorme | Deux chaînes à auditer (Rust + Node) |
| Effort | Faible : un lanceur, un installateur | Moyen : réécrire le démarrage, l'IPC, les mises à jour | Élevé |

**Recommandation : A.** C'est la plus simple, elle garde zéro dépendance et toute la sécurité déjà construite. Ce qu'on perd : une fenêtre un peu moins « native » (titre et menu d'Edge). Si ce détail devient gênant plus tard, Tauri resterait possible sans rien jeter.

Variante encore plus simple de A, à envisager si le mode `useVfs` (encore jeune) pose problème : **installer le `node.exe` officiel (signé par la fondation OpenJS) et nos fichiers dans un dossier**, avec un raccourci « MetroTrack ». Pour l'utilisateur, c'est identique ; techniquement, c'est encore plus robuste, et le `node.exe` reste signé.

## 3. Un PC ou plusieurs ?

Proposition la plus simple :
- **Un PC « principal »** installe MetroTrack complet. Le serveur tourne en tâche de fond **en permanence** (au démarrage de Windows, même fenêtre fermée) : sinon, les scans des boîtiers arriveraient dans le vide.
- **Les autres PC** consultent l'inventaire en même temps, via un petit installateur « poste de consultation » : un raccourci qui ouvre la fenêtre MetroTrack vers le PC principal. Pas de base locale, pas de synchronisation.
- SQLite reste sur le PC principal (un seul écrivain, aucune complexité nouvelle).

## 4. Installation, données, sauvegarde, mise à jour

- **Installateur** : Inno Setup (outil gratuit, utilisé seulement pour construire, rien à l'exécution ; script lisible par un auditeur). L'alternative MSIX impose de toute façon la signature.
- **Données** : `C:\ProgramData\MetroTrack\` (base, certificats, journaux), séparées du programme. Une désinstallation ne supprime pas les données sans confirmation.
- **Démarrage automatique du serveur** : tâche planifiée Windows « au démarrage » (outil intégré, aucune dépendance). Un vrai service Windows demanderait un adaptateur supplémentaire : non proposé.
- **Sauvegarde** : copie automatique quotidienne de la base (`VACUUM INTO`, intégré à SQLite) dans `ProgramData\MetroTrack\sauvegardes\`, les 14 dernières gardées, plus un bouton « Sauvegarder maintenant » dans Réglages.
- **Mise à jour** : on lance le nouvel installateur par-dessus l'ancien. Les migrations de base existantes s'appliquent toutes seules. Pas de mise à jour automatique (cohérent avec « aucun appel à Internet »).

## 5. Signature du .exe

Sans signature : avertissement SmartScreen « Windows a protégé votre ordinateur », voire **blocage complet** (constaté sur ce PC). Options :

| Option | Coût indicatif | Remarques |
|---|---|---|
| Microsoft Artifact Signing (ex-Trusted Signing) | ~10 $/mois (offre de base) | Le moins cher. Réservé à des organisations vérifiées (entreprise avec historique). Pas de confiance SmartScreen immédiate : la réputation se construit avec le temps. |
| Certificat OV classique (autorité reconnue) | ~200–400 €/an | Clé obligatoirement sur un support matériel ou un service cloud depuis 2023. Réputation progressive. |
| Certificat EV | ~400 €/an et plus | Microsoft a supprimé en 2024 son avantage (confiance immédiate) : plus justifié. |
| Aucune signature | 0 € | Acceptable seulement pour des démos internes ; chez un client, l'informatique devra autoriser le fichier à la main (liste blanche). |

Recommandation : **Artifact Signing** si l'entreprise y est éligible, sinon un certificat OV. À budgéter avant toute livraison à un client.

## 6. Ce que ça change pour HTTPS et la sécurité déjà en place

- HTTPS **reste obligatoire** (CLAUDE.md §4), y compris pour la fenêtre locale.
- À l'installation, MetroTrack crée **sa propre autorité de certification**, limitée par contrainte de nom à ce PC (`localhost` + son nom réseau), comme `tools/devcert.sh` le fait déjà. Elle est ajoutée au magasin de certificats de l'utilisateur, pour que la fenêtre s'ouvre sans avertissement. Grâce à la contrainte de nom, même volée, elle ne peut pas servir à usurper un autre site.
- Les PC de consultation reçoivent cette même autorité via leur installateur. Si le client a déjà sa propre PKI, on peut l'utiliser à la place.
- Rien ne change pour les boîtiers : même point d'entrée `POST /api/frames`, même protocole (le contrat reste celui de `docs/protocole.md`, géré avec Yanis).
- Le pare-feu Windows doit autoriser le port d'écoute sur le réseau local : l'installateur crée la règle, limitée au réseau privé.
- Nouveau point sensible à traiter : **le premier compte** sera créé dans l'assistant de premier lancement (au lieu de la ligne de commande). Cette page ne doit être accessible **que depuis le PC lui-même** et seulement tant qu'aucun compte n'existe.

Sources consultées : [documentation Node.js — exécutables uniques](https://nodejs.org/api/single-executable-applications.md), [Microsoft — options de signature de code](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), [Microsoft — tarifs d'Artifact Signing](https://azure.microsoft.com/pricing/details/artifact-signing/).
