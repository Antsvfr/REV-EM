/* ============================================================================
   REV-EM → LexNote : lancement « Prendre mes notes dans LexNote » — côté REV-EM, sans navigateur ni réseau.
   Exécution : node tests/integration-launch.test.mjs
   Vérifie : mapper planning → external-course-event (valide pour le contrat), types de séance, regroupement par matière,
   fuseau horaire, données jamais transmises, câblage Edge Function (la lecture du cours se fait côté serveur).
   ============================================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const SH = path.join(here, "..", "supabase", "functions", "_shared", "integration");
const M = await import("file://" + path.join(SH, "revem-courses.mjs"));
const I = await import("file://" + path.join(SH, "lexnote-revem-v1.mjs"));

let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { pass++; console.log("PASS — " + l); } else { fail++; console.log("FAIL — " + l + "  " + (d !== undefined ? JSON.stringify(d) : "")); } };
const eq = (l, g, w) => check(l, JSON.stringify(g) === JSON.stringify(w), { attendu: w, obtenu: g });
const scenario = (n) => console.log("\n── " + n + " ──");

const START = Date.UTC(2026, 9, 12, 6, 0, 0);   // 12 oct. 2026 08:00 à Paris (UTC+2)
const row = (over = {}, id = "evt_ab12cd") => ({ local_id: id, data: Object.assign({ id, uid: "u1@ics", summary: "CM Droit des contrats", start: START, end: START + 2 * 3600e3, location: "Amphi B", organizer: "Mme Durand", description: "NOTES PERSONNELLES SECRÈTES" }, over) });
const SUBJ = [{ local_id: "subj_dc1", name: "Droit des contrats" }, { local_id: "subj_ec", name: "Économie" }];
const ctx = { subjects: SUBJ, tz: "Europe/Paris", now: Date.UTC(2026, 9, 9) };

scenario("Types de séance");
for (const [t, w] of [["CM Droit des contrats", "CM"], ["TD – Droit des contrats (groupe 2)", "TD"], ["TP Informatique", "TP"], ["Séminaire de recherche", "SEMINAR"], ["Atelier CV", "WORKSHOP"], ["Révision partiels", "REVISION"], ["Cours magistral de droit", "CM"], ["Réunion associative", "OTHER"], ["", "OTHER"]])
  eq("« " + t + " » → " + w, M.sessionTypeOf(t), w);

scenario("Mapper : cours complet");
{
  const ev = M.courseEventFromPlanning(row(), ctx);
  check("accepté par le schéma du contrat", I.externalCourseEventSchema.safeParse(ev).success, I.externalCourseEventSchema.safeParse(ev).error?.issues);
  eq("identifiant d'évènement stable = id REV-EM", ev.externalId, "evt_ab12cd");
  eq("matière = id REV-EM de la matière", ev.subject, { app: "revem", ref: "subj_dc1", name: "Droit des contrats" });
  eq("début avec fuseau (Paris, UTC+2)", ev.startsAt, "2026-10-12T08:00:00+02:00");
  eq("fin", ev.endsAt, "2026-10-12T10:00:00+02:00");
  eq("type", ev.sessionTypeHint, "CM"); eq("salle", ev.location, "Amphi B"); eq("enseignant", ev.teacher, "Mme Durand");
  check("la description (notes personnelles) n'est JAMAIS transmise", !JSON.stringify(ev).includes("SECRÈTES"));
  const plan = I.planCourseOpen(ev, { userId: "u", linkId: "l", provider: "revem" });
  eq("planCourseOpen : date / heures locales conservées", [plan.date, plan.startTime, plan.endTime, plan.type], ["2026-10-12", "08:00", "10:00", "CM"]);
}

scenario("Fuseaux et heure d'hiver");
{
  const w = Date.UTC(2026, 0, 12, 7, 0, 0);
  eq("hiver Paris UTC+1", M.isoInZone(w, "Europe/Paris"), "2026-01-12T08:00:00+01:00");
  eq("fuseau invalide → UTC", M.isoInZone(w, "Pas/Un_Fuseau"), "2026-01-12T07:00:00+00:00");
  eq("sans fuseau → UTC", M.isoInZone(w), "2026-01-12T07:00:00+00:00");
  eq("Montréal UTC-5", M.isoInZone(w, "America/Toronto"), "2026-01-12T02:00:00-05:00");
}

scenario("Regroupement par matière (pas de doublon « Droit des contrats ×4 »)");
{
  const noSubj = { subjects: [], tz: "Europe/Paris" };
  const names = ["CM Droit des contrats", "TD – Droit des contrats (groupe 2)", "TP Droit des contrats", "Droit des contrats CM 3"].map((s, i) => M.courseEventFromPlanning(row({ summary: s }, "evt_" + i), noSubj).subject.ref);
  eq("une seule clé de matière", [...new Set(names)], ["name:droit-des-contrats"]);
  const acc = M.courseEventFromPlanning(row({ summary: "CM Économie générale" }, "evt_x"), { subjects: [], tz: "UTC" });
  eq("nom accentué → clé sans accent, nom d'origine conservé", [acc.subject.ref, acc.subject.name], ["name:economie-generale", "Économie générale"]);
  eq("matière connue prioritaire sur le nom", M.courseEventFromPlanning(row({ summary: "TD Économie" }), ctx).subject.ref, "subj_ec");
}

scenario("Champs absents, caractères spéciaux, entrées invalides");
{
  const bare = M.courseEventFromPlanning(row({ location: undefined, organizer: undefined, uid: null }), ctx);
  check("sans salle ni enseignant : champs omis, contrat valide", !("location" in bare) && !("teacher" in bare) && I.externalCourseEventSchema.safeParse(bare).success);
  eq("sans UID → source manuelle", bare.calendarSource, "manual");
  const odd = M.courseEventFromPlanning(row({ summary: "TD <b>Mathématiques</b> & « stats » 🎓\n\t(gr. 3)", location: "Salle\u0000 12" }), ctx);
  check("caractères spéciaux : valide, sans caractère de contrôle", I.externalCourseEventSchema.safeParse(odd).success && !/[\u0000-\u001f]/.test(odd.title + odd.location), odd);
  eq("évènement sans début → null", M.courseEventFromPlanning(row({ start: null }), ctx), null);
  eq("identifiant illégal → null", M.courseEventFromPlanning({ local_id: "a b/../c", data: row().data }, ctx), null);
  eq("ligne absente → null", M.courseEventFromPlanning(null, ctx), null);
  const noEnd = M.courseEventFromPlanning(row({ end: undefined }), ctx);
  check("sans fin : fin = début (valide)", noEnd.endsAt === noEnd.startsAt && I.externalCourseEventSchema.safeParse(noEnd).success);
  const long = M.courseEventFromPlanning(row({ summary: "CM " + "x".repeat(900) }), ctx);
  check("titre très long borné", long.title.length <= 300 && I.externalCourseEventSchema.safeParse(long).success);
}

scenario("Câblage Edge Function REV-EM");
{
  const rt = fs.readFileSync(path.join(SH, "runtime.ts"), "utf8");
  check("REV-EM s'identifie 'revem'", /SELF = 'revem'/.test(rt));
  check("le cours est relu en base par identifiant + utilisateur du JETON", /planning_events/.test(rt) && /\.eq\('user_id', userId\)\.eq\('local_id', eventId\)/.test(rt));
  check("launch branché sur la passerelle ET sur la fonction utilisateur", /gw: \{[^}]*launch/.test(rt) && /user: \{[^}]*launch/.test(rt));
  check("aucun cours fourni par le navigateur", !/body\.(event|summary|course)/.test(rt));
  const mod = fs.readFileSync(path.join(SH, "revem-courses.mjs"), "utf8");
  check("mapper pur : aucun import, aucune E/S", !/^\s*import\s/m.test(mod) && !/fetch\(|Deno\./.test(mod));
  check("la description du cours n'est pas lue", !/\.description/.test(mod.replace(/\/\/.*$/gm, "")));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
