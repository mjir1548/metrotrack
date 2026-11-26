// Jeu d'icônes MetroTrack (dessiné pour le projet, docs/maquettes/assets/icones.svg, plus les
// icônes ajoutées par la direction B : i-supprimer, i-associer). Aucune source externe.
// Grille 24 x 24, trait 1.75, extrémités arrondies, couleur = currentColor.
//
// Le sprite est intégré en tête de chaque page (SVG dans le HTML), avec seulement les symboles
// que la page utilise (spriteFor), et masqué par la classe CSS « sprite » : ni attribut style
// (la CSP l'interdit), ni xmlns (inutile en SVG intégré au HTML), ni image data:.
// Chaque icône est un <svg><use href="#i-..."></use></svg>, purement décoratif (aria-hidden) :
// le sens est toujours porté par le texte voisin.
// Texte CONSTANT : aucune donnée de la base ni de la requête n'y entre.

import { html } from './html.js';

// Fragment html`...` (et non chaîne) : inséré tel quel, sans échappement des guillemets.
const S = html`viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`;

// Symboles du sprite, un fragment constant par icône (S : attributs communs, constants).
const SYMBOLS = {
  recherche: html`<symbol id="i-recherche" ${S}><circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path></symbol>`,
  objet: html`<symbol id="i-objet" ${S}><path d="M12 3.5l7.5 4v9L12 20.5l-7.5-4v-9z"></path><path d="M4.5 7.5L12 11.5l7.5-4"></path><path d="M12 11.5v9"></path></symbol>`,
  poste: html`<symbol id="i-poste" ${S}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z"></path><circle cx="12" cy="10" r="2.4"></circle></symbol>`,
  lecteur: html`<symbol id="i-lecteur" ${S}><rect x="6" y="9" width="12" height="11" rx="2.5"></rect><path d="M9.5 6.2a4 4 0 015 0"></path><path d="M7.4 3.9a7 7 0 019.2 0"></path><circle cx="12" cy="14.5" r="1.6"></circle></symbol>`,
  puce: html`<symbol id="i-puce" ${S}><rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect><rect x="9.5" y="9.5" width="5" height="5" rx="1"></rect><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"></path></symbol>`,
  historique: html`<symbol id="i-historique" ${S}><path d="M3.8 12a8.2 8.2 0 102.4-5.8"></path><path d="M3.5 4v4.2h4.2"></path><path d="M12 8v4l2.8 1.8"></path></symbol>`,
  deplace: html`<symbol id="i-deplace" ${S}><path d="M4 8h13"></path><path d="M14 4.5L17.5 8 14 11.5"></path><path d="M20 16H7"></path><path d="M10 12.5L6.5 16l3.5 3.5"></path></symbol>`,
  modifier: html`<symbol id="i-modifier" ${S}><path d="M4.5 19.5l1-4.2L15.8 5a2 2 0 012.8 0l.4.4a2 2 0 010 2.8L8.7 18.5z"></path><path d="M13.5 7.3l3.2 3.2"></path></symbol>`,
  ajouter: html`<symbol id="i-ajouter" ${S}><path d="M12 5v14M5 12h14"></path></symbol>`,
  valide: html`<symbol id="i-valide" ${S}><circle cx="12" cy="12" r="8.5"></circle><path d="M8.3 12.2l2.5 2.5 4.9-5"></path></symbol>`,
  attention: html`<symbol id="i-attention" ${S}><path d="M10.3 4.3L3 17.5A2 2 0 004.7 20.5h14.6a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z"></path><path d="M12 9.5v4.5"></path><path d="M12 17.3v.2"></path></symbol>`,
  chevron: html`<symbol id="i-chevron" ${S}><path d="M9.5 6l6 6-6 6"></path></symbol>`,
  reglages: html`<symbol id="i-reglages" ${S}><path d="M4 7h10M18 7h2M4 17h4M12 17h8"></path><circle cx="16" cy="7" r="2"></circle><circle cx="10" cy="17" r="2"></circle></symbol>`,
  note: html`<symbol id="i-note" ${S}><path d="M6.5 3.5h8l4 4v13h-12z"></path><path d="M14.5 3.5v4h4"></path><path d="M9.5 12.5h5M9.5 16h5"></path></symbol>`,
  supprimer: html`<symbol id="i-supprimer" ${S}><path d="M4.5 7h15"></path><path d="M9.5 7V5a1.5 1.5 0 011.5-1.5h2A1.5 1.5 0 0114.5 5v2"></path><path d="M6.5 7l.8 11.6a2 2 0 002 1.9h5.4a2 2 0 002-1.9L17.5 7"></path><path d="M10 11v5.5M14 11v5.5"></path></symbol>`,
  associer: html`<symbol id="i-associer" ${S}><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"></path></symbol>`,
};

/** Noms d'icônes disponibles (tests). */
export const ICON_NAMES = Object.freeze(Object.keys(SYMBOLS));

/**
 * Icône décorative du sprite. name : nom constant écrit dans les gabarits (jamais une donnée
 * reçue) ; un nom inconnu est une erreur de programmation (exception, donc 500), pas un lien
 * cassé silencieux.
 */
export function icon(name) {
  if (!Object.hasOwn(SYMBOLS, name)) throw new Error(`icône inconnue : ${name}`);
  return html`<svg class="ic" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

// Une icône telle que produite par icon() : seul motif relevé par spriteFor.
const USE_TAG = /<use href="#i-([a-z]+)"><\/use>/g;

/**
 * Sprite à placer en tête d'une page : seulement les symboles que la page utilise (une page
 * d'erreur n'en emporte aucun ; null si la page n'utilise aucune icône). page : fragment déjà produit par html`...`. Les noms sont
 * relevés dans les <use href="#i-..."> du gabarit : une donnée affichée ne peut pas en produire
 * (tout « < » interpolé est échappé), et seuls les noms de SYMBOLS sont retenus.
 */
export function spriteFor(page) {
  const used = new Set([...String(page).matchAll(USE_TAG)].map((m) => m[1]));
  const symbols = ICON_NAMES.filter((name) => used.has(name)).map((name) => html`${SYMBOLS[name]}\n`);
  if (symbols.length === 0) return null; // page sans icône : pas de sprite
  return html`<svg class="sprite" aria-hidden="true">
${symbols}</svg>`;
}
