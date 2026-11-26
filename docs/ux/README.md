# Phase « logiciel de bureau, priorité à l'UX » — Phase 0

Statut : **livrée, en attente de tes choix**. Aucun écran du produit n'a été modifié.
Date : 2026-11-25.

## Les livrables

| # | Livrable | Fichier |
|---|---|---|
| 1 | Audit de l'existant : chaque écran et ses problèmes principaux | [audit-existant.md](audit-existant.md) |
| 2 | Carte du logiciel, navigation et les 6 parcours pas à pas, plus l'écran d'accueil proposé | [carte-et-parcours.md](carte-et-parcours.md) |
| 3 | 3 directions visuelles : maquettes HTML de l'accueil, de la recherche et de la fiche objet | [../maquettes/index.html](../maquettes/index.html). Pour les voir avec les polices : `node docs/maquettes/apercu.mjs`, puis ouvrir http://127.0.0.1:8790/ dans le navigateur. |
| 4 | Le passage au `.exe` : options, poids, dépendances, sécurité, signature, et recommandation | [exe.md](exe.md) |
| 5 | Plan par étapes U1 à U9 | [plan.md](plan.md) |
| 6 | Définition proposée de l'agent `revue-ux` | [revue-ux.proposition.md](revue-ux.proposition.md) |

Les maquettes utilisent les vraies polices (Space Grotesk, Inter, JetBrains Mono, licence libre OFL), téléchargées une fois depuis le dépôt officiel Google Fonts et rangées dans `docs/maquettes/assets/fonts/`. Elles n'appellent rien sur Internet. Le jeu d'icônes est dessiné pour le projet (`docs/maquettes/assets/icones.svg`).

## Les trois directions en bref

| | A · Atelier chaleureux | B · Clair et aéré | C · Plan des postes |
|---|---|---|---|
| Structure | Barre latérale bleu nuit à gauche | Barre supérieure claire et fine | Bandeau bleu nuit pleine largeur, avec onglets |
| Accueil | Recherche au centre, mouvements et lecteurs à gauche, puces à droite | Recherche en grande pilule, avec les recherches récentes ; tout sur une colonne aérée | Postes en tuiles (nombre d'objets, état du lecteur), plus la colonne « En direct » |
| Fiche | Emplacement en grand dans un bandeau vert pâle | Emplacement géant (56 px) sur toute la largeur, sans cadre | Grand bloc sombre « Emplacement actuel », avec un mini-plan des postes |
| Point fort | Rassurant, classique, fidèle au brief | Le plus calme et lisible ; **mode sombre déjà fait** | Le plus parlant : un problème (poste silencieux) saute aux yeux |
| Point faible | Le plus « déjà vu » | Moins de caractère, la navigation est plus discrète | Plus chargé ; la correction manuelle en orange peut faire croire à un problème |

Toutes respectent les contrastes AA (calculés, listés en tête de chaque `style.css`), le focus clavier, les dates avec la date exacte au survol, l'information jamais portée par la couleur seule, et « moins d'animations » si l'utilisateur le demande.

**Mon avis** : la **structure de A** (navigation toujours visible, rassurante pour un client lambda) avec **l'accueil en tuiles de C** et la **fiche de B**. Le mode sombre de B se reprend tel quel, plus tard.

## Ce que j'ai découvert en route (important)
1. **Windows bloque un `.exe` non signé.** Sur ce PC, l'exécutable d'essai a été bloqué net par une stratégie de contrôle d'application. Il faudra prévoir **la signature du logiciel** (environ 10 $/mois avec Microsoft Artifact Signing si l'entreprise y est éligible).
2. **L'inventaire affiche une ancienneté fausse** : « depuis » donne l'heure du dernier scan, pas l'heure d'arrivée au poste. Correction prévue à l'étape U2, sans changement de modèle.
3. **Une page de connexion ouverte plus de 10 minutes échoue**, avec un message technique. Correction prévue à l'étape U1.
4. **Simplifier l'appairage des lecteurs** au-delà d'un bouton « Copier » (par exemple appairer sans recopier de clé) toucherait le protocole des boîtiers. C'est à voir **avec Yanis**, je n'y touche pas.

## Tes décisions (questions)

### Bloquantes pour démarrer U1
1. **Direction visuelle** : A « Atelier chaleureux », B « Clair et aéré » ou C « Plan des postes », ou un mélange (par exemple la structure de A avec l'accueil en tuiles de C).
2. **JavaScript côté navigateur** : j'ajoute un seul petit fichier local, sans dépendance, déjà permis par la politique de sécurité actuelle, pour `Ctrl K`, la recherche pendant la frappe, le direct, les panneaux et le bouton Copier. Les pages continuent de marcher sans lui. C'est la fin de la règle « aucun JavaScript » : **d'accord ?**
3. **Agent `revue-ux`** : d'accord avec sa définition ? Je l'ajoute alors dans `.claude/agents/`.

### Avant les étapes concernées
4. **`.exe`** : option A (Node empaqueté + fenêtre Edge en mode application, zéro dépendance) ou autre ? Et la variante « dossier avec le `node.exe` officiel » si le mode exécutable unique, encore jeune, pose problème ? (U8)
5. **Un PC principal**, où le serveur tourne en permanence même fenêtre fermée, **et des PC de consultation** : d'accord ? (U8)
6. **Budget de signature** : Artifact Signing (~10 $/mois, si l'entreprise est éligible) ou certificat OV (~200–400 €/an) ? (U9)
7. **Écran d'accueil** proposé (recherche au centre, derniers mouvements en direct, puces à traiter, état des lecteurs avec seuil de 24 h) : d'accord ? (U4)
8. **Premier lancement** : créer le premier compte dans l'assistant (réservé au PC lui-même) et ajouter des collègues dans Réglages › Comptes. Fonctionnalité légère mais nouvelle : **d'accord ?** (U7)
9. **Nom du site** : une nouvelle donnée en base (une ligne de réglages). C'est un petit changement de modèle : **d'accord ?** (U7)
10. **Donner une puce depuis la fiche** (« scannez la puce maintenant ») et **retirer une puce** : c'est un nouveau parcours, qui remplace le détour actuel en 6 étapes. **D'accord ?** (U3)
11. **Masquer un poste qui ne sert plus** (au lieu de ne jamais pouvoir le retirer) : l'audit montre que les postes obsolètes encombrent les listes. **À ajouter, ou on garde ainsi ?**
12. **Mode sombre** : proposé pour plus tard, une fois le design system en place.

### Toujours en attente, d'avant cette phase
D-003 à D-009, D-011, D-013 et les limites acceptées des étapes 5 à 7 ; la règle « un scan par envoi » dans le protocole ; `~$*` dans `.gitignore` ; le sens de « informations » dans la fiche. Le détail est dans `SUIVI.md`.
