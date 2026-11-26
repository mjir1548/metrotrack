# MetroTrack bureau — Plan par étapes (phase UX)

Statut : **proposition, à valider**. Date : 2026-11-25.

Pour chaque étape, la boucle est `dev` → `testeur` → `revue-ux` → `revue-securite`, au plus 3 allers-retours, puis l'accord avant le commit. La base technique (réception des scans, chiffrement, comptes, données) est **réutilisée** : on ne la réécrit pas.

Chaque étape doit être **utilisable et démontrable** à la fin.

| # | Étape | Contenu | Critères de réussite vérifiables |
|---|---|---|---|
| U1 | **Design system** | Variables CSS de la direction choisie (couleurs, typographie, espacements, rayons, ombres, animations) ; polices et icônes servies localement par le serveur ; composants de base (boutons, champs, cartes, badges, notification, encadré d'aide) ; gabarit commun (navigation) appliqué à toutes les pages existantes, **sans changer les parcours**. Pages d'erreur lisibles et habillées (404, 400, 413, 500, session expirée) à la place des pages blanches. La page de connexion ne doit plus expirer au bout de 10 min. Vocabulaire du client partout : plus de « lecteur n° », de code hexadécimal, de « trames » ni de « compteur » à l'écran. | Test automatique : aucune couleur codée en dur hors des variables ; aucune ressource externe ; contrastes AA des couples de couleurs vérifiés par test ; focus visible ; les 452 tests existants restent verts. |
| U2 | **« Où est cet objet ? »** | Recherche toujours visible, palette `Ctrl K` ; résultats pendant la frappe (nom, numéro, propriété) ; emplacement en grand et dates humaines avec date exacte au survol. **« Depuis » corrigé** : heure d'arrivée au poste, et non heure du dernier scan (défaut relevé par l'audit, sans changement de modèle). Premier fichier JavaScript local, sans dépendance, autorisé par la CSP existante ; la page marche aussi sans JS. | Réponse en moins de 100 ms pour 5 000 objets (test de charge) ; tout au clavier ; aucun terme technique visible ; fonctionne JS désactivé. |
| U3 | **Fiche objet** | En-tête « identité + emplacement » ; propriétés, notes ; **frise d'historique** (scans, corrections manuelles, création) ; corriger l'emplacement dans un panneau ; modifier sur place ; **« Donner une puce » depuis la fiche** (« scannez la puce au poste de votre choix », en direct) et « Retirer la puce ». | La correction apparaît aussitôt dans la frise, marquée « corrigé à la main » (icône et texte) ; création d'une fiche avec un nom seul ; Échap annule. |
| U4 | **Accueil et direct** | Accueil validé (recherche, derniers mouvements en direct par Server-Sent Events, « À traiter », état des lecteurs avec seuil de 24 h) ; notification d'un nouveau scan sur tous les écrans. | Un scan simulé apparaît en moins de 2 s sans recharger ; le lecteur silencieux est signalé par une icône et un texte ; états vides utiles. Le direct ne dégrade pas la réception des scans (test de charge). |
| U5 | **Puces inconnues** | Notification en direct ; création en un clic (puce rattachée, nom seul) ; association avec recherche d'objet ; avertissements sans jargon. | Puce scannée → fiche créée en au plus 3 actions ; avertissements de remplacement et de réutilisation compréhensibles (relus par `revue-ux`). |
| U6 | **Postes et lecteurs** | Postes en tuiles ; page d'un poste (objets présents, état du lecteur, mouvements) ; ajout, renommage, désactivation, remplacement de clé : chaque action expliquée en une phrase et confirmée ; carte de clé avec copie en un clic. | Chaque action sensible a sa phrase d'explication et sa confirmation ; la clé reste affichée une seule fois. |
| U7 | **Premier lancement** | Assistant en 5 pas (compte, site, postes, lecteurs, « c'est prêt » qui attend le premier scan). Création du premier compte réservée au PC local et tant qu'aucun compte n'existe ; Réglages › Comptes pour ajouter un collègue. **Nécessite tes validations** (nom du site en base, comptes dans l'interface). | Installation guidée de zéro jusqu'au premier objet localisé, sans ligne de commande ; la page du premier compte est refusée depuis une autre machine. |
| U8 | **Empaquetage bureau** | Option validée de `docs/ux/exe.md` : lanceur, fenêtre d'application, autorité de certification propre au PC, serveur au démarrage de Windows, données dans `ProgramData`, sauvegarde quotidienne, installateur, poste de consultation. | Installation sur un Windows vierge, puis lancement par le raccourci ; un scan est reçu fenêtre fermée ; la sauvegarde est créée ; la désinstallation garde les données. |
| U9 | **Signature et notice** | Signature du `.exe` (selon le budget validé) ; notice d'installation d'une page. | Lancement sans blocage Windows sur un PC avec Smart App Control. |

Ordre conseillé : **U1 → U2 → U3**, comme demandé, puis U4 à U9. U8 peut commencer en parallèle de U4–U6, car il touche d'autres fichiers.

## Ce que j'ai volontairement laissé de côté (version la plus simple d'abord)
- Mode sombre : il deviendra facile une fois les variables en place (U1). Proposé pour plus tard.
- Seuil de « lecteur silencieux » réglable : fixe (24 h) dans un premier temps.
- Mise à jour automatique : non, cohérent avec « aucun appel à Internet ».
- Vrai service Windows, WebSocket, synchronisation entre plusieurs bases : non.
