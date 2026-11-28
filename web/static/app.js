// MetroTrack : le seul fichier JavaScript de l'interface (D-021). Écrit à la main, sans
// dépendance, sans étape de construction.
//
// AMÉLIORATION PROGRESSIVE : chaque page fonctionne sans ce fichier (formulaires classiques,
// GET /?q=). Il ajoute :
//   1. la palette de recherche « Où est… ? », ouverte par Ctrl K (Cmd K sur Mac), par « / »
//      hors d'un champ de saisie, ou par la recherche compacte de la barre supérieure ; les
//      résultats s'affichent pendant la frappe, le premier avec son emplacement en grand ;
//   2. le filtre pendant la frappe du champ de recherche de la page Inventaire ;
//   3. sur la fiche d'un objet (étape U3) : le panneau « Corriger l'emplacement » (<dialog>
//      déjà présent dans la page, même formulaire POST que la page de correction) et la
//      fermeture du menu « … » au clic ailleurs ou sur Échap ;
//   4. le direct (étape U4) : flux GET /api/direct (EventSource), mises à jour de l'accueil,
//      notifications brèves, bandeau de la fiche, puce scannée sur « Donner une puce », et
//      dates relatives recalculées chaque minute ;
//   5. étape U5 : page « Puces inconnues » mise à jour en direct, et création rapide d'une fiche
//      depuis une puce (un nom, puis Entrée : POST /chips/<UID>/new, jeton CSRF de la page) ;
//   6. étape U6 : tuiles des postes à jour en direct, « Renommer » et « Ajouter un poste » sur
//      place, panneaux de confirmation de la fiche d'un lecteur, et attente du premier scan sur
//      la page de clé d'un lecteur.
// Les deux premiers interrogent GET /api/recherche (server/web.js, searchApi), sur ce même
// serveur ; le direct lit GET /api/direct et GET /api/puces-inconnues, sur ce même serveur.
//
// SÉCURITÉ (à l'attention de l'auditeur) :
//   - chargé par <script src="/static/app.js" defer> : aucun script en ligne, aucun attribut
//     on…=, la CSP default-src 'self' est inchangée ;
//   - le DOM est construit UNIQUEMENT avec createElement / createElementNS et textContent : une
//     donnée reçue (nom d'objet, valeur de propriété) n'est jamais interprétée comme du HTML.
//     Aucun usage d'innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, Function
//     ni setTimeout avec une chaîne (contrôlé par test/app-js.test.js) ;
//   - les seules adresses construites sont des chemins fixes du site : /items/<n>, /readers/<n>
//     et /stations/<n> avec un numéro vérifié entier positif, /chips/<UID>/… avec un UID au
//     format strict, et /items/new, /inventaire, /api/… avec une saisie encodée par
//     URLSearchParams (jamais un schéma ni un autre site) ;
//   - aucun appel vers un autre site, aucun stockage dans le navigateur (cookie, localStorage).
'use strict';

(() => {
  const API = '/api/recherche';
  const DEBOUNCE_MS = 120; // attente après la dernière frappe avant d'interroger le serveur
  const SLOW_MS = 300; // au-delà, « Recherche… » s'affiche
  const MAX_QUERY_CHARS = 100; // = MAX_QUERY_CHARS de server/inventory.js
  const NBSP = String.fromCharCode(0xA0); // espace insécable des guillemets français
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  // Le script est actif : la feuille de style peut montrer ce qui en dépend (indice Ctrl K).
  document.documentElement.classList.add('js');

  // ------------------------------------------------------------ outils DOM

  /** Élément HTML avec classe et texte facultatifs (texte posé par textContent). */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Icône décorative du sprite de la page (symbole « i-<nom> », s'il y est). */
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  /** Touche(s) affichée(s) : <kbd><kbd>Ctrl</kbd><kbd>K</kbd></kbd>. */
  function keys(...labels) {
    const outer = el('kbd');
    for (const label of labels) outer.append(el('kbd', '', label));
    return outer;
  }

  const quoted = (text) => `«${NBSP}${text}${NBSP}»`;
  // Nouvelle fiche avec ce nom pré-rempli (chemin fixe, saisie encodée en valeur de paramètre).
  const createItemHref = (name) => `/items/new?${new URLSearchParams({ nom: name })}`;
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const isId = (value) => Number.isSafeInteger(value) && value > 0;

  /** Pastille d'emplacement, comme dans les pages (views.js, locationBadge). */
  function placeBadge(place) {
    const state = ['poste', 'inconnue', 'jamais'].includes(place.etat) ? place.etat : 'jamais';
    const badge = el('span', `etat etat-${state}`, String(place.libelle));
    if (state === 'inconnue' && isId(place.lecteur)) {
      const link = el('a', 'lien-etat');
      link.href = `/readers/${place.lecteur}`;
      link.append(badge);
      return link;
    }
    return badge;
  }

  /** <time> avec la date exacte au survol. */
  function timeTag(arrival, text) {
    const time = el('time', '', text);
    time.dateTime = String(arrival.iso);
    time.title = String(arrival.exacte);
    return time;
  }

  // ------------------------------------------------------------ requêtes

  /**
   * Recherche pendant la frappe : attend DEBOUNCE_MS après la dernière frappe, annule la requête
   * précédente encore en cours (AbortController), puis appelle onResults(query, data), ou
   * onError('session' | 'serveur'). onSlow() si la réponse tarde plus de SLOW_MS.
   * extra : paramètres ajoutés à la requête (tout=1 : page Inventaire ; pour=association).
   */
  function liveSearch({ extra = {}, onSlow, onResults, onError }) {
    let timer = 0;
    let slowTimer = 0;
    let controller = null;
    function cancel() {
      clearTimeout(timer);
      clearTimeout(slowTimer);
      if (controller) controller.abort();
      controller = null;
    }
    function run(query) {
      cancel();
      timer = setTimeout(() => {
        const mine = new AbortController();
        controller = mine;
        slowTimer = setTimeout(() => { if (controller === mine) onSlow(); }, SLOW_MS);
        const params = new URLSearchParams({ ...extra, q: query });
        fetch(`${API}?${params}`, { signal: mine.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
          .then((response) => {
            if (response.status === 401) throw new Error('session');
            if (!response.ok) throw new Error('serveur');
            return response.json();
          })
          .then((data) => {
            if (controller !== mine) return; // une recherche plus récente est partie
            if (!data || !Array.isArray(data.resultats) || !Number.isSafeInteger(data.total)) throw new Error('serveur');
            clearTimeout(slowTimer);
            onResults(query, data);
          })
          .catch((error) => {
            if (controller !== mine || error.name === 'AbortError') return;
            clearTimeout(slowTimer);
            onError(error.message === 'session' ? 'session' : 'serveur');
          });
      }, DEBOUNCE_MS);
    }
    return { run, cancel };
  }

  // Messages d'erreur, sans terme technique.
  const ERRORS = {
    serveur: 'La recherche ne répond pas pour le moment. Réessayez dans un instant.',
    session: 'Votre session a expiré.',
  };

  /** Paragraphe d'erreur (et lien de reconnexion si la session a expiré). */
  function errorMessage(kind) {
    const p = el('p', 'erreur', ERRORS[kind]);
    p.setAttribute('role', 'alert');
    if (kind === 'session') {
      const link = el('a', '', 'Se reconnecter');
      link.href = '/login';
      p.append(NBSP, link);
    }
    return p;
  }

  // ------------------------------------------------------------ palette « Où est… ? »

  let palette = null; // construite à la première ouverture

  function buildPalette() {
    const dialog = el('dialog', 'palette');
    dialog.setAttribute('aria-labelledby', 'palette-titre');
    const box = el('div', 'palette-boite');

    const title = el('h2', 'visuellement-cache', 'Où est cet objet ?');
    title.id = 'palette-titre';

    const field = el('div', 'palette-champ');
    const input = el('input', 'palette-saisie');
    input.type = 'text';
    input.id = 'palette-saisie';
    input.maxLength = MAX_QUERY_CHARS;
    input.placeholder = 'Où est… ?';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', 'palette-liste');
    input.setAttribute('aria-labelledby', 'palette-titre');
    input.setAttribute('aria-describedby', 'palette-astuce');
    const close = el('button', 'palette-fermer');
    close.type = 'button';
    close.append(el('span', 'visuellement-cache', 'Fermer'), keys('Échap'));
    close.lastChild.setAttribute('aria-hidden', 'true');
    field.append(icon('recherche'), input, close);

    // Nombre de résultats, annoncé par les lecteurs d'écran (zone persistante).
    const status = el('p', 'visuellement-cache');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const body = el('div', 'palette-corps');
    const list = el('ul', 'palette-liste');
    list.id = 'palette-liste';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Objets trouvés');
    list.hidden = true;
    const message = el('div', 'palette-message');
    body.append(list, message);

    // Pied d'aide : il suit ce que fait Entrée (ouvrir la fiche, ou créer la fiche s'il n'y a
    // aucun résultat).
    const tips = el('p', 'palette-astuce');
    tips.id = 'palette-astuce';
    function setTips(creating) {
      tips.replaceChildren(...(creating
        ? [keys('Entrée'), ' pour créer la fiche · ', keys('Échap'), ' pour fermer']
        : [keys('↑', '↓'), ' pour choisir · ', keys('Entrée'), ' pour ouvrir la fiche · ', keys('Échap'), ' pour fermer']));
    }
    setTips(false);

    box.append(title, field, status, body, tips);
    dialog.append(box);
    document.body.append(dialog);

    // createHref : adresse de création proposée quand la recherche ne trouve rien (sinon null).
    const state = { dialog, input, list, message, status, results: [], active: -1, query: '', returnFocus: null, createHref: null };

    const search = liveSearch({
      extra: {},
      onSlow: () => showMessage(el('p', 'palette-attente', 'Recherche…')),
      onResults: (query, data) => renderResults(query, data),
      onError: (kind) => {
        clearResults();
        showMessage(errorMessage(kind));
        status.textContent = ERRORS[kind];
      },
    });
    state.search = search;

    function showMessage(...nodes) {
      message.replaceChildren(...nodes);
    }

    function clearResults() {
      state.results = [];
      state.createHref = null;
      setTips(false);
      list.replaceChildren();
      list.hidden = true;
      setActive(-1);
      input.setAttribute('aria-expanded', 'false');
    }

    function setActive(index) {
      state.active = index;
      const options = list.children;
      for (let i = 0; i < options.length; i++) options[i].setAttribute('aria-selected', i === index ? 'true' : 'false');
      if (index >= 0 && options[index]) {
        input.setAttribute('aria-activedescendant', options[index].id);
        options[index].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function idle() {
      clearResults();
      showMessage(el('p', 'palette-invite', 'Tapez le nom d\'un objet, un numéro de série ou quelques caractères du numéro de sa puce.'));
      status.textContent = '';
    }
    state.idle = idle;

    /** Ligne « où la saisie a été trouvée » (propriété ou puce), ou null. */
    function foundLine(found) {
      if (!found || found.type === 'nom') return null;
      const p = el('p', 'palette-trouve');
      if (found.type === 'propriete') {
        p.append(el('span', 'palette-trouve-cle', `${found.cle} :`), ' ', el('span', '', String(found.valeur)));
      } else if (found.type === 'puce') {
        p.append(el('span', 'palette-trouve-cle', 'Puce'), ' ', el('span', 'uid', String(found.puce)));
      }
      return p;
    }

    /** « depuis 4 min » (date exacte au survol), ou rien si l'objet n'a jamais été localisé. */
    function sinceLine(arrival, withSource) {
      const p = el('p', 'palette-depuis');
      if (!arrival) {
        p.textContent = 'Jamais scanné à un poste';
        return p;
      }
      p.append(timeTag(arrival, String(arrival.texte)));
      if (withSource) {
        const manual = arrival.par === 'correction';
        p.append(' ', el('span', manual ? 'badge badge--main' : 'badge badge--ok', manual ? 'Corrigé à la main' : 'Scanné'));
      }
      return p;
    }

    function option(result, index) {
      const li = el('li', index === 0 ? 'palette-option palette-option--vedette' : 'palette-option');
      li.id = `palette-option-${index}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const name = el('p', 'palette-nom', String(result.nom));
      const found = foundLine(result.trouve);
      if (index === 0) {
        const main = el('div', 'palette-vedette-texte');
        main.append(name);
        if (found) main.append(found);
        const place = el('p', 'palette-lieu palette-lieu--grand');
        place.append(placeBadge(result.emplacement)); // l'étiquette visible juste au-dessus suffit (pas de doublon lu)
        main.append(el('p', 'etiquette palette-etiquette', 'Emplacement actuel'), place, sinceLine(result.arrivee, true));
        const open = el('span', 'palette-ouvrir', 'Ouvrir la fiche');
        open.setAttribute('aria-hidden', 'true');
        open.append(' ', keys('Entrée'));
        li.append(main, open);
      } else {
        const left = el('div', 'palette-ligne-objet');
        left.append(name);
        if (found) left.append(found);
        const right = el('div', 'palette-ligne-lieu');
        const place = el('p', 'palette-lieu');
        place.append(el('span', 'visuellement-cache', 'Emplacement : '), placeBadge(result.emplacement));
        right.append(place, sinceLine(result.arrivee, false));
        li.append(left, right);
      }
      return li;
    }

    function renderResults(query, data) {
      state.query = query;
      const results = data.resultats.filter((result) => result && isId(result.id) && result.emplacement);
      state.results = results;
      list.replaceChildren(...results.map(option));
      list.hidden = results.length === 0;
      input.setAttribute('aria-expanded', results.length > 0 ? 'true' : 'false');
      if (results.length === 0) {
        // Aucun résultat : proposer de créer la fiche, avec ce nom pré-rempli (GET /items/new?nom=) ;
        // Entrée fait la même chose.
        state.createHref = createItemHref(query);
        setTips(true);
        const create = el('a', 'bouton bouton-secondaire');
        create.href = state.createHref;
        create.textContent = `Créer la fiche ${quoted(query)}`;
        showMessage(el('p', 'palette-vide', `Aucun objet ne correspond à ${quoted(query)}.`), create);
        status.textContent = `Aucun objet ne correspond à ${quoted(query)}. Entrée pour créer la fiche.`;
        setActive(-1);
        return;
      }
      state.createHref = null;
      setTips(false);
      const more = data.total > results.length;
      if (more) {
        // Plus de résultats que la palette n'en montre : lien vers la liste complète.
        const all = el('a', 'palette-tout', `Voir les ${data.total} objets dans l'inventaire`);
        all.href = `/inventaire?${new URLSearchParams({ q: query })}`;
        showMessage(all);
      } else {
        showMessage();
      }
      status.textContent = `${plural(data.total, 'objet trouvé', 'objets trouvés')}.`;
      setActive(0); // Entrée ouvre aussitôt le meilleur résultat
    }

    function openResult(index) {
      const result = state.results[index];
      if (result && isId(result.id)) window.location.assign(`/items/${result.id}`);
    }

    // Frappe : recherche pendant la frappe ; saisie vide → invitation.
    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (query === '') {
        search.cancel();
        idle();
        return;
      }
      search.run(query);
    });

    // Clavier dans le champ : ↑ ↓ choisissent, Entrée ouvre la fiche choisie (ou, sans
    // résultat affiché, la recherche complète de l'inventaire). Échap : géré par <dialog>.
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      const count = state.results.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (count === 0) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((state.active + step + count) % count);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (state.active >= 0) openResult(state.active);
        else if (state.createHref !== null) window.location.assign(state.createHref);
        else if (input.value.trim() !== '') window.location.assign(`/inventaire?${new URLSearchParams({ q: input.value.trim() })}`);
      }
    });

    // Souris : survol = choix, clic = ouverture (le focus reste dans le champ).
    list.addEventListener('mousemove', (event) => {
      const li = event.target.closest('[role="option"]');
      if (li) {
        const index = [...list.children].indexOf(li);
        if (index !== state.active) setActive(index);
      }
    });
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      if (event.target.closest('a')) return; // pastille « lecteur non affecté » : son propre lien
      const li = event.target.closest('[role="option"]');
      if (li) openResult([...list.children].indexOf(li));
    });

    close.addEventListener('click', () => dialog.close());

    // Clic hors de la boîte (sur le fond assombri) : fermeture. Le clic doit commencer ET finir
    // hors de la boîte (une sélection de texte qui déborde ne ferme pas la palette).
    let downOutside = false;
    dialog.addEventListener('mousedown', (event) => { downOutside = event.target === dialog; });
    dialog.addEventListener('click', (event) => {
      if (downOutside && event.target === dialog) dialog.close();
      downOutside = false;
    });

    // Fermeture (Échap, bouton, clic dehors, navigation) : requête annulée, focus rendu.
    dialog.addEventListener('close', () => {
      search.cancel();
      const back = state.returnFocus;
      state.returnFocus = null;
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    });

    return state;
  }

  /** Ouvre la palette (ou y remet le focus). initial : texte déjà tapé ailleurs. */
  function openPalette(initial) {
    palette ??= buildPalette();
    const { dialog, input } = palette;
    if (!dialog.open) {
      palette.returnFocus = document.activeElement;
      // showModal : le reste de la page devient inerte (focus piégé dans la palette), Échap ferme.
      dialog.showModal();
      if (initial === undefined) input.value = '';
    }
    if (initial !== undefined) input.value = initial;
    input.focus();
    if (initial !== undefined) input.setSelectionRange(input.value.length, input.value.length);
    else input.select();
    const query = input.value.trim();
    if (query === '') palette.idle();
    else palette.search.run(query);
  }

  /** La cible d'une frappe est-elle un champ où « / » doit s'écrire ? */
  function isEditable(target) {
    return target instanceof Element
      && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null);
  }

  // Raccourcis globaux : Ctrl K / Cmd K partout (même dans un champ) ; « / » hors d'un champ.
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
    if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
    } else if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable(event.target)) {
      event.preventDefault();
      openPalette();
    }
  });

  // Recherche compacte de la barre supérieure, et grande recherche de l'accueil (étape U4) : un
  // clic ou une frappe ouvre la palette (sans script, elles restent un formulaire GET
  // /inventaire?q=). Pas sur le focus : sinon, rendre le focus au champ en fermant la palette la
  // rouvrirait aussitôt.
  for (const barInput of document.querySelectorAll('.recherche-barre input[name="q"], #recherche-accueil')) {
    barInput.setAttribute('aria-keyshortcuts', IS_MAC ? 'Meta+K /' : 'Control+K /');
    barInput.addEventListener('click', () => openPalette());
    barInput.addEventListener('input', () => {
      const typed = barInput.value;
      barInput.value = '';
      openPalette(typed);
    });
    if (IS_MAC) {
      const first = barInput.parentElement.querySelector('.raccourci kbd');
      if (first) first.textContent = '⌘';
    }
  }

  // ------------------------------------------------------------ tableaux filtrés pendant la frappe
  //
  // Page Inventaire (#inventaire-resultats) et page « Associer la puce » (#association-resultats) :
  // le champ de recherche remplace le tableau pendant la frappe. Champ vidé : les lignes de départ,
  // gardées en mémoire au chargement, sont remises sans interroger le serveur.

  const ASSOCIATE_PATH = /^\/chips\/[0-9A-F]{8}(?:[0-9A-F]{6}){0,2}\/associate$/; // adresse fixe du formulaire
  const MAX_ASSOCIATE_SHOWN = 50; // = MAX_ASSOCIATE_RESULTS de server/chips.js

  const emptyBox = (...lines) => {
    const box = el('div', 'vide');
    const pictogram = el('span', 'vide-icone');
    pictogram.append(icon('recherche'));
    box.append(pictogram, ...lines);
    return box;
  };

  /** Cellule « Depuis » : « depuis 20 min » (date exacte au survol), ou un tiret. */
  function sinceCell(result) {
    const cell = el('td');
    cell.dataset.label = 'Depuis';
    if (result.arrivee) cell.append(timeTag(result.arrivee, String(result.arrivee.texte)));
    else cell.append(el('span', 'texte-doux', '—'));
    return cell;
  }

  function nameCell(result) {
    const cell = el('td', 'cellule-objet');
    const link = el('a', 'lien-objet', String(result.nom));
    link.href = `/items/${result.id}`;
    cell.append(link);
    return cell;
  }

  function placeCell(result) {
    const cell = el('td');
    cell.dataset.label = 'Emplacement';
    cell.append(placeBadge(result.emplacement));
    return cell;
  }

  function table(className, headers, rows) {
    const tableEl = el('table', `tableau ${className}`);
    const head = el('tr');
    for (const label of headers) {
      const th = el('th', '', label);
      th.scope = 'col';
      head.append(th);
    }
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    tbody.append(...rows);
    tableEl.append(thead, tbody);
    const panel = el('div', 'panneau-tableau');
    panel.append(tableEl);
    return panel;
  }

  // Ce qui change d'une page à l'autre : paramètres de l'API, résumé, lignes, état vide.
  const LIVE_PAGES = {
    inventaire: {
      params: { tout: '1' },
      clearHref: () => '/inventaire',
      summary: (query, total) => (query === '' ? plural(total, 'objet', 'objets') : `${plural(total, 'résultat', 'résultats')} pour ${quoted(query)}`),
      empty: (query) => emptyBox(
        el('p', '', `Aucun objet ne correspond à ${quoted(query)}.`),
        el('p', 'texte-doux', 'Essayez un autre mot du nom ou d\'une propriété, ou quelques caractères du numéro de sa puce.'),
        createLink(query),
      ),
      body: (results) => table('tableau-inventaire', ['Objet', 'Emplacement', 'Depuis'], results.map((result) => {
        const tr = el('tr');
        tr.append(nameCell(result), placeCell(result), sinceCell(result));
        return tr;
      })),
    },
    association: {
      params: { pour: 'association' },
      clearHref: (base) => base,
      summary: (query, total, shown) => {
        const more = total > shown ? ` · les ${shown} premières sont affichées : précisez la recherche.` : '';
        return query === '' ? `${plural(total, 'fiche', 'fiches')}${more}` : `${plural(total, 'résultat', 'résultats')} pour ${quoted(query)}${more}`;
      },
      empty: (query) => emptyBox(
        el('p', '', `Aucune fiche ne correspond à ${quoted(query)}.`),
        el('p', 'texte-doux', 'Essayez un autre mot du nom ou d\'une propriété, ou quelques caractères du numéro de sa puce actuelle.'),
      ),
      body: (results, base) => table('tableau-association', ['Objet', 'Puce', 'Emplacement', 'Action'], results.map((result) => {
        const tr = el('tr');
        const chipCell = el('td');
        chipCell.dataset.label = 'Puce';
        chipCell.append(result.puce === true ? 'a déjà une puce' : el('span', 'texte-doux', 'sans puce'));
        const actionCell = el('td', 'cellule-actions');
        const associate = el('a', 'bouton bouton-secondaire bouton-petit', 'Associer');
        associate.href = `${base}/${result.id}`;
        actionCell.append(associate);
        tr.append(nameCell(result), chipCell, placeCell(result), actionCell);
        return tr;
      })),
    },
  };

  /** Bouton « Créer la fiche « … » » d'une recherche sans résultat (page Inventaire). */
  function createLink(query) {
    const link = el('a', 'bouton bouton-secondaire', `Créer la fiche ${quoted(query)}`);
    link.href = createItemHref(query);
    return link;
  }

  function setupLiveTable(input, container, kind, base) {
    const page = LIVE_PAGES[kind];
    // Résumé (« 3 résultats pour … ») : zone persistante, annoncée à chaque mise à jour.
    let summary = container.querySelector('.resultats');
    if (!summary) {
      summary = el('p', 'resultats');
      container.prepend(summary);
    }
    summary.setAttribute('role', 'status');
    // Instantané de départ (page chargée sans recherche) : remis tel quel quand le champ est vidé.
    const initial = input.value.trim() === ''
      ? { summary: [...summary.childNodes].map((node) => node.cloneNode(true)), body: [...container.childNodes].filter((node) => node !== summary).map((node) => node.cloneNode(true)) }
      : null;

    const replaceBody = (...nodes) => {
      for (const node of [...container.childNodes]) if (node !== summary) node.remove();
      container.append(...nodes);
    };

    function render(query, data) {
      const results = data.resultats.filter((result) => result && isId(result.id) && result.emplacement);
      const text = page.summary(query, data.total, results.length);
      if (query === '') summary.replaceChildren(text);
      else {
        const clear = el('a', '', 'Effacer');
        clear.href = page.clearHref(base);
        summary.replaceChildren(`${text} · `, clear);
      }
      replaceBody(results.length === 0 ? page.empty(query) : page.body(results, base));
    }

    const live = liveSearch({
      extra: page.params,
      onSlow: () => container.setAttribute('aria-busy', 'true'),
      onResults: (query, data) => {
        container.removeAttribute('aria-busy');
        render(query, data);
        // L'adresse suit la recherche : recharger la page ou la partager redonne la même liste.
        window.history.replaceState(null, '', query === '' ? base : `${base}?${new URLSearchParams({ q: query })}`);
      },
      onError: (kind2) => {
        container.removeAttribute('aria-busy');
        summary.replaceChildren(ERRORS[kind2]);
        if (kind2 === 'session') {
          const link = el('a', '', 'Se reconnecter');
          link.href = '/login';
          summary.append(NBSP, link);
        }
      },
    });

    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (query === '' && initial !== null) {
        // Champ vidé : lignes de départ, sans requête.
        live.cancel();
        container.removeAttribute('aria-busy');
        summary.replaceChildren(...initial.summary.map((node) => node.cloneNode(true)));
        replaceBody(...initial.body.map((node) => node.cloneNode(true)));
        window.history.replaceState(null, '', base);
        return;
      }
      live.run(query);
    });
  }

  const inventoryInput = document.querySelector('input#q[aria-controls="inventaire-resultats"]');
  const inventoryResults = document.getElementById('inventaire-resultats');
  if (inventoryInput && inventoryResults) setupLiveTable(inventoryInput, inventoryResults, 'inventaire', '/inventaire');

  const associateInput = document.querySelector('input#q[aria-controls="association-resultats"]');
  const associateResults = document.getElementById('association-resultats');
  const associateBase = associateInput?.form?.getAttribute('action') ?? '';
  if (associateInput && associateResults && ASSOCIATE_PATH.test(associateBase)) {
    setupLiveTable(associateInput, associateResults, 'association', associateBase);
  }

  // ------------------------------------------------------------ « Chercher un objet » (pages introuvables)

  // Lien vers l'inventaire sans script ; avec le script, il ouvre la palette.
  for (const link of document.querySelectorAll('a[data-palette="ouvrir"]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      openPalette();
    });
  }

  // ------------------------------------------------------------ page de clé : « Copier la clé »

  // Bouton ajouté seulement avec le script (sans lui, la clé reste sélectionnable d'un clic).
  // La clé n'est copiée que sur clic, dans le presse-papiers du poste de l'utilisateur, et
  // n'est envoyée nulle part.
  const keyBlock = document.querySelector('pre.cle');
  if (keyBlock && navigator.clipboard) {
    const copy = el('button', 'bouton bouton-secondaire copier-cle', 'Copier la clé');
    copy.type = 'button';
    const done = el('span', 'visuellement-cache');
    done.setAttribute('role', 'status');
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(keyBlock.textContent.trim()).then(() => {
        copy.textContent = 'Copiée ✓';
        done.textContent = 'Clé copiée.';
      }, () => {
        copy.textContent = 'Copie impossible : sélectionnez la clé';
      });
    });
    keyBlock.after(copy, done);
  }

  // ------------------------------------------------------------ fiche d'un objet (étape U3)

  // « Corriger l'emplacement » : sans script, le lien mène à la page de correction ; avec lui,
  // il ouvre le panneau <dialog> déjà présent dans la page (même formulaire POST, jeton CSRF
  // compris). L'enregistrement recharge la fiche par la redirection habituelle du serveur, qui
  // met la nouvelle étape de la frise en évidence. Échap ferme le panneau (natif), comme
  // « Annuler », la croix et un clic sur le fond.
  for (const opener of document.querySelectorAll('a[data-dialogue]')) {
    const dialog = document.getElementById(`dialogue-${opener.dataset.dialogue}`);
    if (!dialog || typeof dialog.showModal !== 'function') continue;
    opener.setAttribute('aria-haspopup', 'dialog');
    opener.addEventListener('click', (event) => {
      event.preventDefault();
      dialog.showModal();
      // Action irréversible : « Annuler » reçoit le focus (data-focus) ; sinon le poste coché.
      const first = ['[data-focus]', 'input[type="radio"]:checked', 'input[type="radio"]', 'select']
        .map((selector) => dialog.querySelector(selector)).find((node) => node !== null);
      if (first) first.focus();
    });
    for (const closer of dialog.querySelectorAll('[data-fermer]')) closer.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close(); // clic sur le fond, hors de la boîte
    });
  }

  // ------------------------------------------------------------ saisie sur place (étape U6)
  //
  // « Renommer » (fiche d'un poste) et « Ajouter un poste » (page Postes) : sans script, le lien
  // mène à la page du formulaire ; avec lui, le petit formulaire caché de la page (même POST, jeton
  // CSRF compris) s'affiche à la place, le champ prêt à la saisie. Échap ou « Annuler » referment.
  for (const opener of document.querySelectorAll('a[data-sur-place]')) {
    const form = document.getElementById(opener.dataset.surPlace);
    if (!form || form.tagName !== 'FORM') continue;
    const title = form.dataset.titre ? document.getElementById(form.dataset.titre) : null;
    const input = form.querySelector('input[name="name"]');
    const initial = input ? input.value : '';
    const show = (on) => {
      form.hidden = !on;
      opener.hidden = on;
      if (title) title.hidden = on;
    };
    const close = () => {
      if (input) input.value = initial;
      show(false);
      opener.focus();
    };
    opener.addEventListener('click', (event) => {
      event.preventDefault();
      show(true);
      if (input) {
        input.focus();
        input.select();
      }
    });
    for (const cancel of form.querySelectorAll('[data-annuler]')) cancel.addEventListener('click', close);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
  }

  // Menu « … » (<details>) : refermé au clic ailleurs et sur Échap (le focus revient au bouton).
  const menus = [...document.querySelectorAll('details.menu')];
  if (menus.length > 0) {
    document.addEventListener('click', (event) => {
      for (const menu of menus) if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      for (const menu of menus) {
        if (!menu.open) continue;
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
  }

  // Après une action (?ok=… : message de confirmation, étape mise en évidence), l'adresse est
  // ramenée à celle de la fiche : recharger la page ne rejoue ni le message ni la mise en évidence.
  if (/^\/items\/[1-9][0-9]*$/.test(window.location.pathname) && new URLSearchParams(window.location.search).has('ok')) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  // ------------------------------------------------------------ dates relatives (étape U4)
  //
  // Les « il y a 4 min » (balises <time data-age>) sont recalculés chaque minute à partir de leur
  // attribut datetime, avec les mêmes règles que formatAge (server/dates.js).

  const AGE_REFRESH_MS = 60_000;
  const MINUTE_MS = 60_000;
  const HOUR_MS = 3_600_000;
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const hourFormat = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const exactText = (ms) => `${dateFormat.format(ms)} à ${hourFormat.format(ms)}`;

  /** Jour de ms par rapport à now : 'aujourdhui', 'hier' ou null. */
  function relativeDay(ms, now) {
    const day = dayKey(new Date(ms));
    const today = new Date(now);
    if (day === dayKey(today)) return 'aujourdhui';
    if (day === dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) return 'hier';
    return null;
  }

  /** « à l'instant », « il y a 4 min », « il y a 3 h », « hier à 17:40 », sinon la date. */
  function ageText(ms, now) {
    const elapsed = now - ms;
    if (elapsed < -MINUTE_MS) return exactText(ms);
    if (elapsed < MINUTE_MS) return 'à l\'instant';
    if (elapsed < HOUR_MS) return `il y a ${Math.floor(elapsed / MINUTE_MS)} min`;
    const day = relativeDay(ms, now);
    if (day === 'aujourdhui') return `il y a ${Math.floor(elapsed / HOUR_MS)} h`;
    if (day === 'hier') return `hier à ${hourFormat.format(ms)}`;
    return exactText(ms);
  }

  /** « aujourd'hui à 16:06 », « hier à 17:40 », sinon la date (formatDay). */
  function dayText(ms, now) {
    const day = relativeDay(ms, now);
    if (day === 'aujourdhui') return `aujourd'hui à ${hourFormat.format(ms)}`;
    if (day === 'hier') return `hier à ${hourFormat.format(ms)}`;
    return exactText(ms);
  }

  function refreshAges() {
    const now = Date.now();
    for (const time of document.querySelectorAll('time[data-age]')) {
      const ms = Date.parse(time.dateTime);
      if (Number.isFinite(ms)) time.textContent = ageText(ms, now);
    }
  }

  /** <time data-age> pour un horodatage reçu (déjà vérifié). */
  function ageTag(iso) {
    const ms = Date.parse(iso);
    const time = el('time', '', ageText(ms, Date.now()));
    time.dateTime = iso;
    time.title = exactText(ms);
    time.dataset.age = '';
    return time;
  }

  // Minuterie en chaîne (setTimeout, jamais de chaîne de code) : une mise à jour par minute.
  (function tick() {
    setTimeout(() => {
      refreshAges();
      tick();
    }, AGE_REFRESH_MS);
  })();

  // ------------------------------------------------------------ direct (étape U4)
  //
  // Pages connectées seulement : un flux GET /api/direct (EventSource, même serveur ; session
  // vérifiée par le serveur). Chaque événement est un petit objet JSON (server/direct.js) :
  // {type, itemId, nom, poste, posteId, lecteur, iso, inconnu, deplacement, par, puces}, jamais
  // de numéro de puce. Quand une puce inconnue arrive, les pages qui en ont besoin (accueil,
  // « Donner une puce », notification) demandent la liste à jour à GET /api/puces-inconnues
  // (même serveur, session), au plus une fois par seconde.
  // Le flux est fermé quand l'onglet est masqué (un navigateur n'ouvre que six connexions par
  // site : des onglets cachés ne doivent pas les occuper), puis rouvert avec ?depuis= : le
  // serveur renvoie les événements manqués.
  //
  // Mises à jour : accueil (mouvement en tête, « À traiter », lecteurs, démarrage guidé),
  // compteur « Puces inconnues » de la barre, fiche de l'objet concerné (rechargée, ou emplacement
  // signalé périmé), « Donner une puce » (la puce scannée apparaît en tête), notifications brèves
  // hors de l'accueil, et indicateur de connexion perdue.

  const DIRECT_API = '/api/direct';
  const CHIPS_API = '/api/puces-inconnues';
  const UID_FORMAT = /^(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/; // = UID_FORMAT de server/inventory.js
  const EVENT_ID = /^[0-9]{1,16}$/;
  const VISIBLE_MOVES = 5; // = HOME_VISIBLE_MOVEMENTS de server/accueil.js
  const MAX_MOVES = 20; // = HOME_MOVEMENTS
  const NAV_CHIPS_CAP = 200; // = NAV_CHIPS_CAP de server/chips.js
  const TOAST_MS = 7000;
  const CHIP_TOAST_MS = 15_000;
  const MAX_TOASTS = 3;
  const FRESH_MS = 120_000; // événement rejoué plus ancien : pas de notification
  const NEW_BADGE_MS = 60_000;
  const OFFLINE_TEXT = 'Connexion perdue : les nouveaux scans s\'afficheront au retour. Reconnexion…';

  const isText = (value) => typeof value === 'string';
  const textOrNull = (value) => value === null || isText(value);
  const countOrNull = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);

  /** Événement reçu bien formé (sinon ignoré). */
  function validEvent(e) {
    return e !== null && typeof e === 'object'
      && ['scan', 'correction', 'puce'].includes(e.type)
      && (e.itemId === null || isId(e.itemId))
      && textOrNull(e.nom) && textOrNull(e.poste) && textOrNull(e.par)
      && (e.posteId === null || isId(e.posteId))
      && (e.de === undefined || e.de === null || isId(e.de))
      && (e.lecteur === null || isId(e.lecteur))
      && isText(e.iso) && Number.isFinite(Date.parse(e.iso))
      && typeof e.inconnu === 'boolean' && typeof e.deplacement === 'boolean'
      && countOrNull(e.puces ?? null)
      && (e.inconnu || e.itemId !== null) && (e.itemId === null || isText(e.nom));
  }

  const appPage = document.body.classList.contains('page-app');
  const itemMatch = /^\/items\/([1-9][0-9]{0,15})(\/puce)?$/.exec(window.location.pathname);
  const currentItem = itemMatch && !itemMatch[2] ? Number(itemMatch[1]) : null;
  const giveChipItem = itemMatch && itemMatch[2] ? Number(itemMatch[1]) : null;
  const moves = document.getElementById('mouvements');
  const movesMore = document.getElementById('mouvements-suite');
  const toDo = document.getElementById('a-traiter');
  const offered = document.getElementById('puces-offertes');
  const liveState = document.getElementById('direct-etat');
  const guideScan = document.getElementById('etape-scan');
  const chipCards = document.getElementById('puces-inconnues'); // page « Puces inconnues » (U5)
  const chipsEmpty = document.getElementById('puces-vide');
  const chipsSummary = document.getElementById('puces-resume');
  const onHome = window.location.pathname === '/';

  // Zone des notifications : créée au chargement (une zone role="status" doit exister avant
  // qu'on y ajoute du texte pour être annoncée).
  let toastBox = null;
  if (appPage) {
    toastBox = el('div', 'toasts');
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }

  /** Bouton-lien d'une notification ou d'une étape. */
  function linkButton(className, href, iconName, text) {
    const link = el('a', className);
    link.href = href;
    if (iconName) link.append(icon(iconName));
    link.append(text);
    return link;
  }

  /** Notification brève : textNodes (texte et liens), actions (boutons-liens) ; disparaît seule. */
  function toast(textNodes, { actions = [], kind = '', duration = TOAST_MS } = {}) {
    if (!toastBox) return;
    const box = el('div', kind === 'puce' ? 'toast toast--puce' : 'toast');
    const text = el('p', 'toast-texte');
    text.append(...textNodes);
    const close = el('button', 'bouton bouton-discret bouton-petit bouton-icone toast-fermer');
    close.type = 'button';
    close.setAttribute('aria-label', 'Fermer la notification');
    close.append(icon('fermer'));
    close.addEventListener('click', () => box.remove());
    const buttons = el('div', 'toast-actions');
    buttons.append(...actions, close);
    box.append(text, buttons);
    toastBox.append(box);
    while (toastBox.children.length > MAX_TOASTS) toastBox.firstElementChild.remove();
    // Survol ou focus : la notification reste le temps de la lire.
    let timer = setTimeout(() => box.remove(), duration);
    const hold = () => clearTimeout(timer);
    const release = () => { timer = setTimeout(() => box.remove(), duration); };
    box.addEventListener('mouseenter', hold);
    box.addEventListener('mouseleave', release);
    box.addEventListener('focusin', hold);
    box.addEventListener('focusout', release);
  }

  /** Lieu d'un événement : lien vers le poste, ou vers le lecteur non affecté. */
  function placeNode(e) {
    if (e.poste !== null && isId(e.posteId)) {
      const link = el('a', 'lien-simple lien-discret', e.poste);
      link.href = `/stations/${e.posteId}`;
      return link;
    }
    if (isId(e.lecteur)) {
      const link = el('a', 'lien-simple lien-discret', 'Lecteur non affecté');
      link.href = `/readers/${e.lecteur}`;
      return link;
    }
    return el('span', '', e.poste ?? 'lecteur non affecté');
  }

  // Lieu en texte, sans préposition (« Nouvelle puce · Réception », jamais « au Réception »).
  const placeText = (e) => e.poste ?? 'lecteur non affecté';

  /** Bandeau en tête de page : texte et lien « Actualiser » (même page). */
  function banner(text, href) {
    const main = document.getElementById('contenu');
    if (!main) return;
    let box = main.querySelector('.bandeau-direct');
    if (!box) {
      box = el('div', 'bandeau-direct');
      box.setAttribute('role', 'status');
      const anchor = main.querySelector('.fil');
      if (anchor) anchor.after(box);
      else main.prepend(box);
    }
    const refresh = el('a', '', 'Actualiser');
    refresh.href = href;
    box.replaceChildren(el('span', '', text), refresh);
  }

  // ---- barre : compteur « Puces inconnues »

  function setNavChips(count) {
    let counter = document.getElementById('nav-puces');
    if (!counter) {
      const link = document.querySelector('.nav a[href="/chips"]');
      if (!link || count === 0) return;
      counter = el('span', 'nombre-pastille nombre-pastille--nav');
      counter.id = 'nav-puces';
      counter.append(el('span', '', ''), el('span', 'visuellement-cache', ' à traiter'));
      counter.firstChild.dataset.nombre = '';
      link.append(' ', counter);
    }
    const number = counter.querySelector('[data-nombre]');
    if (!number) return;
    number.textContent = count > NAV_CHIPS_CAP ? `${NAV_CHIPS_CAP}+` : String(count);
    counter.hidden = count === 0;
  }

  // ---- accueil : derniers mouvements (5 visibles, les suivants derrière « Voir plus »)

  function movementNode(e) {
    const manual = e.type === 'correction';
    const li = el('li', manual ? 'mouvement mouvement--nouveau mouvement--main' : 'mouvement mouvement--nouveau');
    const pictogram = el('span', 'mouvement-icone');
    pictogram.append(icon(manual ? 'main' : 'lecteur'));
    const what = el('div', 'mouvement-objet');
    const name = el('a', '', e.nom);
    name.href = `/items/${e.itemId}`;
    const detail = el('p', 'mouvement-detail');
    const fresh = el('span', 'badge badge--nouveau', 'Nouveau');
    detail.append(fresh);
    if (manual) {
      const badge = el('span', 'badge badge--main');
      badge.append(icon('main'), 'Corrigé à la main');
      detail.append(badge, `par ${e.par ?? 'un compte inconnu'}`);
    }
    what.append(name, detail);
    const where = el('p', 'mouvement-vers');
    const label = el('span');
    label.append(el('span', 'visuellement-cache', 'Déplacé vers '), placeNode(e));
    where.append(icon('poste'), label);
    const when = el('p', 'mouvement-quand');
    const ms = Date.parse(e.iso);
    when.append(ageTag(e.iso), el('small', '', dayText(ms, Date.now())));
    li.append(pictogram, what, where, when);
    setTimeout(() => {
      if (manual) fresh.remove();
      else detail.remove();
      li.classList.remove('mouvement--nouveau');
    }, NEW_BADGE_MS);
    return li;
  }

  function addMovement(e) {
    if (!moves) return;
    moves.prepend(movementNode(e));
    moves.hidden = false;
    document.getElementById('mouvements-vide')?.remove();
    if (moves.children.length > VISIBLE_MOVES && movesMore) {
      movesMore.prepend(moves.lastElementChild);
      document.getElementById('mouvements-plus').hidden = false;
      while (movesMore.children.length > MAX_MOVES - VISIBLE_MOVES) movesMore.lastElementChild.remove();
    }
  }

  // ---- accueil : lecteurs (un lecteur silencieux qui scanne repasse « fonctionne »)

  function readerAlive(e) {
    if (!moves || !isId(e.lecteur)) return;
    const ok = document.getElementById('lecteurs-ok');
    const silent = document.querySelector(`.alerte-lecteur[data-lecteur="${e.lecteur}"]`);
    if (silent && ok) {
      silent.remove();
      const count = (Number(ok.dataset.nombre) || 0) + 1;
      ok.dataset.nombre = String(count);
      const title = ok.querySelector('.etat-ok-titre');
      if (title) title.textContent = count === 1 ? '1 lecteur fonctionne' : `${count} lecteurs fonctionnent`;
      ok.hidden = false;
    }
    const last = document.getElementById('dernier-scan');
    if (last) {
      last.replaceChildren('Dernier scan reçu ', ageTag(e.iso));
      last.hidden = false;
    }
  }

  // ---- accueil : démarrage guidé (étape « Scanner un premier objet »)

  function guideDone(nodes) {
    if (!guideScan) return;
    guideScan.classList.add('etape--faite');
    const check = guideScan.querySelector('.etape-coche');
    if (check) check.replaceChildren(icon('valide'), el('span', 'visuellement-cache', 'Fait : '));
    const body = guideScan.querySelector('.etape-corps');
    const title = guideScan.querySelector('.etape-titre');
    if (body && title) body.replaceChildren(title, ...nodes);
  }

  function guideKnownScan(e) {
    const text = el('p', 'etape-detail');
    const name = el('a', '', e.nom);
    name.href = `/items/${e.itemId}`;
    text.append(name, ` · ${placeText(e)} · `, ageTag(e.iso));
    guideDone([text]);
  }

  function guideChip(chip) {
    const text = el('p', 'etape-detail', 'Nouvelle puce · ');
    text.append(el('strong', '', chip.poste ?? 'lecteur non affecté'), ' · ', ageTag(chip.iso));
    guideDone([text, linkButton('bouton bouton-petit', `/chips/${chip.uid}/new`, 'ajouter', 'Créer sa fiche')]);
  }

  // ---- puces inconnues (accueil « À traiter », « Donner une puce », notifications, démarrage)

  let chipsBusy = false;
  let chipsAgain = false;
  let chipToasts = []; // boutons des notifications, en attente du numéro de la puce

  function validChip(chip) {
    return chip !== null && typeof chip === 'object' && isText(chip.uid) && UID_FORMAT.test(chip.uid)
      && isText(chip.numero) && textOrNull(chip.poste) && isText(chip.iso) && Number.isFinite(Date.parse(chip.iso));
  }

  function chipToDo(chip) {
    const li = el('li', 'encart encart--empile');
    const pictogram = el('span', 'encart-icone');
    pictogram.append(icon('puce'));
    const body = el('div', 'encart-corps');
    const text = el('p', 'encart-texte', 'Nouvelle puce · ');
    text.append(el('strong', '', chip.poste ?? 'lecteur non affecté'));
    const meta = el('p', 'encart-meta');
    meta.append(ageTag(chip.iso));
    body.append(text, meta);
    const buttons = el('div', 'groupe-boutons');
    buttons.append(
      linkButton('bouton bouton-petit', `/chips/${chip.uid}/new`, 'ajouter', 'Créer une fiche'),
      linkButton('bouton bouton-secondaire bouton-petit', `/chips/${chip.uid}/associate`, 'associer', 'Associer à une fiche existante'),
    );
    li.append(pictogram, body, buttons);
    return li;
  }

  function renderToDo(chips, total) {
    const counter = document.getElementById('puces-nombre');
    if (counter) {
      counter.textContent = total.toLocaleString('fr-FR');
      counter.hidden = total === 0;
    }
    if (total === 0) {
      const ok = el('div', 'etat-ok etat-ok--seul');
      const text = el('div');
      text.append(el('p', 'etat-ok-titre', 'Rien à traiter'), el('p', '', 'Chaque puce scannée a sa fiche.'));
      ok.append(icon('valide'), text);
      toDo.replaceChildren(ok);
      return;
    }
    const list = el('ul', 'encart-liste');
    list.append(...chips.map(chipToDo));
    const all = el('p', 'voir-tout');
    const link = el('a', '', total === 1 ? 'Voir la nouvelle puce' : `Voir les ${total.toLocaleString('fr-FR')} nouvelles puces`);
    link.href = '/chips';
    link.append(icon('chevron'));
    all.append(link);
    toDo.replaceChildren(list, all);
    // « À traiter » non vide passe au-dessus des mouvements.
    const section = document.getElementById('traiter');
    const movesSection = document.getElementById('mouvements-section');
    if (section && movesSection && section.nextElementSibling !== movesSection) {
      movesSection.before(section);
      document.getElementById('accueil-grille')?.classList.add('grille-2--seule');
    }
  }

  /** « Donner une puce » : les puces nouvellement scannées en tête, avec « Choisir cette puce ». */
  function offerChips(chips) {
    let added = false;
    for (const chip of [...chips].reverse()) {
      if (offered.querySelector(`li[data-uid="${chip.uid}"]`)) continue;
      const li = el('li', 'encart');
      li.dataset.uid = chip.uid;
      const pictogram = el('span', 'encart-icone');
      pictogram.append(icon('puce'));
      const body = el('div', 'encart-corps');
      const text = el('p', 'encart-texte', 'Puce ');
      text.append(el('span', 'uid', chip.numero));
      const meta = el('p', 'encart-meta');
      meta.append(el('span', 'badge badge--ok', 'Scannée à l\'instant'), ' ', el('span', 'etat etat-poste', chip.poste ?? 'lecteur non affecté'));
      body.append(text, meta);
      const buttons = el('div', 'groupe-boutons');
      // Toujours la page de confirmation (avertissements de remplacement ou de réutilisation).
      buttons.append(linkButton('bouton bouton-petit', `/chips/${chip.uid}/associate/${giveChipItem}?depuis=fiche`, 'associer', 'Choisir cette puce'));
      li.append(pictogram, body, buttons);
      offered.prepend(li);
      added = true;
    }
    if (added) {
      // Un seul bouton principal : celui de la puce la plus récente, en tête.
      for (const button of offered.querySelectorAll('li:not(:first-child) .bouton')) button.classList.add('bouton-secondaire');
      offered.hidden = false;
      for (const box of offered.parentElement.querySelectorAll(':scope > .vide')) box.remove();
    }
  }

  // ---- page « Puces inconnues » (étape U5) : cartes mises à jour en direct, création rapide

  const CHIP_NEW_PATH = /^\/chips\/(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})\/new$/; // adresse fixe du formulaire
  const CREATED_PATH = /^\/items\/([1-9][0-9]{0,15})$/;
  const MAX_CHIPS_PAGE = 200; // = MAX_UNKNOWN_CHIPS de server/chips.js
  const MAX_NAME_CHARS = 200; // = MAX_NAME_CHARS de server/items.js
  let chipsTotal = chipCards ? chipCards.children.length : 0;

  const newChipsText = (n) => (n > 1 ? `${n.toLocaleString('fr-FR')} nouvelles puces` : `${n} nouvelle puce`);
  const scansText = (n) => (Number.isSafeInteger(n) && n > 1 ? `${n.toLocaleString('fr-FR')} scans · dernier ` : '');

  /** Résumé (« 3 nouvelles puces ») et passage liste / état vide. */
  function updateChipsState() {
    const shown = chipCards.children.length;
    chipCards.hidden = shown === 0;
    if (chipsEmpty) chipsEmpty.hidden = shown > 0;
    if (chipsSummary) {
      chipsSummary.hidden = shown === 0;
      chipsSummary.textContent = chipsTotal > shown
        ? `Plus de ${newChipsText(shown)} · les ${shown} plus récentes sont affichées. Traitez-les pour voir les suivantes.`
        : newChipsText(shown);
    }
  }

  /** Message sous le champ de création rapide (erreur), ou rien. */
  function quickError(form, text, withLogin = false) {
    let message = form.querySelector('.erreur-champ');
    if (!text) {
      message?.remove();
      return;
    }
    if (!message) {
      message = el('p', 'erreur-champ');
      message.setAttribute('role', 'alert');
      form.append(message);
    }
    message.replaceChildren(text);
    if (withLogin) {
      const link = el('a', '', 'Se reconnecter');
      link.href = '/login';
      message.append(NBSP, link);
    }
  }

  /**
   * Création rapide : un petit formulaire (un nom, puis Entrée) remplace le lien « Créer une
   * fiche » de la carte. Même adresse et mêmes champs que la page /chips/<UID>/new : le nom et le
   * jeton CSRF de la page (champ du formulaire de déconnexion, déjà présent).
   */
  function enableQuickCreate(card) {
    const uid = card.dataset.uid;
    if (!UID_FORMAT.test(uid ?? '') || card.querySelector('form.creation-rapide')) return;
    const form = el('form', 'creation-rapide');
    form.method = 'post';
    form.setAttribute('action', `/chips/${uid}/new`);
    const csrf = el('input');
    csrf.type = 'hidden';
    csrf.name = 'csrf';
    csrf.value = document.querySelector('input[name="csrf"]')?.value ?? '';
    const label = el('label', 'visuellement-cache', 'Nom de l\'objet');
    label.htmlFor = `nom-${uid}`;
    const input = el('input');
    input.id = `nom-${uid}`;
    input.name = 'name';
    input.maxLength = MAX_NAME_CHARS;
    input.required = true;
    input.autocomplete = 'off';
    input.placeholder = 'Nom de l\'objet, puis Entrée';
    const submit = el('button', 'bouton bouton-petit');
    submit.type = 'submit';
    submit.append(icon('ajouter'), 'Créer la fiche');
    const more = el('a', 'lien-simple creation-complete', 'Plus de champs');
    more.href = `/chips/${uid}/new`;
    form.append(csrf, label, input, submit, more);
    card.append(form);
    const link = card.querySelector('.puce-creer');
    if (link) link.hidden = true;
  }

  /**
   * Envoi de la création rapide : même POST que la page /chips/<UID>/new (champs du formulaire,
   * jeton CSRF compris ; le navigateur joint l'en-tête Origin). Le serveur répond par une
   * redirection vers la fiche créée, suivie par fetch : son adresse donne le numéro de la fiche.
   */
  function quickCreate(form) {
    const card = form.closest('li');
    const action = form.getAttribute('action') ?? '';
    const input = form.querySelector('input[name="name"]');
    const button = form.querySelector('button[type="submit"]');
    if (!card || !input || !button || !CHIP_NEW_PATH.test(action) || button.disabled) return;
    const name = input.value.trim();
    if (name === '') {
      quickError(form, 'Tapez le nom de l\'objet, puis Entrée.');
      input.focus();
      return;
    }
    quickError(form, '');
    button.disabled = true;
    fetch(action, { method: 'POST', body: new URLSearchParams(new FormData(form)), cache: 'no-store', headers: { Accept: 'text/html' } })
      .then((response) => {
        const path = new URL(response.url, window.location.href).pathname;
        const created = CREATED_PATH.exec(path);
        if (response.ok && response.redirected && created) {
          quickCreated(card, Number(created[1]), name);
        } else if (path === '/login') {
          quickError(form, 'Votre session a expiré.', true);
        } else if (response.status === 409 || response.status === 404) {
          quickError(form, 'Cette puce vient d\'être traitée depuis un autre écran.');
          refreshChips();
        } else if (response.status === 403) {
          quickError(form, 'La page a expiré : rechargez-la, puis recommencez.');
        } else {
          quickError(form, 'La fiche n\'a pas été créée. Essayez « Plus de champs ».');
        }
      })
      .catch(() => quickError(form, 'La fiche n\'a pas été créée : la connexion a été perdue. Réessayez.'))
      .finally(() => { button.disabled = false; });
  }

  /** Fiche créée : la carte disparaît, une notification la nomme, le curseur passe à la suivante. */
  function quickCreated(card, id, name) {
    const place = card.dataset.poste || 'lecteur non affecté';
    const next = card.nextElementSibling ?? card.previousElementSibling;
    card.remove();
    chipsTotal = Math.max(0, chipsTotal - 1);
    updateChipsState();
    const nextInput = next?.querySelector('form.creation-rapide input[name="name"]');
    if (nextInput) nextInput.focus();
    const link = el('a', '', name);
    link.href = `/items/${id}`;
    toast([link, ` créé · ${place}`], { actions: [linkButton('bouton bouton-secondaire bouton-petit', `/items/${id}`, null, 'Ouvrir la fiche')] });
  }

  /** Carte d'une puce reçue en direct (même structure que views.js, chipCard). */
  function chipCardNode(chip) {
    const li = el('li', 'encart puce-carte');
    li.dataset.uid = chip.uid;
    li.dataset.poste = chip.poste ?? 'lecteur non affecté';
    const pictogram = el('span', 'encart-icone');
    pictogram.append(icon('puce'));
    const body = el('div', 'encart-corps');
    const text = el('p', 'encart-texte', 'Nouvelle puce · ');
    text.append(el('strong', '', chip.poste ?? 'lecteur non affecté'));
    const meta = el('p', 'encart-meta');
    const count = el('span', '', scansText(chip.scans));
    count.dataset.scans = '';
    const number = el('span', 'puce-numero', `N°${NBSP}`);
    number.append(el('span', 'uid', chip.numero));
    meta.append(count, ageTag(chip.iso), number);
    body.append(text, meta);
    const buttons = el('div', 'groupe-boutons puce-actions');
    const create = linkButton('bouton bouton-petit puce-creer', `/chips/${chip.uid}/new`, 'ajouter', 'Créer une fiche');
    buttons.append(create, linkButton('bouton bouton-secondaire bouton-petit', `/chips/${chip.uid}/associate`, 'associer', 'Associer à une fiche existante'));
    li.append(pictogram, body, buttons);
    if (Date.now() - Date.parse(chip.iso) < FRESH_MS) {
      li.classList.add('puce-carte--nouvelle');
      const fresh = el('span', 'badge badge--nouveau', 'Nouveau');
      text.append(' ', fresh);
      setTimeout(() => {
        fresh.remove();
        li.classList.remove('puce-carte--nouvelle');
      }, NEW_BADGE_MS);
    }
    enableQuickCreate(li);
    return li;
  }

  /**
   * Liste à jour (GET /api/puces-inconnues) : les puces traitées ailleurs disparaissent, les
   * nouvelles sont insérées à leur rang (la plus récente en tête). Les cartes déjà là ne sont
   * pas reconstruites : une saisie en cours dans leur champ est conservée.
   */
  function reconcileChips(chips, total) {
    const wanted = new Set(chips.map((chip) => chip.uid));
    const cards = new Map();
    for (const card of [...chipCards.children]) {
      if (!wanted.has(card.dataset.uid)) card.remove();
      else cards.set(card.dataset.uid, card);
    }
    let after = null; // carte précédente dans l'ordre du serveur
    for (const chip of chips) {
      let card = cards.get(chip.uid);
      if (card) {
        const count = card.querySelector('[data-scans]');
        if (count) count.textContent = scansText(chip.scans);
        const time = card.querySelector('.encart-meta time');
        if (time) time.replaceWith(ageTag(chip.iso));
      } else {
        card = chipCardNode(chip);
        if (after) after.after(card);
        else chipCards.prepend(card);
      }
      after = card;
    }
    chipsTotal = total;
    updateChipsState();
  }

  if (chipCards) {
    for (const card of chipCards.children) enableQuickCreate(card);
    chipCards.addEventListener('submit', (event) => {
      const form = event.target.closest('form.creation-rapide');
      if (!form) return;
      event.preventDefault();
      quickCreate(form);
    });
    if (chipCards.dataset.plus === '1') chipsTotal = MAX_CHIPS_PAGE + 1;
  }

  function applyChips(data) {
    const chips = data.puces.filter(validChip);
    setNavChips(data.total);
    if (chipCards) reconcileChips(chips.slice(0, MAX_CHIPS_PAGE), data.total);
    if (toDo) renderToDo(chips.slice(0, 3), data.total);
    if (offered && giveChipItem !== null) offerChips(chips);
    const first = chips[0];
    if (first) {
      if (guideScan && !guideScan.classList.contains('etape--faite')) guideChip(first);
      for (const { create, associate } of chipToasts) {
        create.href = `/chips/${first.uid}/new`;
        associate.href = `/chips/${first.uid}/associate`;
      }
    }
    chipToasts = [];
  }

  /** Liste à jour des puces inconnues : une requête à la fois, au plus une par seconde. */
  function refreshChips() {
    if (chipsBusy) {
      chipsAgain = true;
      return;
    }
    chipsBusy = true;
    let wanted = 3;
    if (chipCards) wanted = MAX_CHIPS_PAGE;
    else if (offered) wanted = 20; // = MAX_OFFERED_CHIPS de server/chips.js
    fetch(`${CHIPS_API}?${new URLSearchParams({ n: String(wanted) })}`, { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.puces) && Number.isSafeInteger(data.total)) applyChips(data);
      })
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          chipsBusy = false;
          if (chipsAgain) {
            chipsAgain = false;
            refreshChips();
          }
        }, 1000);
      });
  }

  // ---- fiche de l'objet concerné : elle ne doit jamais contredire le direct

  /** Rien n'est en cours sur la page (panneau, menu, palette, saisie) : on peut la recharger. */
  function pageIdle() {
    if (document.querySelector('dialog[open], details.menu[open]')) return false;
    return !isEditable(document.activeElement);
  }

  /**
   * L'objet affiché vient de changer : la fiche est rechargée (à la même position) si rien n'est
   * en cours ; sinon l'emplacement affiché est grisé, avec le nouvel emplacement et « Actualiser ».
   */
  function itemChanged(e) {
    const href = `/items/${currentItem}`;
    if (pageIdle()) {
      window.history.replaceState({ defilement: window.scrollY }, '');
      window.location.reload();
      return;
    }
    const head = document.querySelector('.fiche-entete');
    if (!head) return;
    for (const node of head.querySelectorAll('.emplacement, .localisation-detail')) node.classList.add('emplacement--perime');
    let note = head.querySelector('.emplacement-nouveau');
    if (!note) {
      note = el('p', 'emplacement-nouveau');
      note.setAttribute('role', 'status');
      const anchor = head.querySelector('.localisation-detail') ?? head.querySelector('.emplacement');
      if (anchor) anchor.after(note);
      else head.append(note);
    }
    const refresh = el('a', '', 'Actualiser');
    refresh.href = href;
    let text = 'La puce de cet objet a changé';
    if (e.type === 'scan') text = e.deplacement ? `Nouvel emplacement : ${placeText(e)} (à l'instant)` : `Scanné à l'instant : ${placeText(e)}`;
    else if (e.type === 'correction') text = `Nouvel emplacement : ${placeText(e)} (corrigé à la main${e.par ? ` par ${e.par}` : ''})`;
    note.replaceChildren(icon('poste'), el('span', '', `${text} · `), refresh);
  }

  // Après un rechargement automatique : même position dans la page.
  if (currentItem !== null && Number.isFinite(window.history.state?.defilement)) {
    window.scrollTo(0, window.history.state.defilement);
    window.history.replaceState(null, '');
  }

  // ---- indicateur de connexion (accueil : à côté des mouvements ; fiche et « Donner une
  // puce » : en tête de page)

  let offlineBox = null;
  if (appPage && !liveState && (currentItem !== null || giveChipItem !== null)) {
    offlineBox = el('p', 'direct-coupure');
    offlineBox.setAttribute('role', 'status');
    offlineBox.hidden = true;
    const main = document.getElementById('contenu');
    const anchor = main?.querySelector('.fil');
    if (anchor) anchor.after(offlineBox);
    else main?.prepend(offlineBox);
  }

  function setLive(on) {
    if (liveState) {
      liveState.hidden = false;
      liveState.classList.toggle('direct-etat--coupe', !on);
      const text = liveState.querySelector('.direct-texte');
      if (text) text.textContent = on ? 'En direct' : OFFLINE_TEXT;
    }
    if (offlineBox) {
      offlineBox.hidden = on;
      if (on) offlineBox.replaceChildren();
      else offlineBox.replaceChildren(icon('attention'), el('span', '', OFFLINE_TEXT));
    }
  }

  // ---- page Postes (étape U6) : nombre d'objets, dernier arrivé et état du lecteur de chaque tuile

  const tiles = document.getElementById('tuiles-postes');
  const tileOf = (id) => (isId(id) && tiles ? tiles.querySelector(`li[data-poste="${id}"]`) : null);

  /** « 38 objets présents », « 1 objet présent », « 0 objet présent » (comme views.js, presentCount). */
  function setTileCount(tile, delta) {
    const line = tile.querySelector('.tuile-nombre');
    const strong = line?.querySelector('[data-nombre]');
    if (!line || !strong) return;
    const before = Number(strong.textContent.replace(/[^0-9]/g, '')) || 0;
    const n = Math.max(0, before + delta);
    const count = el('strong', '', n.toLocaleString('fr-FR'));
    count.dataset.nombre = '';
    line.replaceChildren(count, ' ', el('span', '', n > 1 ? 'objets présents' : 'objet présent'));
  }

  /** Ligne « dernier mouvement » d'une tuile : « Multimètre arrivé à l'instant » (ou « parti »). */
  function setTileLast(tile, e, verb) {
    const line = tile.querySelector('.tuile-dernier');
    if (!line) return;
    const name = el('a', 'tuile-lien', e.nom);
    name.href = `/items/${e.itemId}`;
    line.dataset.objet = String(e.itemId);
    line.replaceChildren(name, ` ${verb} `, ageTag(e.iso));
  }

  /** Un scan est arrivé de ce lecteur : s'il était le dernier silencieux du poste, « Lecteur OK ». */
  function tileReaderAlive(tile, e) {
    const line = tile.querySelector('.tuile-lecteur');
    if (!line) return;
    const silent = (line.dataset.silencieux ?? '').split(' ').filter((id) => id !== '' && id !== String(e.lecteur));
    line.dataset.silencieux = silent.join(' ');
    if (silent.length > 0) return;
    line.className = 'tuile-lecteur tuile-lecteur--ok';
    const text = el('span', '', 'Lecteur OK · dernier scan ');
    text.append(ageTag(e.iso));
    line.replaceChildren(icon('valide'), text);
  }

  function updateTiles(e) {
    if (e.type === 'scan' && isId(e.posteId)) {
      const tile = tileOf(e.posteId);
      if (tile) tileReaderAlive(tile, e);
    }
    if (e.itemId === null || (e.de ?? null) === (e.posteId ?? null)) return;
    const from = tileOf(e.de);
    if (from) {
      setTileCount(from, -1);
      const last = from.querySelector('.tuile-dernier');
      if (last && last.dataset.objet === String(e.itemId)) setTileLast(from, e, `parti vers ${placeText(e)}`);
    }
    const to = tileOf(e.posteId);
    if (to) {
      setTileCount(to, 1);
      setTileLast(to, e, 'arrivé');
      to.classList.remove('tuile--nouvelle');
      void to.offsetWidth; // relance l'animation de mise en évidence
      to.classList.add('tuile--nouvelle');
    }
  }

  // ---- page de clé (étape U6) : « En attente du premier scan de ce lecteur… »

  const waiting = document.getElementById('attente-lecteur');
  const waitingId = waiting ? Number(waiting.dataset.lecteur) : null;
  if (waiting && isId(waitingId) && typeof EventSource === 'function') {
    waiting.hidden = false;
    for (const hint of document.querySelectorAll('.sans-script')) hint.hidden = true;
  }

  function readerFirstScan(e) {
    if (!waiting || e.type !== 'scan' || e.lecteur !== waitingId || waiting.classList.contains('attente-lecteur--ok')) return;
    waiting.classList.add('attente-lecteur--ok');
    waiting.replaceChildren(icon('valide'), el('span', '', `Ce lecteur fonctionne : premier scan reçu (${placeText(e)})`));
  }

  // ---- un événement

  function handleEvent(e) {
    if (tiles) updateTiles(e);
    readerFirstScan(e);
    const recent = Date.now() - Date.parse(e.iso) < FRESH_MS;
    const move = (e.type === 'scan' && !e.inconnu && e.deplacement) || e.type === 'correction';
    if (Number.isSafeInteger(e.puces)) setNavChips(e.puces);
    if (e.type === 'scan') readerAlive(e);
    if (move) addMovement(e);
    if (guideScan && e.type === 'scan' && !e.inconnu) guideKnownScan(e);
    if ((e.inconnu || e.type === 'puce') && (toDo || offered || guideScan || chipCards)) refreshChips();

    if (currentItem !== null && e.itemId === currentItem) {
      itemChanged(e);
      return;
    }
    // Accueil : la ligne « Nouveau » et « À traiter » suffisent, pas de notification.
    if (!recent || onHome) return;
    if (e.type === 'scan' && e.inconnu && giveChipItem === null && !chipCards) {
      // Liens vers la liste tant que le numéro n'est pas connu, puis vers la puce elle-même.
      const create = linkButton('bouton bouton-petit', '/chips', null, 'Créer une fiche');
      const associate = linkButton('bouton bouton-secondaire bouton-petit', '/chips', null, 'Associer');
      chipToasts.push({ create, associate });
      refreshChips();
      toast([`Nouvelle puce · ${placeText(e)}`], { actions: [create, associate], kind: 'puce', duration: CHIP_TOAST_MS });
    } else if (move) {
      const name = el('a', '', e.nom);
      name.href = `/items/${e.itemId}`;
      toast([name, ` déplacé vers ${placeText(e)}${e.type === 'correction' ? ' (corrigé à la main)' : ''}`]);
    }
  }

  // ---- connexion

  let source = null;
  let lastId = null;
  let retryTimer = 0;
  let retryDelay = 3000;

  function connect() {
    if (source !== null || document.hidden) return;
    clearTimeout(retryTimer);
    const stream = new EventSource(lastId === null ? DIRECT_API : `${DIRECT_API}?${new URLSearchParams({ depuis: lastId })}`);
    source = stream;
    stream.addEventListener('open', () => {
      retryDelay = 3000;
      setLive(true);
    });
    stream.addEventListener('message', (message) => {
      if (EVENT_ID.test(message.lastEventId)) lastId = message.lastEventId;
      let data = null;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (validEvent(data)) handleEvent(data);
    });
    // Événements manqués au-delà de ce que le serveur garde : la page propose d'actualiser.
    stream.addEventListener('resynchro', () => {
      if (chipCards) refreshChips(); // la liste complète est relue : rien n'est manqué
      else if (moves || guideScan) banner('Des scans ont pu avoir lieu pendant la coupure.', '/');
      else if (currentItem !== null) banner('La fiche a pu changer pendant la coupure.', `/items/${currentItem}`);
    });
    stream.addEventListener('error', () => {
      setLive(false);
      // Refus du serveur (session expirée, plafond atteint) : EventSource abandonne ; nouvel
      // essai ici, de plus en plus espacé. Coupure réseau : EventSource réessaie seul.
      if (stream.readyState === EventSource.CLOSED && source === stream) {
        source = null;
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      }
    });
  }

  function disconnect() {
    clearTimeout(retryTimer);
    if (source !== null) {
      source.close();
      source = null;
    }
  }

  if (appPage && typeof EventSource === 'function') {
    connect();
    document.addEventListener('visibilitychange', () => {
      // Page de clé en attente du premier scan : le flux reste ouvert onglet caché (on configure
      // souvent le boîtier dans une autre fenêtre), pour ne pas manquer ce scan.
      if (document.hidden && waiting && !waiting.hidden && !waiting.classList.contains('attente-lecteur--ok')) return;
      if (document.hidden) {
        disconnect();
      } else {
        refreshAges();
        connect();
        if (chipCards) refreshChips(); // puces arrivées ou traitées pendant que l'onglet était caché
      }
    });
    window.addEventListener('pagehide', disconnect);
  }
})();
