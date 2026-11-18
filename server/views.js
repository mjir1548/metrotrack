// Pages HTML de l'interface. Toutes passent par le gabarit html`...` (server/html.js) :
// chaque valeur interpolée est échappée automatiquement.
// Aucun attribut style, aucune balise <style> ni <script> : la CSP les bloquerait, et toute
// la mise en forme est dans web/static/style.css.

import { html } from './html.js';
import { formatAge, formatDateTime } from './dates.js';
import { MAX_QUERY_CHARS } from './inventory.js';
import {
  MAX_NAME_CHARS, MAX_NOTES_CHARS, MAX_PROPERTIES, MAX_PROPERTY_KEY_CHARS, MAX_PROPERTY_VALUE_CHARS,
} from './items.js';

export const BUSY_MESSAGE = 'Trop de connexions en cours. Réessayez dans un instant.';

// Messages de confirmation après une action. La page reçoit seulement un code constant
// (?ok=cree...) : le texte affiché est toujours l'un de ceux-ci, jamais un texte reçu.
// Code inconnu : aucun message.
const LIST_NOTICES = { supprime: 'Fiche supprimée.' };
const ITEM_NOTICES = {
  cree: 'Fiche créée.',
  modifie: 'Modifications enregistrées.',
  inchange: 'Aucune modification : la fiche était déjà à jour.',
  corrige: 'Localisation corrigée.',
};

const BRAND = html`<span class="marque"><span class="marque-logo" aria-hidden="true">MT</span>MetroTrack</span>`;

function documentPage(title, bodyClass, body) {
  return html`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · MetroTrack</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- hors session

// Page hors session (connexion, refus) : une carte centrée.
function cardLayout(title, content) {
  return documentPage(title, 'page-connexion', html`<main class="carte">
${BRAND}
${content}
</main>`);
}

/** Page de connexion. message : texte d'erreur affiché au-dessus du formulaire, ou null. */
export function loginPage(csrf, message) {
  const error = message === null ? null : html`<p class="erreur" role="alert">${message}</p>\n`;
  return cardLayout('Connexion', html`<h1>Connexion</h1>
<p class="sous-titre">Inventaire du matériel</p>
${error}<form class="formulaire" method="post" action="/login">
<input type="hidden" name="csrf" value="${csrf}">
<div class="champ">
<label for="username">Identifiant</label>
<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus>
</div>
<div class="champ">
<label for="password">Mot de passe</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
</div>
<button class="bouton" type="submit">Se connecter</button>
</form>`);
}

export function forbiddenPage() {
  return cardLayout('Requête refusée', html`<h1>Requête refusée</h1>
<p class="sous-titre">La page a peut-être expiré. Rechargez-la puis recommencez.</p>
<a class="bouton" href="/login">Revenir à la connexion</a>`);
}

// ---------------------------------------------------------------- application

/**
 * Page de l'application : bandeau (marque, navigation, compte, déconnexion) puis contenu.
 * @param {{username: string, csrf: string}} user
 * @param {boolean} onList vrai sur la liste elle-même (aria-current="page")
 */
function appLayout(user, title, content, onList = false) {
  return documentPage(title, 'page-app', html`<header class="barre">
<div class="barre-interieur">
<div class="barre-gauche">
${BRAND}
<nav class="navigation" aria-label="Navigation principale">
<a class="actif" href="/"${onList ? html` aria-current="page"` : null}>Inventaire</a>
</nav>
</div>
<div class="session">
<span>Connecté en tant que <strong>${user.username}</strong></span>
<form method="post" action="/logout">
<input type="hidden" name="csrf" value="${user.csrf}">
<button class="bouton bouton-secondaire" type="submit">Se déconnecter</button>
</form>
</div>
</div>
</header>
<main class="contenu">
${content}
</main>`);
}

/** Message de confirmation pour un code ?ok= connu, sinon rien. */
function noticeFor(notices, code) {
  if (typeof code !== 'string' || !Object.hasOwn(notices, code)) return null;
  return html`<p class="succes" role="status">${notices[code]}</p>\n`;
}

// Localisation d'une ligne (liste ou fiche) : libellé et état pour la puce de couleur.
function locationOf(row) {
  if (row.at === null) return { label: 'jamais localisé', state: 'jamais' };
  if (row.station_id === null) return { label: `inconnue (lecteur n° ${row.reader_id} non affecté)`, state: 'inconnue' };
  return { label: row.station_name, state: 'poste' };
}

function locationBadge(row) {
  const { label, state } = locationOf(row);
  return html`<span class="etat etat-${state}">${label}</span>`;
}

// Ancienneté lisible, avec l'horodatage exact pour les machines (datetime) et au survol (title).
function timeTag(iso, now) {
  return html`<time datetime="${iso}" title="${formatDateTime(iso)}">${formatAge(iso, now)}</time>`;
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const thousands = (n) => n.toLocaleString('fr-FR');

/**
 * Liste de l'inventaire.
 * @param {{query: string, items: object[], now: number, notice?: string|null}} data
 *   notice : code ?ok= reçu (seuls les codes connus affichent un message)
 */
export function inventoryPage(user, { query, items, now, notice = null }) {
  const searching = query !== '';
  const summary = searching
    ? html`<p class="resultats" role="status">${plural(items.length, 'résultat', 'résultats')} pour «&nbsp;${query}&nbsp;» · <a href="/">Effacer</a></p>`
    : html`<p class="resultats">${plural(items.length, 'objet', 'objets')}</p>`;

  let body;
  if (items.length === 0 && !searching) {
    body = html`<div class="vide"><p>Aucun objet dans l'inventaire pour le moment.</p>
<p class="texte-doux">Créez la première fiche avec le bouton «&nbsp;Nouvelle fiche&nbsp;».</p></div>`;
  } else if (items.length === 0) {
    body = html`<div class="vide"><p>Aucun objet ne correspond à «&nbsp;${query}&nbsp;».</p>
<p class="texte-doux">Essayez une partie du nom, ou quelques caractères de l'UID de la puce.</p></div>`;
  } else {
    body = html`<div class="panneau-tableau">
<table class="tableau tableau-inventaire">
<thead><tr><th scope="col">Objet</th><th scope="col">Localisation</th><th scope="col">Depuis</th></tr></thead>
<tbody>
${items.map((item) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a>${item.uid_nfc === null ? null : html`<span class="uid">${item.uid_nfc}</span>`}</td>
<td data-label="Localisation">${locationBadge(item)}</td>
<td data-label="Depuis">${item.at === null ? html`<span class="texte-doux">—</span>` : timeTag(item.at, now)}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  }

  return appLayout(user, 'Inventaire', html`${noticeFor(LIST_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>Inventaire</h1>
<div class="actions-page">
<a class="bouton" href="/items/new">Nouvelle fiche</a>
</div>
</div>
<form class="recherche" method="get" action="/" role="search">
<label class="visuellement-cache" for="q">Rechercher un objet par nom ou UID</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom ou UID" autocomplete="off" spellcheck="false">
<button class="bouton bouton-secondaire" type="submit">Rechercher</button>
</form>
${summary}
${body}`, true);
}

/**
 * Fiche d'un objet.
 * @param {{item: object, scans: object[], history: object[], now: number, notice?: string|null}} data
 *   history : dernières modifications (items.js, itemHistory) ; notice : code ?ok= reçu
 */
export function itemPage(user, { item, scans, history = [], now, notice = null }) {
  let source;
  if (item.at === null) {
    source = html`<p class="texte-doux">${item.uid_nfc === null ? 'Aucune puce associée : l\'objet ne peut pas être localisé par un scan.' : 'Cette puce n\'a encore été scannée sur aucun poste.'}</p>`;
  } else if (item.source === 'manual') {
    source = html`<p class="localisation-detail">${timeTag(item.at, now)} · correction manuelle par ${item.corrected_by ?? 'un compte inconnu'}</p>`;
  } else {
    source = html`<p class="localisation-detail">${timeTag(item.at, now)} · scan, lecteur n° ${item.reader_id}</p>`;
  }

  const properties = item.properties.length === 0
    ? html`<p class="texte-doux">Aucune propriété</p>`
    : html`<dl class="proprietes">
${item.properties.map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>
`)}</dl>`;

  const notes = item.notes.trim() === ''
    ? html`<p class="texte-doux">Aucune note</p>`
    : html`<p class="notes">${item.notes}</p>`;

  let scanHistory;
  if (item.uid_nfc === null) scanHistory = html`<p class="texte-doux">Aucune puce associée.</p>`;
  else if (scans.length === 0) scanHistory = html`<p class="texte-doux">Aucun scan pour cette puce.</p>`;
  else {
    scanHistory = html`<table class="tableau tableau-scans">
<thead><tr><th scope="col">Poste</th><th scope="col">Heure</th></tr></thead>
<tbody>
${scans.map((scan) => html`<tr>
<td data-label="Poste">${scan.station_id === null ? html`<span class="texte-doux">lecteur n° ${scan.reader_id} non affecté</span>` : scan.station_name}</td>
<td data-label="Heure">${timeTag(scan.received_at, now)}</td>
</tr>
`)}</tbody>
</table>`;
  }

  const changes = history.length === 0
    ? html`<p class="texte-doux">Aucune modification enregistrée.</p>`
    : html`<table class="tableau tableau-modifications">
<thead><tr><th scope="col">Date</th><th scope="col">Auteur</th><th scope="col">Modification</th></tr></thead>
<tbody>
${history.map((entry) => html`<tr>
<td data-label="Date">${timeTag(entry.at, now)}</td>
<td data-label="Auteur">${entry.username ?? html`<span class="texte-doux">ligne de commande</span>`}</td>
<td data-label="Modification">${entry.label}</td>
</tr>
`)}</tbody>
</table>`;

  return appLayout(user, item.name, html`<p class="retour"><a href="/">← Inventaire</a></p>
${noticeFor(ITEM_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>${item.name}</h1>
<div class="actions-page">
<a class="bouton" href="/items/${item.id}/edit">Modifier</a>
<a class="bouton bouton-secondaire" href="/items/${item.id}/location">Corriger la localisation</a>
<a class="lien-danger" href="/items/${item.id}/delete">Supprimer</a>
</div>
</div>
<div class="fiche">
<section class="fiche-carte" aria-labelledby="titre-localisation">
<h2 id="titre-localisation">Localisation actuelle</h2>
<p>${locationBadge(item)}</p>
${source}
</section>
<section class="fiche-carte" aria-labelledby="titre-identification">
<h2 id="titre-identification">Identification</h2>
<dl class="proprietes">
<div><dt>Puce NFC</dt><dd>${item.uid_nfc === null ? html`<span class="texte-doux">aucune puce associée</span>` : html`<span class="uid">${item.uid_nfc}</span>`}</dd></div>
<div><dt>Créée</dt><dd>${formatDateTime(item.created_at)}</dd></div>
<div><dt>Modifiée</dt><dd>${formatDateTime(item.updated_at)}</dd></div>
</dl>
</section>
<section class="fiche-carte" aria-labelledby="titre-proprietes">
<h2 id="titre-proprietes">Propriétés</h2>
${properties}
</section>
<section class="fiche-carte" aria-labelledby="titre-notes">
<h2 id="titre-notes">Notes</h2>
${notes}
</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-scans">
<h2 id="titre-scans">Derniers scans</h2>
${scanHistory}
</section>
<section class="fiche-carte fiche-large" aria-labelledby="titre-modifications">
<h2 id="titre-modifications">Historique des modifications</h2>
${changes}
</section>
</div>`);
}

export function itemNotFoundPage(user) {
  return appLayout(user, 'Fiche introuvable', html`<p class="retour"><a href="/">← Inventaire</a></p>
<div class="vide">
<h1>Fiche introuvable</h1>
<p class="texte-doux">Aucun objet ne correspond à cette adresse.</p>
</div>`);
}

// ---------------------------------------------------------------- édition

// Message d'erreur près d'un champ (id référencé par aria-describedby du champ).
function fieldError(id, message) {
  return message ? html`<p class="erreur-champ" id="${id}">${message}</p>\n` : null;
}
const invalid = (message) => (message ? html` aria-invalid="true"` : null);
// Valeur de aria-describedby : l'aide, plus le message d'erreur s'il existe.
const describedBy = (helpId, errorId, message) => (message ? `${helpId} ${errorId}` : helpId);

const EMPTY_ROW = { key: '', value: '', error: null };

/**
 * Formulaire de création ou de modification d'une fiche.
 * @param {{
 *   item: {id: number|bigint, name: string}|null,
 *   form: {name: string, notes: string, rows: {key: string, value: string, error: string|null}[], blankRows: number},
 *   errors: {name?: string, notes?: string, properties?: string},
 * }} data
 *   item : null pour une création ; sinon la fiche modifiée (nom actuellement enregistré) ;
 *   form : valeurs à afficher (saisies nettoyées, ou fiche enregistrée), puis blankRows lignes vides.
 */
export function itemFormPage(user, { item, form, errors }) {
  const editing = item !== null;
  const action = editing ? `/items/${item.id}/edit` : '/items/new';
  const cancel = editing ? `/items/${item.id}` : '/';
  const title = editing ? 'Modifier la fiche' : 'Nouvelle fiche';
  const failed = Object.keys(errors).length > 0 || form.rows.some((row) => row.error !== null);
  const rows = [...form.rows, ...Array(form.blankRows).fill(EMPTY_ROW)];

  return appLayout(user, title, html`<p class="retour"><a href="${cancel}">${editing ? '← Retour à la fiche' : '← Inventaire'}</a></p>
<div class="entete-page">
<h1>${title}</h1>
${editing ? html`<p class="sous-titre-page">${item.name}</p>\n` : null}</div>
${failed ? html`<p class="erreur" role="alert">La fiche n'a pas été enregistrée. Corrigez les champs signalés en rouge : votre saisie est conservée.</p>\n` : null}<form class="formulaire-page" method="post" action="${action}">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="champ">
<label for="name">Nom <span class="obligatoire">(obligatoire)</span></label>
<input id="name" name="name" value="${form.name}" maxlength="${MAX_NAME_CHARS}" required autocomplete="off" aria-describedby="${describedBy('name-aide', 'name-erreur', errors.name)}"${invalid(errors.name)}>
<p class="aide" id="name-aide">Par exemple «&nbsp;Multimètre Fluke 87V&nbsp;». ${MAX_NAME_CHARS} caractères au plus.</p>
${fieldError('name-erreur', errors.name)}</div>
<div class="champ">
<label for="notes">Notes</label>
<textarea id="notes" name="notes" rows="5" maxlength="${MAX_NOTES_CHARS}" aria-describedby="${describedBy('notes-aide', 'notes-erreur', errors.notes)}"${invalid(errors.notes)}>${form.notes}</textarea>
<p class="aide" id="notes-aide">Texte libre sur plusieurs lignes. ${thousands(MAX_NOTES_CHARS)} caractères au plus.</p>
${fieldError('notes-erreur', errors.notes)}</div>
<fieldset class="champ-proprietes" aria-describedby="${describedBy('proprietes-aide', 'proprietes-erreur', errors.properties)}">
<legend>Propriétés</legend>
<p class="aide" id="proprietes-aide">Paires libres, par exemple «&nbsp;Marque&nbsp;» et «&nbsp;Fluke&nbsp;». ${MAX_PROPERTIES} au plus ; nom de ${MAX_PROPERTY_KEY_CHARS} caractères au plus, valeur de ${thousands(MAX_PROPERTY_VALUE_CHARS)}. Une ligne laissée vide est ignorée. Plus de lignes : bouton «&nbsp;Ajouter des lignes&nbsp;» en bas du formulaire.</p>
${fieldError('proprietes-erreur', errors.properties)}<div class="proprietes-saisie">
<div class="propriete-entete" aria-hidden="true"><span>Nom</span><span>Valeur</span></div>
${rows.map((row, i) => propertyRow(row, i + 1))}</div>
</fieldset>
<div class="actions-formulaire">
<button class="bouton" type="submit">${editing ? 'Enregistrer' : 'Créer la fiche'}</button>
<button class="bouton bouton-secondaire" type="submit" name="action" value="lignes" formnovalidate>Ajouter des lignes</button>
<a class="lien-annuler" href="${cancel}">Annuler</a>
</div>
</form>`);
}

// Ligne de propriété n (à partir de 1) : deux champs répétés prop_key / prop_value, chacun avec
// un libellé lu par les lecteurs d'écran (les en-têtes visibles « Nom », « Valeur » sont
// masqués pour eux).
function propertyRow(row, n) {
  const errorId = `propriete-erreur-${n}`;
  const extra = row.error ? html` aria-invalid="true" aria-describedby="${errorId}"` : null;
  return html`<div class="propriete-ligne">
<label class="visuellement-cache" for="prop-key-${n}">Nom de la propriété ${n}</label>
<input id="prop-key-${n}" name="prop_key" value="${row.key}" maxlength="${MAX_PROPERTY_KEY_CHARS}" autocomplete="off"${extra}>
<label class="visuellement-cache" for="prop-value-${n}">Valeur de la propriété ${n}</label>
<input id="prop-value-${n}" name="prop_value" value="${row.value}" maxlength="${MAX_PROPERTY_VALUE_CHARS}" autocomplete="off"${extra}>
${row.error ? html`<p class="erreur-champ" id="${errorId}">${row.error}</p>\n` : null}</div>
`;
}

/** Confirmation de suppression d'une fiche. */
export function deleteItemPage(user, { item }) {
  return appLayout(user, 'Supprimer la fiche', html`<p class="retour"><a href="/items/${item.id}">← Retour à la fiche</a></p>
<div class="entete-page">
<h1>Supprimer la fiche</h1>
</div>
<div class="panneau panneau-danger">
<p>Vous allez supprimer la fiche «&nbsp;<strong class="nom-confirme">${item.name}</strong>&nbsp;».</p>
<p>Ses propriétés, ses notes et l'historique de ses corrections manuelles de localisation seront supprimés avec elle.</p>
<p class="texte-doux">Le journal des scans de sa puce et le journal des modifications sont conservés.</p>
<form method="post" action="/items/${item.id}/delete">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Supprimer définitivement</button>
<a class="lien-annuler" href="/items/${item.id}">Annuler</a>
</div>
</form>
</div>`);
}

/**
 * Correction manuelle de localisation.
 * @param {{item: object, stations: {id: number, name: string}[], selected?: string|null, error?: string|null}} data
 *   item : fiche avec sa localisation (getItem) ; selected : valeur choisie à réafficher.
 */
export function locationPage(user, { item, stations, selected = null, error = null }) {
  const current = html`<p class="localisation-actuelle"><span class="texte-doux">Localisation actuelle :</span> ${locationBadge(item)}</p>`;
  let body;
  if (stations.length === 0) {
    body = html`<div class="vide"><p>Aucun poste n'existe encore.</p>
<p class="texte-doux">Il faut d'abord créer un poste pour pouvoir y localiser un objet.</p></div>`;
  } else {
    body = html`<form class="formulaire-page" method="post" action="/items/${item.id}/location">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="champ">
<label for="station">Poste où se trouve l'objet</label>
<select id="station" name="station" required aria-describedby="${describedBy('station-aide', 'station-erreur', error)}"${invalid(error)}>
<option value="">Choisir un poste…</option>
${stations.map((station) => html`<option value="${station.id}"${String(station.id) === selected ? html` selected` : null}>${station.name}</option>
`)}</select>
<p class="aide" id="station-aide">La correction s'applique tout de suite, à l'heure actuelle. Le prochain scan de l'objet la remplacera.</p>
${fieldError('station-erreur', error)}</div>
<div class="actions-formulaire">
<button class="bouton" type="submit">Enregistrer la correction</button>
<a class="lien-annuler" href="/items/${item.id}">Annuler</a>
</div>
</form>`;
  }
  return appLayout(user, 'Corriger la localisation', html`<p class="retour"><a href="/items/${item.id}">← Retour à la fiche</a></p>
<div class="entete-page">
<h1>Corriger la localisation</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${current}
${body}`);
}
