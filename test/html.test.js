// Échappement HTML et gabarit html`...` (server/html.js) : unité.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, html, isSafeHtml } from '../server/html.js';

test('escapeHtml : les cinq caractères spéciaux', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml('<script>alert("x" & \'y\')</script>'),
    '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
});

test('escapeHtml : « & » échappé une seule fois, entités existantes non interprétées', () => {
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('a && b'), 'a &amp;&amp; b');
});

test('escapeHtml : null et undefined → chaîne vide ; nombres et autres valeurs convertis en texte', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(42n), '42');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml({ toString: () => '<b>' }), '&lt;b&gt;');
  assert.equal(escapeHtml('é€😀 texte ordinaire'), 'é€😀 texte ordinaire');
});

test('html : valeur interpolée échappée dans le texte', () => {
  const name = '<script>alert(1)</script>';
  assert.equal(String(html`<p>${name}</p>`), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('html : guillemets dans un attribut, impossible d\'en sortir', () => {
  const value = '" autofocus onfocus="alert(1)';
  const out = String(html`<input value="${value}">`);
  assert.equal(out, '<input value="&quot; autofocus onfocus=&quot;alert(1)">');
  assert.equal(out.match(/"/g).length, 2); // seuls les guillemets du gabarit
  assert.equal(String(html`<a title='${"x' onclick='y"}'>`), '<a title=\'x&#39; onclick=&#39;y\'>');
});

test('html : texte constant du gabarit inchangé (y compris « & » et balises)', () => {
  assert.equal(String(html`<p class="a">R&D</p>`), '<p class="a">R&D</p>');
  assert.equal(String(html``), '');
});

test('html : imbrication sans double échappement', () => {
  const inner = html`<b>${'a & b'}</b>`;
  assert.equal(String(html`<p>${inner}</p>`), '<p><b>a &amp; b</b></p>');
  const deeper = html`<div>${html`<span>${html`<i>${'<x>'}</i>`}</span>`}</div>`;
  assert.equal(String(deeper), '<div><span><i>&lt;x&gt;</i></span></div>');
});

test('html : tableaux de fragments et de valeurs, imbriqués', () => {
  const items = ['<a>', 'b & c'];
  assert.equal(String(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`), '<ul><li>&lt;a&gt;</li><li>b &amp; c</li></ul>');
  assert.equal(String(html`${['<x>', html`<y>`, ['<z>', null]]}`), '&lt;x&gt;<y>&lt;z&gt;');
  assert.equal(String(html`<ul>${[]}</ul>`), '<ul></ul>');
});

test('html : null et undefined n\'affichent rien', () => {
  assert.equal(String(html`<p>${null}${undefined}</p>`), '<p></p>');
  const cond = false;
  assert.equal(String(html`<p>${cond ? html`<b>oui</b>` : null}</p>`), '<p></p>');
});

test('aucune porte de sortie : seul un fragment html`...` est inséré tel quel', async () => {
  // Une chaîne qui « ressemble » à du HTML déjà produit reste échappée.
  const looksSafe = String(html`<b>x</b>`);
  assert.equal(String(html`${looksSafe}`), '&lt;b&gt;x&lt;/b&gt;');
  // Un objet imitant un fragment (même méthode toString) reste échappé.
  assert.equal(String(html`${{ toString: () => '<b>' }}`), '&lt;b&gt;');
  // Le module n'exporte que l'échappement, le gabarit et le test de fragment.
  assert.deepEqual(Object.keys(await import('../server/html.js')).sort(), ['escapeHtml', 'html', 'isSafeHtml']);
});

test('isSafeHtml : vrai seulement pour html`...`', () => {
  assert.ok(isSafeHtml(html`<p></p>`));
  assert.ok(!isSafeHtml('<p></p>'));
  assert.ok(!isSafeHtml(null));
  assert.ok(!isSafeHtml({ toString: () => '<p></p>' }));
});
