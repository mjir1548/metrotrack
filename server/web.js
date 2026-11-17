// Interface web : connexion, déconnexion, page protégée, feuille de style (étape 3).
// HTML rendu côté serveur, sans JavaScript côté client, sans ressource externe.
//
// ÉCHAPPEMENT : ce module n'a pas encore de fonction d'échappement HTML (prévue à l'étape 4).
// Les seules valeurs variables insérées dans les pages sont donc limitées par construction
// à des caractères sans signification en HTML :
//   - l'identifiant du compte : [A-Za-z0-9._-]{1,64}, vérifié à la création (user-add),
//     par un CHECK en base, et de nouveau juste avant l'affichage ;
//   - les jetons CSRF : base64url ([A-Za-z0-9_-]).
// Aucune donnée saisie par le visiteur n'est réaffichée (pas même l'identifiant tapé).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPassword, DUMMY_HASH, USERNAME_FORMAT } from './password.js';
import {
  SESSION_COOKIE, createSession, findSession, deleteSession, csrfTokenFor, newToken, isTokenFormat, safeEqual,
} from './sessions.js';

// Délai avant la réponse à un échec de connexion (ralentit les essais successifs ; la
// réponse est différée par setTimeout, le serveur n'est pas bloqué).
export const LOGIN_FAILURE_DELAY_MS = 1000;
const LOGIN_CSRF_COOKIE = '__Host-mt_login_csrf';
const LOGIN_CSRF_MAX_AGE_S = 600;
// Plafond du corps d'un formulaire : identifiant + mot de passe (≤ 1 Kio) + jeton tiennent
// largement. Au-delà, on cesse de lire (pas de consommation mémoire à la demande d'un client).
const MAX_FORM_BYTES = 4096;
const GENERIC_LOGIN_ERROR = 'Identifiant ou mot de passe incorrect.';

// Feuille de style lue UNE fois au démarrage et servie depuis la mémoire : aucun chemin de
// fichier n'est dérivé de l'URL (pas de traversée de répertoire possible).
const STYLE_CSS = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'style.css'));

// En-têtes de sécurité sur toutes les réponses de l'interface web.
const SECURITY_HEADERS = {
  // Ressources uniquement depuis ce serveur ; aucun script ni style inline possible ;
  // formulaires uniquement vers ce serveur ; page non intégrable dans un cadre (clickjacking).
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // Le navigateur respecte le Content-Type annoncé (pas de « devinette » de type).
  'X-Content-Type-Options': 'nosniff',
  // « same-origin » et non « no-referrer » : avec no-referrer, les navigateurs envoient
  // « Origin: null » sur un POST de formulaire (spécification Fetch), ce qui ferait échouer la
  // vérification d'Origin ci-dessous. same-origin n'envoie aucun Referer vers un autre site.
  'Referrer-Policy': 'same-origin',
};

// Attributs des cookies : préfixe __Host- (imposé par le navigateur : Secure, Path=/, pas de
// Domain, donc ni un sous-domaine ni une page en clair ne peuvent le poser) ; HttpOnly
// (illisible par du script) ; SameSite=Strict (jamais envoyé sur une requête initiée par un
// autre site). Le cookie de session n'a pas de Max-Age : il disparaît à la fermeture du
// navigateur ; la durée de 8 h est imposée côté serveur.
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const sessionCookie = (token) => `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}`;
const loginCsrfCookie = (token) => `${LOGIN_CSRF_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${LOGIN_CSRF_MAX_AGE_S}`;
const clearCookie = (name) => `${name}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

// Table des routes : chemin exact → méthode → gestionnaire.
const ROUTES = {
  '/': { GET: home },
  '/login': { GET: loginPage, POST: login },
  '/logout': { POST: logout },
  '/static/style.css': { GET: styleSheet },
};

/**
 * Point d'entrée de l'interface web (toute requête qui n'est pas POST /api/frames).
 * @param {{db, log, loginFailureDelayMs: number, guard: Function, fail: Function}} ctx
 *   guard : enveloppe un callback pour capturer ses exceptions ; fail : réponse 500.
 */
export function handleWeb(ctx, path, req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  // Object.hasOwn : un chemin comme « /__proto__ » ou « constructor » ne résout rien d'hérité.
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : null;
  if (!route) return sendStatus(res, 404);
  const handler = Object.hasOwn(route, req.method) ? route[req.method] : null;
  if (!handler) {
    res.setHeader('Allow', Object.keys(route).join(', '));
    return sendStatus(res, 405);
  }
  handler(ctx, req, res);
}

// ---------------------------------------------------------------- gestionnaires

function home(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  sendHtml(res, 200, homeHtml(session));
}

function loginPage(ctx, req, res) {
  if (currentSession(ctx, req)) return redirect(res, '/');
  // Jeton CSRF de connexion (double soumission) : réutilisé s'il est déjà présent et bien
  // formé (plusieurs onglets restent valides), sinon nouveau. Durée de validité renouvelée.
  const existing = readCookies(req).get(LOGIN_CSRF_COOKIE);
  const csrf = isTokenFormat(existing) ? existing : newToken();
  sendHtml(res, 200, loginHtml(csrf, false), [loginCsrfCookie(csrf)]);
}

function login(ctx, req, res) {
  // Adresse lue dès le début : si le client coupe pendant le calcul, req.socket.remoteAddress
  // devient indéfini, et l'adresse disparaîtrait du journal.
  const remote = req.socket.remoteAddress ?? '-';
  if (!originMatchesHost(req)) return forbidden(ctx, res, 'origin', remote);
  readForm(ctx, req, res, (form) => {
    const cookies = readCookies(req);
    const csrfCookie = cookies.get(LOGIN_CSRF_COOKIE);
    // Double soumission : le champ du formulaire doit égaler le cookie __Host- posé par
    // GET /login. Un site tiers ne peut ni lire ni poser ce cookie. isTokenFormat exclut le
    // cas « cookie vide = champ vide ».
    if (!isTokenFormat(csrfCookie) || !safeEqual(form.get('csrf'), csrfCookie)) return forbidden(ctx, res, 'csrf', remote);

    const username = form.get('username') ?? '';
    const password = form.get('password') ?? '';
    // COLLATE NOCASE sur la colonne : identifiant insensible à la casse.
    const user = USERNAME_FORMAT.test(username)
      ? ctx.db.prepare('SELECT id, username, password_hash, active FROM users WHERE username = ?').get(username)
      : undefined;
    const usable = user?.active === 1;
    // Compte inconnu ou désactivé : argon2 est calculé quand même sur une empreinte factice,
    // pour un temps de réponse homogène (pas d'énumération des comptes par le temps).
    // skip : si le client est déjà parti quand vient son tour dans la file, le calcul n'est pas
    // lancé (il ne servirait à rien et retarderait les autres).
    verifyPassword(password, usable ? user.password_hash : DUMMY_HASH, { skip: () => req.socket.destroyed }).then((ok) => {
      if (ok && usable) {
        // Anti-fixation : toujours un NOUVEAU jeton ; l'éventuelle session précédente est supprimée.
        deleteSession(ctx.db, cookies.get(SESSION_COOKIE));
        const token = createSession(ctx.db, user.id);
        ctx.log(`connexion réussie : compte ${user.username} depuis ${remote}`);
        return redirect(res, '/', [sessionCookie(token), clearCookie(LOGIN_CSRF_COOKIE)]);
      }
      // Ni l'identifiant saisi (donnée de l'attaquant, voire mot de passe tapé dans le mauvais
      // champ) ni la cause (compte inconnu, désactivé, mauvais mot de passe) ne sont journalisés.
      ctx.log(`connexion refusée depuis ${remote}`);
      if (req.socket.destroyed) return; // client parti : rien à lui répondre
      setTimeout(ctx.guard(() => {
        // Un seul message générique, quelle que soit la cause ; l'identifiant n'est pas réaffiché.
        sendHtml(res, 401, loginHtml(csrfCookie, true), [loginCsrfCookie(csrfCookie)]);
      }), ctx.loginFailureDelayMs);
    }).catch((err) => {
      // File argon2 pleine (password.js, MAX_PENDING_ARGON2) : refus immédiat, sans calcul.
      if (err.code === 'ARGON2_BUSY') {
        ctx.log(`connexion refusée : file argon2 pleine, depuis ${remote}`);
        return sendStatus(res, 503);
      }
      ctx.fail(err); // chemin asynchrone : toute autre erreur donne un 500, jamais un arrêt
    });
  });
}

function logout(ctx, req, res) {
  const remote = req.socket.remoteAddress ?? '-';
  if (!originMatchesHost(req)) return forbidden(ctx, res, 'origin', remote);
  readForm(ctx, req, res, (form) => {
    const session = currentSession(ctx, req);
    // Sans session valide, aucun jeton CSRF ne peut être valide : 403 comme tout POST non vérifié.
    if (!session || !safeEqual(form.get('csrf'), csrfTokenFor(session.token))) return forbidden(ctx, res, 'csrf', remote);
    deleteSession(ctx.db, session.token); // invalidation côté serveur, pas seulement le cookie
    ctx.log(`déconnexion : compte ${session.username}`);
    redirect(res, '/login', [clearCookie(SESSION_COOKIE)]);
  });
}

function styleSheet(ctx, req, res) {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.writeHead(200);
  res.end(STYLE_CSS);
}

// ---------------------------------------------------------------- requêtes

function currentSession(ctx, req) {
  return findSession(ctx.db, readCookies(req).get(SESSION_COOKIE));
}

/** En-tête Cookie → Map nom → valeur (première occurrence d'un nom). */
function readCookies(req) {
  const cookies = new Map();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

/**
 * CSRF, première barrière : un navigateur joint toujours l'en-tête Origin à un POST, et une
 * page d'un autre site ne peut pas le falsifier. Il doit désigner exactement ce serveur
 * (« https:// » + Host tel que demandé par le navigateur). Origin absent : refus.
 * (Node fusionne des en-têtes Origin multiples en « a, b » : la comparaison échoue alors.)
 */
function originMatchesHost(req) {
  const { origin, host } = req.headers;
  return typeof origin === 'string' && typeof host === 'string' && host !== '' && origin === `https://${host}`;
}

/** Lit un corps application/x-www-form-urlencoded plafonné, puis appelle onForm(URLSearchParams). */
function readForm(ctx, req, res, onForm) {
  const [type, ...params] = (req.headers['content-type'] ?? '').split(';');
  if (type.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return sendStatus(res, 400);
  // Le corps est décodé en UTF-8 : un autre jeu de caractères annoncé est refusé plutôt que
  // mal interprété (un même mot de passe ne doit avoir qu'une seule représentation).
  for (const param of params) {
    const eq = param.indexOf('=');
    const name = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
    if (name !== 'charset') continue;
    const value = eq < 0 ? '' : param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    if (value !== 'utf-8') return sendStatus(res, 400);
  }
  if (Number(req.headers['content-length']) > MAX_FORM_BYTES) return sendStatus(res, 413);
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('error', (err) => ctx.log(`requête interrompue : ${err.message}`));
  req.on('data', ctx.guard((chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_FORM_BYTES) {
      aborted = true;
      req.pause(); // on cesse de lire ; la connexion est fermée après la réponse
      return sendStatus(res, 413);
    }
    chunks.push(chunk);
  }));
  req.on('end', ctx.guard(() => {
    if (aborted) return;
    onForm(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }));
}

// ---------------------------------------------------------------- réponses

function sendHtml(res, status, html, cookies = []) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); // pages avec données de session : jamais en cache
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.writeHead(status);
  res.end(html);
}

// Redirections vers des chemins fixes du site uniquement : aucune cible fournie par le
// client (pas de redirection ouverte).
function redirect(res, location, cookies = []) {
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.writeHead(303);
  res.end();
}

// Réponse d'erreur sans corps ; connexion fermée (le corps de la requête n'a peut-être pas
// été lu, et il ne doit pas l'être).
function sendStatus(res, status) {
  res.setHeader('Connection', 'close');
  res.writeHead(status);
  res.end();
}

// Refus CSRF (cause « origin » ou « csrf »). Le journal ne contient que la cause et l'adresse,
// jamais les valeurs reçues (en-têtes, cookies, champs : données de l'attaquant).
function forbidden(ctx, res, cause, remote) {
  ctx.log(`requête refusée : ${cause}, depuis ${remote}`);
  res.setHeader('Connection', 'close');
  sendHtml(res, 403, cardLayout('Requête refusée', `<h1>Requête refusée</h1>
<p class="sous-titre">La page a peut-être expiré. Rechargez-la puis recommencez.</p>
<a class="bouton" href="/login">Revenir à la connexion</a>`));
}

// ---------------------------------------------------------------- pages
// Gabarits : uniquement du texte constant, plus les valeurs sûres décrites en tête de fichier.
// Aucun attribut style ni balise <style>/<script> : la CSP les bloquerait (tout est dans style.css).

const BRAND = '<span class="marque"><span class="marque-logo" aria-hidden="true">MT</span>MetroTrack</span>';

function document(title, bodyClass, body) {
  return `<!doctype html>
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

// Page hors session (connexion, refus) : une carte centrée.
function cardLayout(title, content) {
  return document(title, 'page-connexion', `<main class="carte">
${BRAND}
${content}
</main>`);
}

function loginHtml(csrf, failed) {
  const error = failed ? `<p class="erreur" role="alert">${GENERIC_LOGIN_ERROR}</p>\n` : '';
  return cardLayout('Connexion', `<h1>Connexion</h1>
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

function homeHtml(session) {
  // Défense en profondeur : l'identifiant est affiché sans échappement, il doit donc
  // respecter le format sûr (sinon exception → 500, rien n'est affiché).
  if (!USERNAME_FORMAT.test(session.username)) throw new Error('identifiant de compte hors format');
  return document('Accueil', 'page-app', `<header class="barre">
<div class="barre-interieur">
${BRAND}
<div class="session">
<span>Connecté en tant que <strong>${session.username}</strong></span>
<form method="post" action="/logout">
<input type="hidden" name="csrf" value="${csrfTokenFor(session.token)}">
<button class="bouton bouton-secondaire" type="submit">Se déconnecter</button>
</form>
</div>
</div>
</header>
<main class="contenu">
<h1>Accueil</h1>
<p class="texte-doux">Vous êtes connecté.</p>
</main>`);
}
