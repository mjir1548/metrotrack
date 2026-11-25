// Aide intégrée : un encadré repliable « Comment ça marche ? » sous le titre des pages.
//
// Tout le texte d'aide est ici, pour être relu et corrigé au même endroit. Il est CONSTANT :
// aucune donnée de la base ni de la requête n'y entre, seulement des limites fixées par le code
// (MAX_..., importées pour que le texte reste juste si elles changent).
// Forme : <details> fermé par défaut, sans JavaScript ni style en ligne (la CSP est inchangée) ;
// la mise en forme est dans web/static/style.css (details.aide-page).
// Pages sans aide : connexion, pages d'erreur ou d'information (introuvable, action
// impossible), et la page de la clé d'un lecteur, dont l'avertissement ne doit pas être dilué.

import { html } from './html.js';
import { RECENT_SCANS } from './inventory.js';
import { MAX_UNKNOWN_CHIPS, MAX_ASSOCIATE_RESULTS } from './chips.js';

export const AIDE_SUMMARY = 'Comment ça marche ?';

/** Encadré repliable, fermé par défaut (pas d'attribut open). */
function encadre(contenu) {
  return html`<details class="aide-page">
<summary>${AIDE_SUMMARY}</summary>
<div class="aide-contenu">
${contenu}
</div>
</details>
`;
}

// ---------------------------------------------------------------- inventaire et fiches

const inventaire = encadre(html`<p>La liste montre tous les objets suivis, par ordre alphabétique : leur nom (un clic ouvre la fiche), le numéro de leur puce, leur localisation et depuis quand ils y sont.</p>
<p>La localisation n'est jamais saisie : elle vient du dernier événement connu.</p>
<ul>
<li>Un scan : l'objet est passé devant le lecteur d'un poste.</li>
<li>Une correction à la main, depuis la fiche de l'objet.</li>
<li>Le plus récent des deux l'emporte. Après une correction, le scan suivant reprend la main.</li>
</ul>
<p>Les pastilles de localisation :</p>
<ul>
<li><span class="etat etat-poste">Atelier</span> : le nom d'un poste, l'objet y est localisé.</li>
<li><span class="etat etat-inconnue">inconnue (lecteur n° … non affecté)</span> : l'objet a été scanné par un lecteur rattaché à aucun poste. Rattachez ce lecteur à un poste dans «&nbsp;Postes et lecteurs&nbsp;» (un clic sur la pastille ouvre le lecteur).</li>
<li><span class="etat etat-jamais">jamais localisé</span> : l'objet n'a jamais été scanné ni corrigé.</li>
</ul>
<p>Pour rechercher :</p>
<ul>
<li>tapez un bout du nom, sans vous soucier des accents ni des majuscules ;</li>
<li>ou au moins 4 caractères du numéro de puce, dont un chiffre (ou le numéro complet), avec ou sans séparateurs («&nbsp;04:A1&nbsp;» comme «&nbsp;04a1&nbsp;») ;</li>
<li>«&nbsp;Effacer&nbsp;» revient à la liste complète.</li>
</ul>
<p>Le bouton «&nbsp;Nouvelle fiche&nbsp;» ajoute un objet à l'inventaire.</p>`);

// Champs du formulaire de fiche, communs à la création et à la modification : leur sens, pas
// leurs limites (déjà écrites sous chaque champ).
// « trois lignes » : BLANK_ROWS de server/web.js (non importé : web.js importe ce module).
const CHAMPS_FICHE = html`<ul>
<li>Nom : ce qui permet de reconnaître l'objet dans la liste, par exemple sa marque et son modèle.</li>
<li>Notes : tout ce qu'il est utile de savoir sur l'objet, en texte libre. Facultatif.</li>
<li>Propriétés : les informations à retrouver d'un coup d'œil, sous la forme nom → valeur. Par exemple Marque → Fluke, N° de série → 4410278, Service → Électronique. Une propriété ne peut pas figurer deux fois («&nbsp;Marque&nbsp;» et «&nbsp;MARQUE&nbsp;» sont la même).</li>
<li>«&nbsp;Ajouter des lignes&nbsp;» : trois lignes de propriétés de plus, sans rien enregistrer et sans perdre votre saisie.</li>
<li>«&nbsp;Annuler&nbsp;» : revient en arrière sans rien enregistrer.</li>
<li>En cas d'erreur, le champ concerné passe en rouge avec une explication, et votre saisie est conservée.</li>
</ul>`;

const nouvelleFiche = encadre(html`<p>Remplissez la fiche, puis cliquez sur «&nbsp;Créer la fiche&nbsp;». Seul le nom est obligatoire.</p>
${CHAMPS_FICHE}
<p>La puce :</p>
<ul>
<li>Une nouvelle fiche n'a pas de puce : l'objet reste «&nbsp;jamais localisé&nbsp;» tant qu'il n'est ni scanné ni corrigé à la main.</li>
<li>Pour lui en donner une : scannez sa puce sur un poste, puis, dans «&nbsp;Puces inconnues&nbsp;», choisissez «&nbsp;Associer à une fiche existante&nbsp;».</li>
<li>Autre possibilité : partir de «&nbsp;Puces inconnues&nbsp;» avec «&nbsp;Créer une fiche&nbsp;». Le numéro de la puce est alors déjà rempli.</li>
</ul>
<p>La création est notée dans l'historique de la fiche.</p>`);

const ficheDepuisPuce = encadre(html`<p>Cette fiche est créée pour la puce scannée affichée en haut du formulaire. Remplissez-la, puis cliquez sur «&nbsp;Créer la fiche&nbsp;». Seul le nom est obligatoire.</p>
${CHAMPS_FICHE}
<p>La puce :</p>
<ul>
<li>Son numéro est déjà rempli et ne se modifie pas.</li>
<li>Dès la création, l'objet est localisé au poste de son dernier scan (ou «&nbsp;lecteur non affecté&nbsp;» si ce lecteur n'est rattaché à aucun poste).</li>
<li>Si un avertissement orange s'affiche, cette puce a déjà appartenu à une autre fiche : ses anciens scans seront rattachés à la nouvelle. Si possible, préférez une puce neuve.</li>
</ul>
<p>La création est notée dans l'historique de la fiche.</p>`);

const modifierFiche = encadre(html`<p>Modifiez les champs, puis cliquez sur «&nbsp;Enregistrer&nbsp;». Seul le nom est obligatoire.</p>
${CHAMPS_FICHE}
<p>Ce qui est noté :</p>
<ul>
<li>Chaque changement est noté dans l'historique de la fiche, avec l'avant et l'après.</li>
<li>Si rien n'a changé, l'historique ne reçoit aucune ligne.</li>
<li>La puce et la localisation ne se changent pas ici : utilisez «&nbsp;Corriger la localisation&nbsp;» sur la fiche, ou «&nbsp;Puces inconnues&nbsp;» pour donner une autre puce à l'objet.</li>
</ul>`);

const fiche = encadre(html`<p>La fiche rassemble tout ce que l'on sait de l'objet.</p>
<ul>
<li>Localisation actuelle : le poste où se trouve l'objet, et d'où vient l'information. Soit un scan (avec le numéro du lecteur), soit une correction à la main (avec son auteur). Le plus récent l'emporte.</li>
<li>Identification : la puce de l'objet, et les dates de création et de dernière modification de la fiche.</li>
<li>Propriétés et notes : ce qui a été saisi dans la fiche.</li>
<li>Derniers scans : les ${RECENT_SCANS} derniers passages de la puce devant un lecteur, le plus récent en premier.</li>
<li>Historique des modifications : qui a changé quoi, et quand.</li>
</ul>
<p>Les boutons :</p>
<ul>
<li>«&nbsp;Modifier&nbsp;» : changer le nom, les notes ou les propriétés.</li>
<li>«&nbsp;Corriger la localisation&nbsp;» : indiquer à la main où se trouve l'objet, s'il a bougé sans être scanné.</li>
<li>«&nbsp;Supprimer&nbsp;» : retirer la fiche de l'inventaire, après confirmation.</li>
</ul>`);

const localisation = encadre(html`<p>Indiquez à la main le poste où se trouve l'objet, par exemple s'il a été déplacé sans être scanné.</p>
<ul>
<li>La correction s'applique tout de suite, à l'heure actuelle.</li>
<li>Elle vaut jusqu'au prochain scan de l'objet, qui reprend la main.</li>
<li>Elle est notée dans l'historique de la fiche, avec votre nom.</li>
<li>Seuls les postes existants sont proposés. Pour en ajouter un : «&nbsp;Postes et lecteurs&nbsp;».</li>
</ul>`);

const supprimerFiche = encadre(html`<p>La suppression est définitive.</p>
<ul>
<li>Ce qui part : la fiche, ses propriétés, ses notes et ses corrections de localisation.</li>
<li>Ce qui reste : les scans de sa puce et l'historique des modifications, qui garde la trace de la suppression.</li>
<li>Sa puce redevient inconnue : si elle a déjà été scannée, elle réapparaît dans «&nbsp;Puces inconnues&nbsp;», où l'on peut l'associer à une autre fiche.</li>
</ul>`);

// ---------------------------------------------------------------- postes

const postes = encadre(html`<p>Un poste est un lieu de travail où l'on scanne les objets en arrivant. Un lecteur y est rattaché.</p>
<ul>
<li>La liste montre chaque poste, le nombre de lecteurs actifs qui lui sont rattachés et le nombre d'objets qui s'y trouvent.</li>
<li>«&nbsp;Nouveau poste&nbsp;» : créer un poste, puis lui rattacher un lecteur depuis l'onglet «&nbsp;Lecteurs&nbsp;».</li>
<li>Un clic sur un poste ouvre sa fiche : ses lecteurs et les objets présents.</li>
</ul>`);

const poste = encadre(html`<p>La fiche du poste montre sa description, ses lecteurs et les objets qui s'y trouvent en ce moment.</p>
<ul>
<li>Objets présents : localisés ici par leur dernier scan, ou par une correction à la main (mention «&nbsp;correction&nbsp;»).</li>
<li>Lecteurs : ceux rattachés à ce poste. Pour en rattacher un, ouvrez sa fiche dans l'onglet «&nbsp;Lecteurs&nbsp;», puis «&nbsp;Changer de poste&nbsp;».</li>
<li>«&nbsp;Modifier&nbsp;» : changer le nom ou la description.</li>
<li>«&nbsp;Supprimer&nbsp;» n'apparaît que si le poste n'a aucun historique : ni scan, ni correction, ni lecteur. Sinon, renommez-le.</li>
</ul>`);

const nouveauPoste = encadre(html`<p>Donnez un nom au poste, puis cliquez sur «&nbsp;Créer le poste&nbsp;».</p>
<ul>
<li>Nom : obligatoire. Deux postes ne peuvent pas porter le même nom (majuscules et minuscules confondues).</li>
<li>Description : facultative (emplacement, usage…).</li>
<li>Ensuite, rattachez-lui un lecteur : onglet «&nbsp;Lecteurs&nbsp;», puis «&nbsp;Nouveau lecteur&nbsp;», ou «&nbsp;Changer de poste&nbsp;» sur un lecteur existant.</li>
</ul>`);

const modifierPoste = encadre(html`<p>Modifiez le nom ou la description, puis cliquez sur «&nbsp;Enregistrer&nbsp;».</p>
<ul>
<li>Deux postes ne peuvent pas porter le même nom (majuscules et minuscules confondues).</li>
<li>Renommer un poste ne change pas son passé : ses scans et ses corrections restent rattachés à lui.</li>
<li>Le changement est noté dans le journal des modifications.</li>
</ul>`);

const supprimerPoste = encadre(html`<p>Seul un poste sans historique peut être supprimé : aucun scan, aucune correction de localisation, aucun lecteur.</p>
<ul>
<li>La suppression est définitive. Le journal des modifications en garde la trace.</li>
<li>Un poste qui a servi ne peut pas être supprimé : renommez-le plutôt.</li>
</ul>`);

// ---------------------------------------------------------------- lecteurs

const lecteurs = encadre(html`<p>Un lecteur est le boîtier posé sur un poste : il lit la puce des objets et envoie chaque scan à l'application.</p>
<ul>
<li>La liste montre chaque lecteur avec son poste, son état et son dernier scan. La colonne «&nbsp;Dernier compteur&nbsp;» donne le numéro du dernier message reçu du boîtier : il augmente à chaque scan.</li>
<li>«&nbsp;Nouveau lecteur&nbsp;» : l'application crée le numéro du lecteur et sa clé secrète. La clé n'est affichée qu'une seule fois : la personne qui prépare le boîtier doit l'y installer aussitôt.</li>
<li>Un lecteur «&nbsp;non affecté&nbsp;» n'est rattaché à aucun poste : les objets qu'il scanne sont en localisation «&nbsp;inconnue&nbsp;». Rattachez-le à un poste depuis sa fiche.</li>
</ul>`);

const nouveauLecteur = encadre(html`<p>Choisissez le poste du lecteur si vous le connaissez, puis cliquez sur «&nbsp;Créer le lecteur&nbsp;».</p>
<ul>
<li>Le poste est facultatif : vous pourrez le rattacher plus tard.</li>
<li>L'application crée le numéro du lecteur et sa clé secrète.</li>
<li>La page suivante affiche la clé une seule fois. La personne qui prépare le boîtier doit l'y installer tout de suite, avec le numéro du lecteur.</li>
<li>Si la clé est perdue, remplacez-la depuis la fiche du lecteur.</li>
</ul>`);

const lecteur = encadre(html`<p>La fiche du lecteur montre son poste, son état et les derniers scans qu'il a envoyés.</p>
<ul>
<li>«&nbsp;Changer de poste&nbsp;» : rattacher le lecteur à un autre poste, par exemple quand le boîtier est déplacé. Les scans déjà enregistrés gardent leur poste : l'historique n'est pas réécrit.</li>
<li>«&nbsp;Remplacer la clé&nbsp;» : si la clé est perdue ou a pu être vue. Un nouveau lecteur est créé, avec un nouveau numéro et une nouvelle clé, et celui-ci est désactivé.</li>
<li>«&nbsp;Désactiver&nbsp;» : les scans de ce lecteur sont refusés. C'est définitif ; ses scans passés sont conservés.</li>
<li>La clé n'est jamais réaffichée.</li>
</ul>`);

const changerPoste = encadre(html`<p>Choisissez le poste où se trouve désormais le boîtier, puis cliquez sur «&nbsp;Enregistrer&nbsp;».</p>
<ul>
<li>Seuls les prochains scans seront rattachés au poste choisi.</li>
<li>Les scans déjà enregistrés gardent leur poste : l'historique n'est pas réécrit.</li>
<li>«&nbsp;Non affecté&nbsp;» détache le lecteur de tout poste : les objets qu'il scanne seront en localisation «&nbsp;inconnue&nbsp;».</li>
</ul>`);

const desactiverLecteur = encadre(html`<p>Désactivez un lecteur hors service, perdu ou retiré.</p>
<ul>
<li>Ses scans sont refusés dès la confirmation.</li>
<li>C'est définitif : pour remettre le boîtier en service, il faudra créer un nouveau lecteur.</li>
<li>Ses scans passés et les localisations qui en découlent sont conservés.</li>
<li>Si seule la clé pose problème, préférez «&nbsp;Remplacer la clé&nbsp;».</li>
</ul>`);

const remplacerCle = encadre(html`<p>Remplacez la clé si elle a été perdue ou a pu être vue.</p>
<ul>
<li>Un nouveau lecteur est créé au même poste, avec un nouveau numéro et une nouvelle clé.</li>
<li>L'ancien lecteur est désactivé définitivement : le boîtier ne fonctionne plus tant que la personne qui le prépare n'y a pas installé le nouveau numéro et la nouvelle clé.</li>
<li>La nouvelle clé n'est affichée qu'une fois, sur la page suivante.</li>
<li>Les scans passés sont conservés.</li>
</ul>`);

// ---------------------------------------------------------------- puces inconnues

// L'introduction de la page dit déjà ce qu'est une puce inconnue : pas de redite ici.
const puces = encadre(html`<p>Pour chaque puce, deux possibilités :</p>
<ul>
<li>«&nbsp;Créer une fiche&nbsp;» : l'objet n'a pas encore de fiche. Le numéro de la puce est déjà rempli, et l'objet est localisé au poste de son dernier scan (ou «&nbsp;lecteur non affecté&nbsp;» si ce lecteur n'est rattaché à aucun poste).</li>
<li>«&nbsp;Associer à une fiche existante&nbsp;» : la fiche existe déjà. Cherchez-la, puis confirmez. Si elle portait déjà une puce, l'ancienne est détachée.</li>
</ul>
<p>À savoir :</p>
<ul>
<li>Les scans d'une puce inconnue sont gardés : ils comptent dès que la puce reçoit une fiche.</li>
<li>Si la puce a déjà appartenu à une fiche (supprimée, ou qui a changé de puce), un avertissement s'affiche : ses anciens scans seront rattachés au nouvel objet. Si possible, préférez une puce neuve.</li>
<li>Seules les ${MAX_UNKNOWN_CHIPS} puces scannées le plus récemment sont affichées. Une fois celles-ci traitées, les suivantes apparaissent.</li>
</ul>`);

const associerRecherche = encadre(html`<p>Cherchez la fiche de l'objet qui porte cette puce, puis cliquez sur «&nbsp;Associer&nbsp;».</p>
<ul>
<li>Recherchez par un bout du nom, ou par au moins 4 caractères du numéro de la puce actuelle de la fiche, dont un chiffre (ou le numéro complet).</li>
<li>${MAX_ASSOCIATE_RESULTS} fiches au plus sont affichées : précisez la recherche si besoin.</li>
<li>Rien n'est modifié avant la page de confirmation.</li>
<li>L'objet n'a pas encore de fiche ? Créez-la plutôt pour cette puce, avec le lien en bas de page.</li>
</ul>`);

const associerConfirmation = encadre(html`<p>Vérifiez ce qui va changer, puis confirmez.</p>
<ul>
<li>La fiche sera localisée au dernier scan de la puce, sauf si une correction à la main est plus récente.</li>
<li>Si la fiche porte déjà une puce, l'ancienne est détachée : ses scans sont conservés, et elle redevient une puce inconnue.</li>
<li>Le changement est noté dans l'historique de la fiche.</li>
</ul>`);

/** Encadrés d'aide, un par page. Fragments constants, produits une fois au chargement. */
export const AIDE = Object.freeze({
  inventaire,
  nouvelleFiche,
  ficheDepuisPuce,
  modifierFiche,
  fiche,
  localisation,
  supprimerFiche,
  postes,
  poste,
  nouveauPoste,
  modifierPoste,
  supprimerPoste,
  lecteurs,
  nouveauLecteur,
  lecteur,
  changerPoste,
  desactiverLecteur,
  remplacerCle,
  puces,
  associerRecherche,
  associerConfirmation,
});
