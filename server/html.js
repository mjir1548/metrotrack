// Gabarits HTML à échappement automatique (protection contre le XSS).
//
// SÉCURITÉ : toute valeur interpolée dans html`...` est échappée, sauf si c'est le résultat
// d'un autre appel html`...` (fragment déjà sûr). Il n'existe AUCUN autre moyen d'insérer du
// HTML tel quel : le seul HTML non échappé est le texte constant écrit dans les gabarits.
// Un oubli d'échappement est donc impossible.
//
// Contextes couverts : texte d'un élément, et valeur d'attribut ENTRE GUILLEMETS DOUBLES.
// Règles d'usage : jamais d'interpolation dans un nom de balise ou d'attribut, dans un attribut
// sans guillemets, dans <script>/<style> (interdits de toute façon par la CSP), ni dans une URL
// formée à partir d'une saisie (les seules URL construites sont /items/<entier>,
// /stations/<entier>, /readers/<entier>, avec des identifiants lus en base, et
// /chips/<UID>/..., avec un UID lu en base ou validé au format strict hexadécimal majuscule).

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Échappe & < > " ' ; null et undefined donnent une chaîne vide. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Fragment HTML déjà sûr. La classe n'est pas exportée : on n'obtient un fragment sûr que
// par html`...`.
class SafeHtml {
  #text;
  constructor(text) { this.#text = text; }
  toString() { return this.#text; }
}

/** Vrai si la valeur est un fragment produit par html`...`. */
export function isSafeHtml(value) {
  return value instanceof SafeHtml;
}

/**
 * Gabarit étiqueté : html`<p>${valeur}</p>`. Valeurs acceptées : fragment sûr (inséré tel
 * quel), tableau de valeurs (chacune traitée selon ces mêmes règles), null/undefined (rien),
 * toute autre valeur (convertie en texte puis échappée ; attention, false donne « false » :
 * utiliser null pour « rien »).
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

function render(value) {
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}
