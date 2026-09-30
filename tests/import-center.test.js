/* ============================================================================
   REV-EM — le moteur pur de l'Import Center (import-center.js)
   ----------------------------------------------------------------------------
   Exécution :  node tests/import-center.test.js
   Aucun navigateur, aucun réseau, aucun PDF.js : le moteur est pur. Les fichiers
   sont de VRAIS objets File/Blob de Node (pas des maquettes de champs).
   Ce qui est testé AILLEURS (tests/import-center-ui.test.mjs, navigateur) : le
   glisser-déposer réel, le sélecteur, PDF.js sur de vrais PDF, le rendu.
   ============================================================================ */
"use strict";
require("../import-center.js");
const R = globalThis.RevemImport;

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if(ok){ pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const scenario = (n) => console.log(`\n── ${n} ──`);
const mk = (name, bytes, type) => new File([bytes], name, { type: type === undefined ? "" : type, lastModified: 1700000000000 });
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "latin1");
const ZIP = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);

scenario("Formats : uniquement ce que REV-EM sait lire");
{
  eq("PDF", R.kindOfName("Cours.PDF"), "pdf");
  eq("DOCX", R.kindOfName("a.docx"), "docx");
  eq("TXT", R.kindOfName("a.txt"), "text");
  eq("Markdown (.md)", R.kindOfName("a.md"), "text");
  eq("Markdown (.markdown)", R.kindOfName("a.markdown"), "text");
  eq("PPTX : pas lu", R.kindOfName("a.pptx"), null);
  eq("image : pas lue", R.kindOfName("a.png"), null);
  eq("type MIME PDF", R.kindOfMime("application/pdf; charset=binary"), "pdf");
  eq("nom sans extension", R.extOf("Makefile"), "");
  check("accept liste extensions ET types MIME (Safari/WKWebView/Chrome)", /\.pdf/.test(R.ACCEPT) && /application\/pdf/.test(R.ACCEPT) && /\.docx/.test(R.ACCEPT));
  check("accept n'annonce ni PPTX ni image", !/pptx|image\//.test(R.ACCEPT));
}

scenario("Validation des métadonnées");
{
  eq("aucun fichier", R.validateMeta(null).code, "NO_FILE");
  eq("fichier vide (0 octet)", R.validateMeta(mk("a.pdf", Buffer.alloc(0))).code, "EMPTY");
  const big = { name: "gros.pdf", size: R.MAX_BYTES + 1, type: "application/pdf" };
  const r = R.validateMeta(big);
  eq("trop volumineux", r.code, "TOO_LARGE");
  eq("… avec la limite dans les paramètres", r.params.max, R.MAX_BYTES);
  eq("pile à la limite : accepté", R.validateMeta({ name: "ok.pdf", size: R.MAX_BYTES, type: "" }).ok, true);
  eq("format inconnu", R.validateMeta(mk("a.xyz", PDF)).code, "UNSUPPORTED");
  const pp = R.validateMeta(mk("cours.pptx", ZIP));
  eq("PPTX reconnu mais non pris en charge", pp.code, "UNSUPPORTED_KNOWN");
  eq("… la famille est nommée", pp.params.family, "PowerPoint");
  eq("image reconnue mais non prise en charge", R.validateMeta(mk("scan.jpg", PDF, "image/jpeg")).code, "UNSUPPORTED_KNOWN");
  eq("image sans extension mais type image/*", R.validateMeta(mk("photo", PDF, "image/png")).code, "UNSUPPORTED_KNOWN");
  eq("taille illisible", R.validateMeta({ name: "a.pdf" }).code, "UNREADABLE");
  const ok = R.validateMeta(mk("Economie.pdf", PDF, "application/pdf"));
  check("PDF valide accepté", ok.ok && ok.kind === "pdf" && !ok.contradictory);
  eq("PDF sans type MIME (Windows / WKWebView le laissent parfois vide)", R.validateMeta(mk("a.pdf", PDF, "")).ok, true);
  eq("type MIME PDF sans extension", R.validateMeta(mk("cours", PDF, "application/pdf")).kind, "pdf");
  check("extension et type qui se contredisent : signalé, pas refusé sur un seul indice", R.validateMeta(mk("a.pdf", PDF, "text/plain")).contradictory === true);
}

scenario("Validation du CONTENU : la signature réelle, pas le nom");
{
  eq("vrai PDF", R.validateContent("pdf", PDF).ok, true);
  eq("PDF avec octets parasites devant (toléré par la norme)", R.validateContent("pdf", Buffer.concat([Buffer.from("junk\n\n"), PDF])).ok, true);
  eq("un .pdf qui est du texte → NOT_A_PDF", R.validateContent("pdf", Buffer.from("Bonjour, ceci n'est pas un PDF")).code, "NOT_A_PDF");
  eq("un .pdf qui est une image PNG → NOT_A_PDF", R.validateContent("pdf", Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])).code, "NOT_A_PDF");
  eq("un .pdf vide de contenu (que des zéros)", R.validateContent("pdf", Buffer.alloc(64)).code, "NOT_A_PDF");
  eq("DOCX = archive ZIP", R.validateContent("docx", ZIP).ok, true);
  eq("un .docx qui n'est pas un ZIP", R.validateContent("docx", Buffer.from("texte")).code, "NOT_A_DOCX");
  eq("texte brut lisible", R.validateContent("text", Buffer.from("Un cours en UTF-8 : é à ç")).ok, true);
  eq("un .txt binaire (octet nul)", R.validateContent("text", Buffer.from([0x41, 0x00, 0x42])).code, "NOT_TEXT");
  eq("texte collé trop court", R.validateText("abc").code, "TEXT_TOO_SHORT");
  eq("texte collé suffisant", R.validateText("x".repeat(R.MIN_TEXT_CHARS)).ok, true);
  eq("espaces seuls = vide", R.validateText("      \n  ").code, "TEXT_TOO_SHORT");
}

scenario("Erreurs d'extraction → un code, un message");
{
  const c = (e) => R.classifyExtractionError(e);
  eq("PDF corrompu (PDF.js)", c({ name: "InvalidPDFException", message: "Invalid PDF structure." }), "INVALID_PDF");
  eq("PDF introuvable (PDF.js)", c({ name: "MissingPDFException", message: "Missing PDF" }), "INVALID_PDF");
  eq("PDF protégé par mot de passe", c({ name: "PasswordException", message: "No password given" }), "PASSWORD_PROTECTED");
  eq("DOCX corrompu (mammoth)", c(new Error("Can't find end of central directory : is this a zip file ?")), "INVALID_DOCX");
  eq("lecteur PDF injoignable (marqué par index.html)", c(Object.assign(new Error("x"), { code: "READER_LOAD_FAILED" })), "READER_LOAD_FAILED");
  eq("réseau coupé", c(new TypeError("Failed to fetch dynamically imported module")), "READER_LOAD_FAILED");
  eq("annulation", c(Object.assign(new Error("x"), { code: "CANCELLED" })), "INTERRUPTED");
  eq("erreur inconnue → EXTRACT_FAILED, jamais un plantage", c(new Error("boom")), "EXTRACT_FAILED");
  eq("undefined ne plante pas", c(undefined), "EXTRACT_FAILED");
  eq("une chaîne est lue comme un message", c("InvalidPDFException: Invalid PDF structure."), "INVALID_PDF");
  const retryable = ["READER_LOAD_FAILED", "EXTRACT_FAILED", "INTERRUPTED", "ENGINE_BUSY"];
  retryable.forEach(k => check(`${k} propose « Réessayer »`, R.errorInfo(k).retry === true));
  ["NOT_A_PDF", "TOO_LARGE", "UNSUPPORTED", "INVALID_PDF", "NO_TEXT", "PASSWORD_PROTECTED"].forEach(k => check(`${k} propose « Choisir un autre fichier »`, R.errorInfo(k).retry === false));
  eq("clé de traduction", R.errorInfo("NOT_A_PDF").messageKey, "imp.err.NOT_A_PDF");
  eq("un code inconnu retombe sur EXTRACT_FAILED", R.errorInfo("???").messageKey, "imp.err.EXTRACT_FAILED");
}

scenario("Machine d'états : un seul état, aucune combinaison impossible");
{
  let t = 1000; const m = R.createMachine({ now: () => t });
  eq("départ", m.state, "IDLE");
  check("« Importer » impossible sans fichier", m.beginProcess() === false && m.state === "IDLE");
  check("glisser au-dessus : DRAGGING", m.dragEnter() && m.state === "DRAGGING");
  check("quitter la zone : retour à IDLE", m.dragLeave() && m.state === "IDLE");
  const f = mk("Economie.pdf", PDF, "application/pdf");
  check("déposer → VALIDATING", m.beginValidate(f) && m.state === "VALIDATING");
  check("un autre fichier pendant la validation est ignoré", m.beginValidate(mk("b.pdf", PDF)) === false);
  check("accepté → READY", m.accepted("pdf") && m.state === "READY" && m.source.kind === "pdf");
  check("glisser un autre fichier depuis READY, puis quitter : retour à READY", m.dragEnter() && m.dragLeave() && m.state === "READY");
  check("Importer → PROCESSING", m.beginProcess() && m.state === "PROCESSING");
  check("DOUBLE CLIC : le 2e « Importer » ne relance rien", m.beginProcess() === false && m.state === "PROCESSING");
  check("pas de glisser-déposer pendant le traitement", m.dragEnter() === false);
  check("pas de nouveau fichier pendant le traitement", m.beginValidate(mk("c.pdf", PDF)) === false);
  check("pas de suppression pendant le traitement", m.remove() === false);
  m.setStep("read", { page: 2, total: 9 });
  eq("étape et progression réelles", [m.step, m.progress], ["read", { page: 2, total: 9 }]);
  check("annuler → READY, le fichier est conservé", m.cancel() && m.state === "READY" && m.source.file === f);
  m.beginProcess();
  check("échec → ERROR avec code et « réessayer » proposé", m.failed({ code: "EXTRACT_FAILED" }) && m.state === "ERROR" && m.error.retry === true);
  check("réessayer → READY (le fichier est toujours là)", m.retry() && m.state === "READY" && m.source.file === f);
  m.beginProcess();
  const res = R.buildImportResult({ file: f, kind: "pdf", extractedText: "Texte du cours", numPages: 3 });
  check("succès → SUCCESS avec le résultat", m.succeeded(res) && m.state === "SUCCESS" && m.result.filename === "Economie.pdf");
  check("SUCCESS est terminal : pas de nouveau traitement", m.beginProcess() === false && m.beginValidate(mk("z.pdf", PDF)) === false);
  m.reset();
  eq("reset : plus aucun état fantôme", [m.state, m.source, m.error, m.result], ["IDLE", null, null, null]);
}

scenario("Remplacer, supprimer, erreurs de validation");
{
  let t = 5000; const m = R.createMachine({ now: () => t });
  const a = mk("a.pdf", PDF, "application/pdf"), b = mk("b.pdf", PDF, "application/pdf");
  m.beginValidate(a); m.accepted("pdf");
  t += 5000;
  check("Remplacer : un nouveau fichier repasse par la validation", m.beginValidate(b) && m.state === "VALIDATING" && m.source.file === b);
  m.accepted("pdf");
  check("Supprimer → IDLE et plus de fichier", m.remove() && m.state === "IDLE" && m.source === null);
  t += 5000;
  m.beginValidate(mk("x.xyz", PDF));
  check("refus → ERROR, la zone reste utilisable", m.rejected({ ok: false, code: "UNSUPPORTED", params: { ext: "xyz" } }) && m.state === "ERROR" && m.source === null);
  eq("le code et les paramètres sont conservés", [m.error.code, m.error.params.ext], ["UNSUPPORTED", "xyz"]);
  check("on peut déposer un fichier valide depuis ERROR", (t += 5000, m.beginValidate(a)) && m.state === "VALIDATING");
  m.accepted("pdf");
  check("depuis ERROR, glisser puis quitter revient à ERROR", (() => { const n = R.createMachine({ now: () => 1 }); n.beginValidate(a); n.rejected({ code: "EMPTY" }); n.dragEnter(); return n.dragLeave() && n.state === "ERROR"; })());
  check("remove depuis ERROR → IDLE", (() => { const n = R.createMachine({ now: () => 1 }); n.beginValidate(a); n.rejected({ code: "EMPTY" }); return n.remove() && n.state === "IDLE"; })());
}

scenario("Doublons d'événements : drop + change du MÊME fichier = UNE intention");
{
  let t = 100; const m = R.createMachine({ now: () => t });
  const f = mk("cours.pdf", PDF, "application/pdf");
  check("1er déclenchement accepté", m.beginValidate(f));
  m.accepted("pdf");
  t += 300;
  check("même fichier 300 ms plus tard : ignoré (double événement)", m.beginValidate(mk("cours.pdf", PDF, "application/pdf")) === false && m.state === "READY");
  t += 2000;
  check("même fichier volontairement re-choisi plus tard : accepté", m.beginValidate(mk("cours.pdf", PDF, "application/pdf")) === true);
  m.accepted("pdf"); m.remove();
  check("supprimer puis re-choisir aussitôt : accepté (suppression volontaire)", m.beginValidate(mk("cours.pdf", PDF, "application/pdf")) === true);
  eq("empreinte stable (nom|taille|date)", R.fingerprint(f), "cours.pdf|" + PDF.length + "|1700000000000");
}

scenario("Texte collé : même machine, même sortie");
{
  const m = R.createMachine({ now: () => 1 });
  check("texte collé → VALIDATING → READY", m.beginValidateText("Le bilan comptable présente l'actif et le passif.") && m.accepted("text") && m.state === "READY");
  check("source de type texte", m.source.type === "text" && m.source.kind === "text");
  m.beginProcess();
  const r = R.buildImportResult({ file: null, filename: "Texte collé", kind: "text", extractedText: m.source.text });
  check("ImportResult d'un texte collé : pas de fichier, taille = caractères", r.file === null && r.size === r.charCount && r.mimeType === "text/plain");
}

scenario("ImportResult : l'unique frontière avec la Phase 2");
{
  const f = mk("Economie-des-marches.pdf", PDF, "application/pdf");
  const r = R.buildImportResult({ file: f, kind: "pdf", extractedText: "Contenu ".repeat(50), numPages: 12, truncated: false, sourceContext: { subjectId: "s_finance", origin: "dashboard" } });
  eq("champs de l'ImportResult", Object.keys(r).sort(), ["charCount", "extractedText", "file", "filename", "kind", "mimeType", "numPages", "size", "sourceContext", "truncated"]);
  eq("nom, type, taille", [r.filename, r.mimeType, r.size], ["Economie-des-marches.pdf", "application/pdf", PDF.length]);
  eq("contexte de départ conservé", [r.sourceContext.subjectId, r.sourceContext.origin], ["s_finance", "dashboard"]);
  check("importedAt est un horodatage", typeof r.sourceContext.importedAt === "number");
  eq("aucune matière imposée par défaut", R.buildImportResult({ kind: "text", extractedText: "x" }).sourceContext.subjectId, null);
  check("le texte extrait est conservé INTACT", r.extractedText === "Contenu ".repeat(50));
}

scenario("Présentation de la taille");
{
  eq("octets", R.formatSize(512), "512 o");
  eq("Ko", R.formatSize(2048), "2 Ko");
  eq("Mo, virgule française", R.formatSize(4.8 * 1024 * 1024, "fr-FR"), "4,8 Mo");
  eq("Mo, point anglais", R.formatSize(4.8 * 1024 * 1024, "en-GB", { b: "B", kb: "KB", mb: "MB" }), "4.8 MB");
  eq("libellé du format", R.kindLabel("pdf"), "PDF");
}

console.log(`\n${pass} vérifications réussies, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
