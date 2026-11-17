// Pages HTML de l'interface. Toutes passent par le gabarit html`...` (server/html.js) :
// chaque valeur interpolée est échappée automatiquement.
// Aucun attribut style, aucune balise <style> ni <script> : la CSP les bloquerait, et toute
// la mise en forme est dans web/static/style.css.

import { html } from './html.js';
import { formatAge, formatDateTime } from './dates.js';
import { MAX_QUERY_CHARS } from './inventory.js';

export const BUSY_MESSAGE = 'Trop de connexions en cours. Réessayez dans un instant.';

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

/**
 * Liste de l'inventaire.
 * @param {{query: string, items: object[], now: number}} data
 */
export function inventoryPage(user, { query, items, now }) {
  const searching = query !== '';
  const summary = searching
    ? html`<p class="resultats" role="status">${plural(items.length, 'résultat', 'résultats')} pour «&nbsp;${query}&nbsp;» · <a href="/">Effacer</a></p>`
    : html`<p class="resultats">${plural(items.length, 'objet', 'objets')}</p>`;

  let body;
  if (items.length === 0 && !searching) {
    body = html`<div class="vide"><p>Aucun objet dans l'inventaire pour le moment.</p></div>`;
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

  return appLayout(user, 'Inventaire', html`<div class="entete-page">
<h1>Inventaire</h1>
</div>
<form class="recherche" method="get" action="/" role="search">
<label class="visuellement-cache" for="q">Rechercher un objet par nom ou UID</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom ou UID" autocomplete="off" spellcheck="false">
<button class="bouton" type="submit">Rechercher</button>
</form>
${summary}
${body}`, true);
}

/**
 * Fiche d'un objet.
 * @param {{item: object, scans: object[], now: number}} data
 */
export function itemPage(user, { item, scans, now }) {
  const source = item.at === null
    ? html`<p class="texte-doux">${item.uid_nfc === null ? 'Aucune puce associée : l\'objet ne peut pas être localisé par un scan.' : 'Cette puce n\'a encore été scannée sur aucun poste.'}</p>`
    : html`<p class="localisation-detail">${timeTag(item.at, now)} · scan, lecteur n° ${item.reader_id}</p>`;

  const properties = item.properties.length === 0
    ? html`<p class="texte-doux">Aucune propriété</p>`
    : html`<dl class="proprietes">
${item.properties.map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>
`)}</dl>`;

  const notes = item.notes.trim() === ''
    ? html`<p class="texte-doux">Aucune note</p>`
    : html`<p class="notes">${item.notes}</p>`;

  let history;
  if (item.uid_nfc === null) history = html`<p class="texte-doux">Aucune puce associée.</p>`;
  else if (scans.length === 0) history = html`<p class="texte-doux">Aucun scan pour cette puce.</p>`;
  else {
    history = html`<table class="tableau tableau-scans">
<thead><tr><th scope="col">Poste</th><th scope="col">Heure</th></tr></thead>
<tbody>
${scans.map((scan) => html`<tr>
<td data-label="Poste">${scan.station_id === null ? html`<span class="texte-doux">lecteur n° ${scan.reader_id} non affecté</span>` : scan.station_name}</td>
<td data-label="Heure">${timeTag(scan.received_at, now)}</td>
</tr>
`)}</tbody>
</table>`;
  }

  return appLayout(user, item.name, html`<p class="retour"><a href="/">← Inventaire</a></p>
<div class="entete-page">
<h1>${item.name}</h1>
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
${history}
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
