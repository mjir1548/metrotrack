// Aide intégrée : un encadré repliable « Comment ça marche ? » sous le titre des pages.
//
// Tout le texte d'aide est ici, pour être relu et corrigé au même endroit. Il est CONSTANT :
// aucune donnée de la base ni de la requête n'y entre, seulement des limites fixées par le code
// (MAX_..., importées pour que le texte reste juste si elles changent).
// Forme : <details> fermé par défaut, sans JavaScript ni style en ligne (la CSP est inchangée) ;
// la mise en forme est dans web/static/style.css (details.aide-page, icônes dessinées en CSS).
// Pages sans aide : connexion, pages d'erreur ou d'information (introuvable, action
// impossible), et la page de la clé d'un lecteur, dont l'avertissement ne doit pas être dilué.

import { html } from './html.js';
import { MAX_UNKNOWN_CHIPS, MAX_ASSOCIATE_RESULTS, MAX_OFFERED_CHIPS } from './chips.js';
import { TIMELINE_PAGE_ENTRIES } from './timeline.js';

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

const inventaire = encadre(html`<p>La liste montre tous les objets suivis, par ordre alphabétique : leur nom (un clic ouvre la fiche), leur emplacement et depuis quand ils y sont.</p>
<p>L'emplacement n'est jamais saisi : il vient du dernier événement connu.</p>
<ul>
<li>Un scan : l'objet est passé devant le lecteur d'un poste.</li>
<li>Une correction à la main, depuis la fiche de l'objet.</li>
<li>Le plus récent des deux l'emporte. Après une correction, le scan suivant reprend la main.</li>
</ul>
<p>Ce que peut indiquer la colonne «&nbsp;Emplacement&nbsp;» :</p>
<ul>
<li><span class="etat etat-poste">Atelier</span> : le nom d'un poste, l'objet s'y trouve.</li>
<li><span class="etat etat-inconnue">lecteur non affecté</span> : l'objet a été scanné par un lecteur rattaché à aucun poste. Un clic sur la pastille ouvre ce lecteur, pour le rattacher à un poste.</li>
<li><span class="etat etat-jamais">jamais localisé</span> : l'objet n'a jamais été scanné ni corrigé.</li>
</ul>
<p>Pour rechercher :</p>
<ul>
<li>tapez un ou plusieurs mots, ou des morceaux de mots, du nom ou d'une propriété (numéro de série, marque…), sans vous soucier des accents ni des majuscules : «&nbsp;fluke 7&nbsp;» trouve «&nbsp;Multimètre Fluke 87V n° 7&nbsp;» ;</li>
<li>ou au moins 4 caractères du numéro de puce, dont un chiffre (ou le numéro complet), avec ou sans séparateurs («&nbsp;04:A1&nbsp;» comme «&nbsp;04a1&nbsp;») ;</li>
<li>la liste se met à jour pendant la frappe ; «&nbsp;Effacer&nbsp;» revient à la liste complète ;</li>
<li>depuis n'importe quel écran, <kbd><kbd>Ctrl</kbd><kbd>K</kbd></kbd> ou <kbd><kbd>/</kbd></kbd> ouvre la recherche «&nbsp;Où est…&nbsp;?&nbsp;».</li>
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
<li>En cas d'erreur, le champ concerné est signalé avec une explication, et votre saisie est conservée.</li>
</ul>`;

const nouvelleFiche = encadre(html`<p>Remplissez la fiche, puis cliquez sur «&nbsp;Créer la fiche&nbsp;». Seul le nom est obligatoire.</p>
${CHAMPS_FICHE}
<p>La puce :</p>
<ul>
<li>Une nouvelle fiche n'a pas de puce : l'objet reste «&nbsp;jamais localisé&nbsp;» tant qu'il n'est ni scanné ni corrigé à la main.</li>
<li>Pour lui en donner une : sur sa fiche, cliquez sur «&nbsp;Donner une puce&nbsp;», scannez la puce sur un lecteur, puis choisissez-la.</li>
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
<li>La puce et l'emplacement ne se changent pas ici : utilisez «&nbsp;Corriger l'emplacement&nbsp;» sur la fiche, ou son menu «&nbsp;…&nbsp;» pour changer ou retirer sa puce.</li>
</ul>`);

// Fiche d'un objet : trois phrases au plus (étape U3).
const fiche = encadre(html`<p>L'emplacement affiché est celui du dernier scan de la puce, ou de la dernière correction à la main : le plus récent l'emporte.</p>
<p>Si l'objet a bougé sans passer devant un lecteur, utilisez «&nbsp;Corriger l'emplacement&nbsp;» : la correction apparaît dans l'historique, avec votre nom.</p>
<p>Le menu «&nbsp;…&nbsp;» sert à changer ou retirer la puce, ou à supprimer la fiche.</p>`);

const historique = encadre(html`<p>Chaque ligne est un déplacement : l'arrivée à un poste (plusieurs scans de suite au même poste comptent pour un), une correction à la main ou un changement de puce.</p>
<p>Le plus récent est en haut, ${TIMELINE_PAGE_ENTRIES} par page ; «&nbsp;Déplacements plus anciens&nbsp;» affiche la suite.</p>`);

const donnerPuce = encadre(html`<p>Posez la puce sur l'objet, scannez-la sur n'importe quel lecteur, puis cliquez sur «&nbsp;Actualiser&nbsp;» : elle apparaît en tête de liste.</p>
<ul>
<li>La liste montre les ${MAX_OFFERED_CHIPS} puces inconnues scannées le plus récemment, la plus récente en premier.</li>
<li>Dès qu'elle est choisie, l'objet est localisé au poste où la puce a été scannée en dernier, sauf si une correction à la main est plus récente.</li>
<li>Si la fiche avait déjà une puce, ou si la puce choisie a déjà servi à une autre fiche, une confirmation est demandée.</li>
</ul>`);

const retirerPuce = encadre(html`<p>Retirez la puce d'un objet si elle est cassée, perdue ou posée par erreur.</p>
<ul>
<li>Ses scans sont conservés : elle redevient une puce inconnue, que l'on peut donner à un autre objet.</li>
<li>Par défaut, l'objet garde son emplacement actuel (une correction à la main est notée). Sinon, sans puce, il n'est plus suivi par les lecteurs : son emplacement devient celui de sa dernière correction, ou «&nbsp;jamais localisé&nbsp;».</li>
<li>Le retrait est noté dans les modifications de la fiche.</li>
</ul>`);

const localisation = encadre(html`<p>Indiquez à la main le poste où se trouve l'objet, par exemple s'il a été déplacé sans être scanné.</p>
<ul>
<li>La correction s'applique tout de suite, à l'heure actuelle.</li>
<li>Elle vaut jusqu'au prochain scan de l'objet, qui reprend la main.</li>
<li>Elle est notée dans l'historique de la fiche, avec votre nom.</li>
<li>Seuls les postes existants sont proposés. Pour en ajouter un : rubrique «&nbsp;Postes&nbsp;».</li>
</ul>`);

const supprimerFiche = encadre(html`<p>La suppression est définitive.</p>
<ul>
<li>Ce qui part : la fiche, ses propriétés, ses notes et ses corrections d'emplacement.</li>
<li>Ce qui reste : les scans de sa puce et l'historique des modifications, qui garde la trace de la suppression.</li>
<li>Sa puce redevient inconnue : si elle a déjà été scannée, elle réapparaît dans «&nbsp;Puces inconnues&nbsp;», où l'on peut l'associer à une autre fiche.</li>
</ul>`);

// ---------------------------------------------------------------- postes

const postes = encadre(html`<p>Un poste est un lieu de travail : chaque tuile montre les objets qui s'y trouvent, la dernière arrivée et l'état de son lecteur.</p>
<p>En orange, un lecteur n'a rien envoyé depuis plus de 24 heures : vérifiez qu'il est allumé, branché et à portée du réseau ; un lecteur neuf reste «&nbsp;en attente du premier scan&nbsp;».</p>
<p>«&nbsp;Ajouter un poste&nbsp;» : un nom suffit ; ajoutez-lui ensuite un lecteur.</p>`);

const poste = encadre(html`<p>La fiche montre d'abord les objets présents à ce poste et depuis quand, puis son lecteur et les dernières arrivées.</p>
<p>«&nbsp;Renommer&nbsp;» change le nom du poste sans toucher à son passé.</p>
<p>Un poste qui n'a jamais servi peut être supprimé ; sinon, renommez-le.</p>`);

const nouveauPoste = encadre(html`<p>Donnez un nom au poste, puis cliquez sur «&nbsp;Créer le poste&nbsp;» ; la description est facultative.</p>
<p>Deux postes ne peuvent pas porter le même nom (majuscules et minuscules confondues).</p>
<p>Ensuite, ajoutez-lui un lecteur depuis sa tuile ou la rubrique «&nbsp;Lecteurs&nbsp;».</p>`);

const modifierPoste = encadre(html`<p>Modifiez le nom ou la description, puis cliquez sur «&nbsp;Enregistrer&nbsp;».</p>
<ul>
<li>Deux postes ne peuvent pas porter le même nom (majuscules et minuscules confondues).</li>
<li>Renommer un poste ne change pas son passé : ses scans et ses corrections restent rattachés à lui.</li>
<li>Le changement est noté dans l'historique des modifications.</li>
</ul>`);

const supprimerPoste = encadre(html`<p>Seul un poste sans historique peut être supprimé : aucun scan, aucune correction d'emplacement, aucun lecteur.</p>
<ul>
<li>La suppression est définitive. L'historique des modifications en garde la trace.</li>
<li>Un poste qui a servi ne peut pas être supprimé : renommez-le plutôt.</li>
</ul>`);

// ---------------------------------------------------------------- lecteurs

const lecteurs = encadre(html`<p>Un lecteur est le boîtier posé sur un poste : il lit la puce des objets et envoie chaque scan.</p>
<p>Les lecteurs à surveiller sont en tête : «&nbsp;silencieux&nbsp;» (rien depuis plus de 24 heures) ou «&nbsp;en attente du premier scan&nbsp;» ; les lecteurs désactivés sont rangés en bas.</p>
<p>«&nbsp;Ajouter un lecteur&nbsp;» donne un numéro et une clé, à configurer une seule fois dans le boîtier.</p>`);

const nouveauLecteur = encadre(html`<p>Donnez un nom au lecteur si vous le souhaitez (par exemple «&nbsp;Boîtier établi gauche&nbsp;») et choisissez son poste, puis cliquez sur «&nbsp;Ajouter le lecteur&nbsp;».</p>
<p>La page suivante affiche son numéro et sa clé, une seule fois : configurez-les tout de suite dans le boîtier.</p>
<p>Clé perdue&nbsp;? Remplacez-la depuis la fiche du lecteur.</p>`);

const lecteur = encadre(html`<p>La fiche montre l'état du lecteur, son poste, le numéro à configurer dans le boîtier et ses derniers scans.</p>
<p>«&nbsp;Changer de poste&nbsp;» sert quand le boîtier est déplacé : les scans passés gardent leur poste.</p>
<p>Clé perdue&nbsp;? «&nbsp;Remplacer la clé&nbsp;» crée un nouveau numéro et une nouvelle clé ; «&nbsp;Désactiver&nbsp;» retire définitivement le lecteur.</p>`);

const changerPoste = encadre(html`<p>Choisissez le poste où se trouve désormais le boîtier, puis cliquez sur «&nbsp;Enregistrer&nbsp;».</p>
<p>Seuls les prochains scans seront rattachés au poste choisi : l'historique n'est pas réécrit.</p>
<p>«&nbsp;Pas de poste pour l'instant&nbsp;» détache le lecteur : les objets qu'il scanne auront pour emplacement «&nbsp;lecteur non affecté&nbsp;».</p>`);

const renommerLecteur = encadre(html`<p>Saisissez le nom du boîtier, puis cliquez sur «&nbsp;Enregistrer&nbsp;».</p>
<ul>
<li>Le nom apparaît partout où le lecteur est désigné : listes, fiche du poste, historique des scans d'un objet.</li>
<li>Laissez le champ vide pour retirer le nom : le lecteur est alors désigné par son poste, ou par son numéro s'il n'est rattaché à aucun poste.</li>
<li>Le numéro configuré dans le boîtier ne change pas : rien n'est à refaire sur le boîtier.</li>
</ul>`);

const desactiverLecteur = encadre(html`<p>Désactivez un lecteur hors service, perdu ou retiré : il n'enverra plus de scans, et c'est définitif.</p>
<p>Ses scans passés et les emplacements qui en découlent sont conservés.</p>
<p>Si seule la clé pose problème, préférez «&nbsp;Remplacer la clé&nbsp;».</p>`);

const remplacerCle = encadre(html`<p>Remplacez la clé si elle a été perdue ou a pu être vue.</p>
<p>Un nouveau numéro et une nouvelle clé sont créés, au même poste et sous le même nom ; l'ancien numéro cesse aussitôt de fonctionner.</p>
<p>La page suivante les affiche une seule fois : configurez les deux dans le boîtier. Les scans passés sont conservés.</p>`);

// ---------------------------------------------------------------- puces inconnues

// Page « Puces inconnues » (étape U5) : trois phrases.
const puces = encadre(html`<p>Chaque puce scannée qu'aucune fiche ne porte encore apparaît ici, en direct (les ${MAX_UNKNOWN_CHIPS} plus récentes).</p>
<p>Tapez le nom de l'objet puis Entrée : sa fiche est créée et l'objet est aussitôt localisé au poste où la puce a été scannée.</p>
<p>L'objet a déjà une fiche&nbsp;? Choisissez «&nbsp;Associer à une fiche existante&nbsp;».</p>`);

const associerRecherche = encadre(html`<p>Cherchez la fiche de l'objet qui porte cette puce, puis cliquez sur «&nbsp;Associer&nbsp;».</p>
<ul>
<li>Recherchez par des mots du nom ou d'une propriété (numéro de série, marque…), ou par au moins 4 caractères du numéro de la puce actuelle de la fiche, dont un chiffre (ou le numéro complet).</li>
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

// Écran d'accueil (étape U4) : le principe en trois phrases, pour un premier contact.
const accueil = encadre(html`<p>Chaque objet porte une puce, et chaque poste a son lecteur.</p>
<p>En arrivant à un poste, présentez l'objet au lecteur : MetroTrack note tout seul son nouvel emplacement, et il apparaît ici dans «&nbsp;Derniers mouvements&nbsp;».</p>
<p>Un objet a bougé sans être scanné&nbsp;? Corrigez son emplacement à la main depuis sa fiche.</p>`);

/** Encadrés d'aide, un par page. Fragments constants, produits une fois au chargement. */
export const AIDE = Object.freeze({
  accueil,
  inventaire,
  nouvelleFiche,
  ficheDepuisPuce,
  modifierFiche,
  fiche,
  historique,
  donnerPuce,
  retirerPuce,
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
  renommerLecteur,
  desactiverLecteur,
  remplacerCle,
  puces,
  associerRecherche,
  associerConfirmation,
});
