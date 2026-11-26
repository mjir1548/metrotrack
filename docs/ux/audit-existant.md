# Audit UX de l'interface actuelle

Date : 2026-11-25. Audit en lecture seule de `server/views.js`, `web.js`, `aide.js`, `dates.js` et `web/static/style.css`.

Gravité perçue par un client non informaticien :
- **G1** : bloque ou induit en erreur ;
- **G2** : gêne réelle ;
- **G3** : mineur.

## 1. Les écrans actuels et leurs problèmes principaux

| Écran | Problèmes principaux | G |
|---|---|---|
| **Connexion** | Une page de connexion laissée ouverte plus de 10 min mène à « Requête refusée » après la saisie du mot de passe. Aucun message « vous avez été déconnecté », et on revient toujours sur l'inventaire au lieu de la page demandée. | G1 |
| **« Requête refusée »** (403) | Titre technique, saisie perdue, et propose de se reconnecter même à un utilisateur connecté. | G1 |
| **Erreurs sans contenu** (404, 400, 413, 500, session expirée pendant un formulaire) | Page blanche ou page d'erreur du navigateur, sans lien de retour ; la saisie est perdue sans explication. | G1 |
| **Inventaire** | La recherche ne trouve que des morceaux contigus du nom : « fluke 7 » ne trouve pas « Multimètre Fluke 87V n° 7 », et les propriétés (n° de série) ne sont pas cherchées. Il faut valider avec Entrée. **« Depuis » affiche l'heure du dernier scan, pas l'arrivée au poste** : un objet présent depuis 3 jours et rescanné il y a 20 min affiche « depuis 20 min ». Le code de puce en hexadécimal apparaît sous chaque nom. | G1 |
| **Fiche objet** | Impossible de donner ou retirer une puce depuis la fiche (parcours en 6 étapes via « Puces inconnues »). Vocabulaire technique (« lecteur n° 5 », « Puce NFC 0A0B0C0D », « ligne de commande »). Une liste de scans répétés au lieu d'une histoire « déplacé de A vers B ». | G1 |
| **Nouvelle fiche / Modifier** | « Ajouter des lignes » recharge toute la page ; aides saturées de limites (« 200 caractères au plus ») ; « Corrigez les champs signalés en rouge » renvoie à la couleur. | G2 |
| **Supprimer la fiche** | Code hexadécimal, « journal des scans » ; le message de retour ne nomme pas la fiche ; pas d'annulation. | G2 |
| **Corriger la localisation** | Liste déroulante sans recherche ; « localisation » au lieu d'« emplacement ». | G3 |
| **Postes** | L'usage quotidien (ce qu'il y a à un poste) est mélangé à l'installation (lecteurs, clés). | G2 |
| **Fiche poste** | « Objets présents », l'information utile, est la dernière carte ; code hexadécimal sous chaque objet. | G2 |
| **Supprimer un poste** | Un poste qui a servi ne peut ni être retiré ni masqué : les postes obsolètes s'accumulent dans les listes. | G2 |
| **Lecteurs** | Colonnes « Dernier compteur », « Lecteur n° » ; « injecter » ; les lecteurs désactivés restent listés à vie ; aucun nom pour savoir quel boîtier physique est le n° 7. | G1 |
| **Fiche lecteur** | « Ses trames sont acceptées », « compteur » ; aucun moyen de voir qu'un boîtier fonctionne sans recharger. | G2 |
| **Page de clé du lecteur** | « Clé AES-256 (64 caractères hexadécimaux) » à recopier à la main, sans bouton Copier ; recharger la page crée un second lecteur. | G1 |
| **Désactiver / Remplacer la clé** | « trames » ; « remplacer la clé = nouveau lecteur » est déroutant. | G2 |
| **Puces inconnues** | Le code hexadécimal est le seul repère ; pas de direct (il faut recharger après le scan) ; aucun compteur dans la navigation. | G1 |
| **Associer une puce** (recherche, confirmation) | Même recherche limitée ; jusqu'à 4 codes hexadécimaux dans une phrase. | G2 |

## 2. Problèmes transversaux
- **Navigation** :
  - organisée par modèle de données (Inventaire, Postes et lecteurs, Puces inconnues), pas par besoin ;
  - pas de mise en route guidée ;
  - pas de gestion des comptes (ligne de commande) ;
  - la rubrique active n'est signalée que par la couleur.
- **Vocabulaire technique visible** : « lecteur n° » (environ 20 endroits), codes hexadécimaux (15), « compteur », « trames », « AES-256 », « injecter », « serveur », « journal », « cette adresse ». S'y ajoutent des incohérences « fiche » / « objet » et « localisation » / « emplacement » ; « déplacé » n'apparaît jamais.
- **Dates** :
  - c'est le point le plus avancé : relatives, avec la date exacte au survol ;
  - mais figées jusqu'au rechargement (« à l'instant » reste affiché) ;
  - la date exacte n'est accessible ni au clavier ni au tactile ;
  - « Créée » et « Modifiée » restent en date brute.
- **Pas de direct** : aucun écran ne se met à jour seul.
- **Retours d'action** : bons bandeaux de succès, mais figés (sans nom ni annulation) ; ils réapparaissent à chaque rechargement ; les erreurs graves sont muettes.
- **Accessibilité** :
  - textes bien contrastés (5,15:1 au minimum) et focus visible ;
  - bordures des champs à 2,47:1 (3:1 requis) ;
  - liens sans soulignement dans les phrases (1,92:1 par rapport au texte voisin).

## 3. À garder absolument
- Une fiche se crée avec le seul nom.
- Formulaires accessibles qui conservent la saisie en cas d'erreur.
- Confirmations claires des actions irréversibles.
- Bandeaux de succès.
- Dates relatives avec la date exacte.
- États vides qui indiquent l'action suivante.
- Recherche insensible aux accents.
- Aide intégrée.
- Pastille « lecteur non affecté » cliquable.
- Toute la sécurité, invisible pour l'utilisateur.

## 4. Contraintes qui pèsent sur la refonte
1. **Aucun JavaScript client**, par règle du projet (testée). La CSP actuelle autoriserait pourtant un fichier JS local. Sans lui, pas de direct, ni de `Ctrl K`, ni de bouton Copier, ni de recherche pendant la frappe. **Décision à prendre.**
2. Pas d'attribut `style` ni d'image `data:` (CSP) : un SVG intégré au HTML reste possible.
3. Le direct demande un point d'accès SSE. Le plafond de 256 connexions est partagé avec les boîtiers.
4. Les messages de succès sont des codes figés : afficher le nom d'une fiche ou une annulation demande de changer ce mécanisme.
5. Les tests vérifient les libellés exacts : changer le vocabulaire impose de les mettre à jour. C'est prévu, pas un frein.
6. **Simplifier l'appairage d'un lecteur** (au-delà du bouton Copier) touche le contrat boîtier ↔ serveur : à voir **avec Yanis**, pas un sujet d'interface seule.
7. L'erreur « Depuis = dernier scan » demande une petite requête : l'heure d'arrivée est le premier scan de la série au même poste. Ce n'est pas un changement de modèle, la donnée existe déjà.
