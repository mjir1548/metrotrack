// Affichage des dates (server/dates.js) : ancienneté et date complète, fuseau explicite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, formatDateTime } from '../server/dates.js';

const PARIS = 'Europe/Paris';
const MIN = 60_000;
// 17 nov. 2026, 16:00 à Paris (UTC+1 en novembre).
const NOW = Date.parse('2026-11-17T15:00:00.000Z');
const ago = (ms, now = NOW) => new Date(now - ms).toISOString();

test('formatDateTime : « 12 nov. 2026 à 09:48 » dans le fuseau demandé', () => {
  assert.equal(formatDateTime('2026-11-12T08:48:00.000Z', PARIS), '12 nov. 2026 à 09:48');
  assert.equal(formatDateTime('2026-11-12T08:48:00.000Z', 'UTC'), '12 nov. 2026 à 08:48');
  assert.equal(formatDateTime('2026-07-01T05:03:00.000Z', PARIS), '1 juil. 2026 à 07:03'); // heure d'été UTC+2
  assert.equal(formatDateTime('pas une date', PARIS), 'date inconnue');
});

test('formatAge : moins d\'une minute → « à l\'instant »', () => {
  assert.equal(formatAge(ago(0), NOW, PARIS), 'à l\'instant');
  assert.equal(formatAge(ago(30_000), NOW, PARIS), 'à l\'instant');
  assert.equal(formatAge(ago(MIN - 1), NOW, PARIS), 'à l\'instant');
});

test('formatAge : minutes', () => {
  assert.equal(formatAge(ago(MIN), NOW, PARIS), 'il y a 1 min');
  assert.equal(formatAge(ago(2 * MIN + 59_000), NOW, PARIS), 'il y a 2 min');
  assert.equal(formatAge(ago(59 * MIN), NOW, PARIS), 'il y a 59 min');
});

test('formatAge : heures, même jour', () => {
  assert.equal(formatAge(ago(60 * MIN), NOW, PARIS), 'il y a 1 h');
  assert.equal(formatAge(ago(3 * 60 * MIN + 10 * MIN), NOW, PARIS), 'il y a 3 h');
  // 00:30 à Paris le même jour : 15 h 30 plus tôt.
  assert.equal(formatAge('2026-11-16T23:30:00.000Z', NOW, PARIS), 'il y a 15 h');
});

test('formatAge : veille → « hier à HH:MM »', () => {
  assert.equal(formatAge('2026-11-16T16:40:00.000Z', NOW, PARIS), 'hier à 17:40');
  assert.equal(formatAge('2026-11-16T22:59:00.000Z', NOW, PARIS), 'hier à 23:59');
  assert.equal(formatAge('2026-11-15T23:00:00.000Z', NOW, PARIS), 'hier à 00:00');
});

test('formatAge : avant-hier et plus ancien → date complète', () => {
  assert.equal(formatAge('2026-11-15T22:59:00.000Z', NOW, PARIS), '15 nov. 2026 à 23:59');
  assert.equal(formatAge('2026-11-12T08:48:00.000Z', NOW, PARIS), '12 nov. 2026 à 09:48');
  assert.equal(formatAge('2025-01-02T08:00:00.000Z', NOW, PARIS), '2 janv. 2025 à 09:00');
});

test('formatAge : autour de minuit, l\'écart en minutes prime, puis la veille', () => {
  const now = Date.parse('2026-11-17T23:10:00.000Z'); // 00:10 le 18 à Paris
  assert.equal(formatAge('2026-11-17T22:50:00.000Z', now, PARIS), 'il y a 20 min'); // 23:50 la veille
  assert.equal(formatAge('2026-11-17T21:00:00.000Z', now, PARIS), 'hier à 22:00');
});

test('formatAge : changement d\'année', () => {
  const now = Date.parse('2027-01-01T09:00:00.000Z'); // 10:00 le 1er janvier à Paris
  assert.equal(formatAge('2026-12-31T16:40:00.000Z', now, PARIS), 'hier à 17:40');
  assert.equal(formatAge('2026-12-30T16:40:00.000Z', now, PARIS), '30 déc. 2026 à 17:40');
});

test('formatAge : passage à l\'heure d\'été (journée de 23 h), « hier » reste la veille calendaire', () => {
  // 29 mars 2026 : passage à l'heure d'été à Paris. now = 00:30 le 30 (UTC+2).
  const now = Date.parse('2026-03-29T22:30:00.000Z');
  assert.equal(formatAge('2026-03-29T08:00:00.000Z', now, PARIS), 'hier à 10:00');
  // 23:30 le 28 (UTC+1), exactement 24 h plus tôt : avant-hier, pas « hier ».
  assert.equal(formatAge('2026-03-28T22:30:00.000Z', now, PARIS), '28 mars 2026 à 23:30');
});

test('formatAge : le fuseau change le jour calendaire', () => {
  const now = Date.parse('2026-11-17T23:30:00.000Z'); // 18 nov. à Paris, encore le 17 en UTC
  const at = '2026-11-17T20:00:00.000Z';
  assert.equal(formatAge(at, now, 'UTC'), 'il y a 3 h');
  assert.equal(formatAge(at, now, PARIS), 'hier à 21:00');
});

test('formatAge : horodatage dans le futur (horloge déréglée) et horodatage illisible', () => {
  assert.equal(formatAge(new Date(NOW + 30_000).toISOString(), NOW, PARIS), 'à l\'instant');
  assert.equal(formatAge('2026-11-17T17:00:00.000Z', NOW, PARIS), '17 nov. 2026 à 18:00');
  assert.equal(formatAge('', NOW, PARIS), 'date inconnue');
  assert.equal(formatAge(null, NOW, PARIS), 'date inconnue');
});

test('formatAge et formatDateTime : fuseau du serveur par défaut', () => {
  const iso = '2026-11-12T08:48:00.000Z';
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.equal(formatDateTime(iso), formatDateTime(iso, zone));
  assert.equal(formatAge(iso, NOW), formatAge(iso, NOW, zone));
});
