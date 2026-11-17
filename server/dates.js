// Affichage des dates en français : ancienneté (« il y a 3 h », « hier à 17:40 »...) et
// date complète. Fonctions pures : l'heure actuelle est un paramètre. Fuseau : celui du
// serveur par défaut (timeZone undefined), ou celui passé en paramètre (tests).

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Formateurs Intl mis en cache par fuseau : leur construction est coûteuse, et la liste de
// l'inventaire en utilise un par ligne.
const cache = new Map();
function formatters(timeZone) {
  const key = timeZone ?? '';
  let f = cache.get(key);
  if (!f) {
    f = {
      parts: new Intl.DateTimeFormat('fr-FR', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }),
      date: new Intl.DateTimeFormat('fr-FR', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }),
      time: new Intl.DateTimeFormat('fr-FR', { timeZone, hour: '2-digit', minute: '2-digit' }),
    };
    cache.set(key, f);
  }
  return f;
}

/** Jour calendaire (dans le fuseau) d'un instant : {year, month, day}. */
function calendarDay(ms, timeZone) {
  const day = {};
  for (const { type, value } of formatters(timeZone).parts.formatToParts(ms)) {
    if (type === 'year' || type === 'month' || type === 'day') day[type] = Number(value);
  }
  return day;
}

const sameDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day;

/** Veille d'un jour calendaire, par calcul sur le calendrier (indépendant des changements d'heure). */
function previousDay({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day - 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** « 12 nov. 2026 à 09:48 ». Horodatage illisible : « date inconnue ». */
export function formatDateTime(iso, timeZone) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'date inconnue';
  const f = formatters(timeZone);
  return `${f.date.format(at)} à ${f.time.format(at)}`;
}

/**
 * Ancienneté d'un horodatage ISO par rapport à `now` (millisecondes) :
 *   moins d'1 min           → « à l'instant »
 *   moins d'1 h             → « il y a N min »
 *   même jour calendaire    → « il y a N h »
 *   veille                  → « hier à HH:MM »
 *   avant (ou dans le futur au-delà d'1 min, horloge déréglée) → « 12 nov. 2026 à 09:48 »
 */
export function formatAge(iso, now, timeZone) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'date inconnue';
  const elapsed = now - at;
  if (elapsed < -MINUTE_MS) return formatDateTime(iso, timeZone);
  if (elapsed < MINUTE_MS) return 'à l\'instant';
  if (elapsed < HOUR_MS) return `il y a ${Math.floor(elapsed / MINUTE_MS)} min`;
  const day = calendarDay(at, timeZone);
  const today = calendarDay(now, timeZone);
  if (sameDay(day, today)) return `il y a ${Math.floor(elapsed / HOUR_MS)} h`;
  if (sameDay(day, previousDay(today))) return `hier à ${formatters(timeZone).time.format(at)}`;
  return formatDateTime(iso, timeZone);
}
