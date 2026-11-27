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
//      fermeture du menu « … » au clic ailleurs ou sur Échap.
// Les deux premiers interrogent GET /api/recherche (server/web.js, searchApi), sur ce même serveur.
//
// SÉCURITÉ (à l'attention de l'auditeur) :
//   - chargé par <script src="/static/app.js" defer> : aucun script en ligne, aucun attribut
//     on…=, la CSP default-src 'self' est inchangée ;
//   - le DOM est construit UNIQUEMENT avec createElement / createElementNS et textContent : une
//     donnée reçue (nom d'objet, valeur de propriété) n'est jamais interprétée comme du HTML.
//     Aucun usage d'innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, Function
//     ni setTimeout avec une chaîne (contrôlé par test/app-js.test.js) ;
//   - les seules adresses construites sont des chemins fixes du site : /items/<n> et
//     /readers/<n> avec un numéro vérifié entier positif, et /items/new, /, /api/recherche avec
//     une saisie encodée par URLSearchParams (jamais un schéma ni un autre site) ;
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
        all.href = `/?${new URLSearchParams({ q: query })}`;
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
        else if (input.value.trim() !== '') window.location.assign(`/?${new URLSearchParams({ q: input.value.trim() })}`);
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

  // Recherche compacte de la barre supérieure : un clic ou une frappe ouvre la palette (sans
  // script, elle reste un formulaire GET /?q=). Pas sur le focus : sinon, rendre le focus au
  // champ en fermant la palette la rouvrirait aussitôt.
  const barInput = document.querySelector('.recherche-barre input[name="q"]');
  if (barInput) {
    barInput.setAttribute('aria-keyshortcuts', IS_MAC ? 'Meta+K /' : 'Control+K /');
    barInput.addEventListener('click', () => openPalette());
    barInput.addEventListener('input', () => {
      const typed = barInput.value;
      barInput.value = '';
      openPalette(typed);
    });
    if (IS_MAC) {
      const first = document.querySelector('.recherche-barre .raccourci kbd');
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
      clearHref: () => '/',
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
      body: (results, base) => table('tableau-association', ['Objet', 'Puce actuelle', 'Emplacement', 'Action'], results.map((result) => {
        const tr = el('tr');
        const chipCell = el('td');
        chipCell.dataset.label = 'Puce actuelle';
        chipCell.append(result.puce ? el('span', 'uid', String(result.puce)) : el('span', 'texte-doux', 'aucune puce'));
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
  if (inventoryInput && inventoryResults) setupLiveTable(inventoryInput, inventoryResults, 'inventaire', '/');

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
      const first = dialog.querySelector('input[type="radio"], select');
      if (first) first.focus();
    });
    for (const closer of dialog.querySelectorAll('[data-fermer]')) closer.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close(); // clic sur le fond, hors de la boîte
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
})();
