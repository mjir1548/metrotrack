// Balise du seul script de l'interface (D-021, étape U2), pour les tests de pages.
// Les contrôles « aucun script » des pages restent en vigueur pour tout le reste : seule cette
// balise exacte, à sa place exacte dans <head> (juste avant </head>, après le logo), est retirée
// avant ces contrôles. Une autre balise <script>, ou celle-ci ailleurs, reste détectée.
export const APP_SCRIPT_TAG = '<script src="/static/app.js" defer></script>';
const IN_HEAD = `<link rel="icon" href="/static/logo.svg" type="image/svg+xml">\n${APP_SCRIPT_TAG}\n</head>`;

/** Page sans la balise du script de l'application (si elle est à sa place dans <head>). */
export function withoutAppScript(html) {
  return html.replace(IN_HEAD, '<link rel="icon" href="/static/logo.svg" type="image/svg+xml">\n</head>');
}
