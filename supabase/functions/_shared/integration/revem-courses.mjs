// REV-EM → LexNote : transformation PURE d'un évènement du planning (ligne `planning_events.data`) en `external-course-event`
// du contrat lexnote-revem/v1. Aucune E/S ici (testable sous Node) ; la lecture en base est faite par runtime.ts avec la clé service role.
// Ce module appartient à REV-EM (il n'est PAS généré depuis LexNote) : seul REV-EM sait lire son planning.
// Jamais transmis : notes, résumé, questions, description libre du cours (données personnelles de l'étudiant).

const REF_RE = /^[A-Za-z0-9._:~@-]{1,128}$/;
export const INTEGRATION_VERSION = 'lexnote-revem/v1';

/** Type de séance déduit du TITRE ; tout ce qui n'est pas reconnu devient OTHER (LexNote gère OTHER comme une séance ordinaire). */
const TYPE_RULES = [
  ['CM', /(^|[^a-z0-9])(cm|cours magistral|cours magistraux|amphi|lecture)([^a-z0-9]|$)/i],
  ['TD', /(^|[^a-z0-9])(td|travaux diriges|travaux dirigés)([^a-z0-9]|$)/i],
  ['TP', /(^|[^a-z0-9])(tp|travaux pratiques|lab)([^a-z0-9]|$)/i],
  ['SEMINAR', /(seminaire|séminaire|seminar|conference|conférence)/i],
  ['WORKSHOP', /(atelier|workshop)/i],
  ['REVISION', /(^|[^a-z0-9])(revision|révision|revisions|révisions)([^a-z0-9]|$)/i],
];
export function sessionTypeOf(summary) {
  const s = String(summary ?? '');
  for (const [type, re] of TYPE_RULES) if (re.test(s)) return type;
  return 'OTHER';
}

const squash = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** « CM – Droit des contrats (groupe 2) » → « Droit des contrats » : sert à regrouper CM/TD/TP d'une même matière sous un seul sujet. */
export function subjectNameFromTitle(summary) {
  let s = squash(summary, 300);
  s = s.replace(/^\s*(cm|td|tp|cours magistral|travaux dirig[ée]s|travaux pratiques|s[ée]minaire|atelier|r[ée]vision)\b\s*[:\-–—·|]*\s*/i, '');
  s = s.replace(/\s*[(\[][^)\]]*(groupe|gr\.?|g)\s*\d+[^)\]]*[)\]]\s*$/i, '').replace(/\s*[-–—·|]\s*(groupe|gr\.?)\s*\w+\s*$/i, '');
  s = s.replace(/\s+(cm|td|tp)\s*\d*\s*$/i, '').trim();
  return s || squash(summary, 160) || 'Cours';
}

export const slug = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);

/** Matière REV-EM de l'étudiant (lignes `subjects`) : recoupement de noms, le plus long nom d'abord (déterministe). Sans correspondance : null. */
export function matchSubject(summary, subjects) {
  const s = String(summary ?? '').toLowerCase();
  const rows = (Array.isArray(subjects) ? subjects : [])
    .filter((r) => r && r.name && String(r.name).trim().length >= 3 && r.local_id && REF_RE.test(String(r.local_id)))
    .sort((a, b) => String(b.name).length - String(a.name).length);
  return rows.find((r) => { const n = String(r.name).toLowerCase(); return s.includes(n) || n.includes(s); }) || null;
}

/** Date-heure « murale » dans le fuseau de l'étudiant, avec décalage : 2026-10-12T08:00:00+02:00. Fuseau inconnu → UTC. */
export function isoInZone(ms, tz) {
  let zone = 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); if (tz) zone = tz; } catch { /* fuseau invalide */ }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offMin = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offMin < 0 ? '-' : '+'; const a = Math.abs(offMin);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * @param row   ligne `planning_events` ({ local_id, data })
 * @param ctx   { subjects: lignes `subjects`, tz, now: ms }
 * @returns un `external-course-event` ou null (évènement absent / inexploitable).
 */
export function courseEventFromPlanning(row, ctx = {}) {
  const e = row && row.data;
  if (!e || typeof e !== 'object') return null;
  const id = String(row.local_id ?? e.id ?? '');
  if (!REF_RE.test(id)) return null;
  const start = Number(e.start);
  if (!Number.isFinite(start) || start <= 0) return null;
  const endRaw = Number(e.end);
  const end = Number.isFinite(endRaw) && endRaw >= start ? endRaw : start;
  const summary = squash(e.summary, 300);
  if (!summary) return null;
  const matched = matchSubject(summary, ctx.subjects);
  const subjectName = squash(matched ? matched.name : subjectNameFromTitle(summary), 300) || 'Cours';
  const subjectRef = matched ? String(matched.local_id) : `name:${slug(subjectName) || 'cours'}`;
  const out = {
    integrationVersion: INTEGRATION_VERSION,
    kind: 'external-course-event',
    origin: 'revem',
    externalId: id,
    title: summary,
    startsAt: isoInZone(start, ctx.tz),
    endsAt: isoInZone(end, ctx.tz),
    allDay: !!e.allDay,
    sessionTypeHint: sessionTypeOf(summary),
    subject: { app: 'revem', ref: subjectRef.slice(0, 128), name: subjectName },
    calendarSource: e.uid ? 'ics' : 'manual',
    cancelled: false,
    updatedAt: new Date(ctx.now ?? Date.now()).toISOString(),
  };
  const room = squash(e.location, 200); if (room) out.location = room;
  const teacher = squash(e.organizer, 120); if (teacher) out.teacher = teacher;
  return out;
}
