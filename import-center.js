/* ============================================================================
   import-center.js — la logique PURE de l'Import Center
   ----------------------------------------------------------------------------
   `globalThis.RevemImport` — même patron que smart-revision.js, statistics.js,
   command-center.js, quick-actions.js, subject-search.js et ai-engine.js :
   aucune dépendance au DOM, à `state`, à PDF.js ni au réseau. Il reçoit un
   fichier (ou un texte), rend des décisions : accepté ou refusé, pourquoi, quel
   message, quel état. Testable sous Node : `node tests/import-center.test.js`.

   Ce fichier NE lit PAS le contenu d'un PDF, n'ouvre aucun sélecteur, ne dessine
   rien : cela vit dans index.html (§7ter-bis, « IMPORT CENTER »).

   LA FRONTIÈRE AVEC LA PHASE 2
   ----------------------------------------------------------------------------
   Tout ce que l'Import Center produit tient dans UN objet, `ImportResult`
   (voir buildImportResult). La Phase 2 (analyse → matière → chapitre → fiche →
   quiz → flashcards → Supabase) n'aura à lire QUE cet objet.
   ============================================================================ */
(function(global){
  "use strict";

  var MB = 1024 * 1024;
  var MAX_BYTES = 15 * MB;          /* la limite historique du pipeline (COURSE_IMPORT_MAX_BYTES) */
  var MIN_TEXT_CHARS = 40;          /* en dessous : considéré vide/illisible (COURSE_IMPORT_MIN_CHARS) */
  var MAX_PDF_PAGES = 100;          /* le lecteur existant s'arrête là et le dit */

  /* ── 1. FORMATS : uniquement ceux que REV-EM sait réellement lire ─────────
     PDF (PDF.js), DOCX (mammoth), texte brut et Markdown (lecture directe).
     Tout le reste est refusé PROPREMENT, et les formats qu'on reconnaît sans
     savoir les lire (PPTX, images…) le disent, au lieu de faire semblant. */
  var KINDS = { pdf: "pdf", docx: "docx", text: "text" };
  var EXT_KIND = { pdf: "pdf", docx: "docx", txt: "text", md: "text", markdown: "text" };
  var MIME_KIND = {
    "application/pdf": "pdf", "application/x-pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "text", "text/markdown": "text", "text/x-markdown": "text",
  };
  var KNOWN_UNSUPPORTED = {
    pptx: "PowerPoint", ppt: "PowerPoint", key: "Keynote", odp: "présentation",
    xlsx: "Excel", xls: "Excel", numbers: "Numbers", csv: "tableur",
    doc: "Word (ancien format .doc)", rtf: "RTF", odt: "OpenDocument", pages: "Pages",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image", tif: "image", tiff: "image", bmp: "image", svg: "image",
    zip: "archive", rar: "archive", "7z": "archive",
  };
  /* Attribut `accept` de l'<input type="file"> : extensions ET types MIME.
     Les deux, parce que Safari/WKWebView honorent surtout les extensions et que
     Chrome honore les deux ; aucune API propre à Chromium. */
  var ACCEPT = ".pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,text/plain,.md,.markdown";

  function extOf(name){
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || "").trim());
    return m ? m[1].toLowerCase() : "";
  }
  function kindOfName(name){ return EXT_KIND[extOf(name)] || null; }
  function kindOfMime(type){ return MIME_KIND[String(type || "").toLowerCase().split(";")[0].trim()] || null; }

  /* ── 2. VALIDATION ────────────────────────────────────────────────────────
     Deux temps, parce que « ça se termine par .pdf » ne prouve rien :
       validateMeta    — synchrone : présent, non vide, taille, type/extension ;
       validateContent — sur les PREMIERS OCTETS : signature réelle du format.
     Un code par cause : c'est lui qui choisit le message (imp.err.<CODE>). */
  function fail(code, params){ return { ok: false, code: code, params: params || {} }; }

  function validateMeta(file, opts){
    var max = (opts && opts.maxBytes) || MAX_BYTES;
    if(!file || typeof file !== "object") return fail("NO_FILE");
    var name = String(file.name || "");
    var size = typeof file.size === "number" ? file.size : -1;
    if(size === 0) return fail("EMPTY", { name: name });
    if(size < 0) return fail("UNREADABLE", { name: name });
    if(size > max) return fail("TOO_LARGE", { name: name, size: size, max: max });
    var byExt = kindOfName(name), byMime = kindOfMime(file.type);
    var kind = byExt || byMime;
    if(!kind){
      var ext = extOf(name);
      if(KNOWN_UNSUPPORTED[ext]) return fail("UNSUPPORTED_KNOWN", { name: name, ext: ext, family: KNOWN_UNSUPPORTED[ext] });
      if(/^image\//i.test(String(file.type || ""))) return fail("UNSUPPORTED_KNOWN", { name: name, ext: ext || "image", family: "image" });
      return fail("UNSUPPORTED", { name: name, ext: ext });
    }
    /* Extension et type MIME qui se contredisent franchement (un « .pdf » déclaré
       image/png) : on ne tranche pas sur un seul indice, on regarde le contenu. */
    return { ok: true, kind: kind, contradictory: !!(byExt && byMime && byExt !== byMime) };
  }

  function startsWith(bytes, sig, offset){
    offset = offset || 0;
    if(!bytes || bytes.length < offset + sig.length) return false;
    for(var i = 0; i < sig.length; i++){ if(bytes[offset + i] !== sig[i]) return false; }
    return true;
  }
  /* « %PDF- » peut être précédé de quelques octets parasites (la norme tolère
     1 024 octets) : on cherche dans cette fenêtre, pas seulement en position 0. */
  function hasPdfSignature(bytes){
    var lim = Math.min((bytes && bytes.length) || 0, 1024) - 4;
    for(var i = 0; i <= lim; i++){
      if(bytes[i] === 0x25 && bytes[i+1] === 0x50 && bytes[i+2] === 0x44 && bytes[i+3] === 0x46 && bytes[i+4] === 0x2D) return true;
    }
    return false;
  }
  function hasZipSignature(bytes){ return startsWith(bytes, [0x50, 0x4B, 0x03, 0x04]); }
  function looksBinary(bytes){
    var n = Math.min((bytes && bytes.length) || 0, 4096);
    for(var i = 0; i < n; i++){ if(bytes[i] === 0) return true; }
    return false;
  }
  function validateContent(kind, head){
    if(kind === "pdf") return hasPdfSignature(head) ? { ok: true } : fail("NOT_A_PDF");
    if(kind === "docx") return hasZipSignature(head) ? { ok: true } : fail("NOT_A_DOCX");
    if(kind === "text") return looksBinary(head) ? fail("NOT_TEXT") : { ok: true };
    return fail("UNSUPPORTED");
  }
  function validateText(text){
    var t = String(text == null ? "" : text).trim();
    if(t.length < MIN_TEXT_CHARS) return fail("TEXT_TOO_SHORT", { min: MIN_TEXT_CHARS, length: t.length });
    return { ok: true };
  }

  /* ── 3. ERREURS : un code → un message clair, jamais une pile technique ──── */
  var ERROR_INFO = {
    NO_FILE:            { retry: false },
    EMPTY:              { retry: false },
    UNREADABLE:         { retry: false },
    TOO_LARGE:          { retry: false },
    UNSUPPORTED:        { retry: false },
    UNSUPPORTED_KNOWN:  { retry: false },
    NOT_A_PDF:          { retry: false },
    NOT_A_DOCX:         { retry: false },
    NOT_TEXT:           { retry: false },
    TEXT_TOO_SHORT:     { retry: false },
    INVALID_PDF:        { retry: false },
    INVALID_DOCX:       { retry: false },
    PASSWORD_PROTECTED: { retry: false },
    NO_TEXT:            { retry: false },
    READER_LOAD_FAILED: { retry: true },
    EXTRACT_FAILED:     { retry: true },
    INTERRUPTED:        { retry: true },
    ENGINE_BUSY:        { retry: true },
  };
  function errorInfo(code){
    var i = ERROR_INFO[code] || { retry: true };
    return { code: code, messageKey: "imp.err." + (ERROR_INFO[code] ? code : "EXTRACT_FAILED"), retry: i.retry };
  }
  function normalizeError(e){
    if(e === undefined || e === null) return { name: "", message: "" };
    if(typeof e === "string") return { name: "", message: e };
    return { name: String(e.name || ""), message: String(e.message || "") };
  }
  /* Erreurs de PDF.js (noms d'exception documentés), de mammoth (zip illisible),
     du chargement du lecteur, de l'annulation. Le texte brut reste pour la
     console ; l'utilisateur ne voit que le message du code. */
  function classifyExtractionError(e){
    var n = normalizeError(e), text = n.name + " " + n.message;
    if(e && e.code === "READER_LOAD_FAILED") return "READER_LOAD_FAILED";
    if(e && e.code === "CANCELLED") return "INTERRUPTED";
    if(/PasswordException|No password given|Incorrect password/i.test(text)) return "PASSWORD_PROTECTED";
    if(/InvalidPDFException|MissingPDFException|Invalid PDF structure|Missing PDF|not a PDF/i.test(text)) return "INVALID_PDF";
    if(/central directory|end of central|not a valid zip|Corrupted zip|zip file|Can't find end/i.test(text)) return "INVALID_DOCX";
    if(/dynamically imported module|Importing a module script failed|Failed to fetch|NetworkError|Load failed/i.test(text)) return "READER_LOAD_FAILED";
    return "EXTRACT_FAILED";
  }

  /* ── 4. MACHINE D'ÉTATS — UN état, jamais quatre booléens ─────────────────
     IDLE → (DRAGGING) → VALIDATING → READY → PROCESSING → SUCCESS
                                  ↘ ERROR ↙
     Les états impossibles (« en train de traiter ET en erreur ») ne sont pas
     représentables : il n'existe qu'une seule variable, `state`. */
  var STATES = ["IDLE", "DRAGGING", "VALIDATING", "READY", "PROCESSING", "SUCCESS", "ERROR"];
  var TRANSITIONS = {
    IDLE:       ["DRAGGING", "VALIDATING"],
    DRAGGING:   ["IDLE", "READY", "ERROR", "VALIDATING"],
    VALIDATING: ["READY", "ERROR"],
    READY:      ["DRAGGING", "VALIDATING", "PROCESSING", "IDLE"],
    PROCESSING: ["SUCCESS", "ERROR", "READY"],
    SUCCESS:    ["IDLE"],
    ERROR:      ["DRAGGING", "VALIDATING", "READY", "IDLE"],
  };
  /* Deux déclenchements du même fichier à moins de 1,2 s (drop + change, ou un
     double événement du navigateur) sont UNE seule intention. */
  var DUPLICATE_WINDOW_MS = 1200;

  function fingerprint(file){
    if(!file) return "";
    return [file.name || "", file.size == null ? "" : file.size, file.lastModified == null ? "" : file.lastModified].join("|");
  }

  function createMachine(opts){
    opts = opts || {};
    var st = "IDLE", origin = "IDLE";
    var data = { source: null, error: null, result: null, step: null, progress: null, lastFp: "", lastFpAt: 0 };
    var listeners = [];
    var nowFn = opts.now || function(){ return Date.now(); };

    function go(next){
      if(st === next) return true;
      if(TRANSITIONS[st].indexOf(next) < 0) return false;
      var prev = st; st = next;
      listeners.forEach(function(fn){ try{ fn(next, prev); }catch(e){} });
      return true;
    }
    return {
      get state(){ return st; },
      get source(){ return data.source; },
      get error(){ return data.error; },
      get result(){ return data.result; },
      get step(){ return data.step; },
      get progress(){ return data.progress; },
      on: function(fn){ listeners.push(fn); },
      can: function(next){ return TRANSITIONS[st].indexOf(next) >= 0; },

      /* Glisser : n'a de sens que si aucune opération n'est en cours. */
      dragEnter: function(){
        if(st === "DRAGGING") return true;
        if(st === "PROCESSING" || st === "SUCCESS" || st === "VALIDATING") return false;
        origin = st; return go("DRAGGING");
      },
      dragLeave: function(){
        if(st !== "DRAGGING") return false;
        return go(origin === "DRAGGING" ? "IDLE" : origin);
      },
      /* Un fichier arrive (choisi ou déposé) : VALIDATING, sauf doublon d'événement. */
      beginValidate: function(file){
        var fp = fingerprint(file), now = nowFn();
        if(st === "VALIDATING") return false;
        if(fp && fp === data.lastFp && now - data.lastFpAt < DUPLICATE_WINDOW_MS) return false;
        if(st === "PROCESSING" || st === "SUCCESS") return false;
        data.lastFp = fp; data.lastFpAt = now;
        data.source = { type: "file", file: file, kind: null };
        data.error = null; data.result = null;
        return go("VALIDATING");
      },
      beginValidateText: function(text){
        if(st === "VALIDATING" || st === "PROCESSING" || st === "SUCCESS") return false;
        data.source = { type: "text", text: String(text == null ? "" : text), kind: "text" };
        data.error = null; data.result = null;
        return go("VALIDATING");
      },
      accepted: function(kind){
        if(st !== "VALIDATING") return false;
        if(data.source) data.source.kind = kind || data.source.kind;
        return go("READY");
      },
      rejected: function(err){
        if(st !== "VALIDATING") return false;
        data.error = errorInfoWith(err); data.source = null;
        return go("ERROR");
      },
      /* Supprimer : retour à IDLE, plus aucune trace du fichier. */
      remove: function(){
        if(st !== "READY" && st !== "ERROR") return false;
        data.source = null; data.error = null; data.result = null; data.lastFp = "";
        return go("IDLE");
      },
      /* Lancer le traitement : UNE seule fois. Un second clic trouve PROCESSING. */
      beginProcess: function(){
        if(st !== "READY") return false;
        data.step = null; data.progress = null; data.error = null;
        return go("PROCESSING");
      },
      setStep: function(step, progress){
        if(st !== "PROCESSING") return false;
        data.step = step; data.progress = progress || null; return true;
      },
      succeeded: function(result){
        if(st !== "PROCESSING") return false;
        data.result = result; data.step = null; data.progress = null;
        return go("SUCCESS");
      },
      failed: function(err){
        if(st !== "PROCESSING") return false;
        data.error = errorInfoWith(err); data.step = null; data.progress = null;
        return go("ERROR");
      },
      /* Annuler un traitement RÉELLEMENT en cours : on garde le fichier. */
      cancel: function(){
        if(st !== "PROCESSING") return false;
        data.step = null; data.progress = null;
        return go("READY");
      },
      /* Réessayer après une erreur de traitement : le fichier est toujours là. */
      retry: function(){
        if(st !== "ERROR" || !data.source) return false;
        data.error = null; return go("READY");
      },
      reset: function(){
        data = { source: null, error: null, result: null, step: null, progress: null, lastFp: "", lastFpAt: 0 };
        origin = "IDLE"; st = "IDLE";
        listeners.forEach(function(fn){ try{ fn("IDLE", "RESET"); }catch(e){} });
        return true;
      },
    };
  }
  function errorInfoWith(err){
    var code = (err && err.code) || "EXTRACT_FAILED";
    var info = errorInfo(code);
    info.params = (err && err.params) || {};
    return info;
  }

  /* ── 5. LA SORTIE : ImportResult — l'ENTRÉE de la Phase 2 ─────────────────
       file          l'objet File d'origine (pour conserver le PDF), ou null (texte collé)
       filename      nom affiché
       mimeType      type déclaré par le navigateur, sinon déduit du format
       size          octets (pour un texte collé : nombre de caractères)
       kind          "pdf" | "docx" | "text"
       extractedText texte extrait, intact (jamais résumé ici)
       charCount     longueur du texte
       numPages      pages du PDF (null sinon)
       truncated     vrai si le lecteur s'est arrêté avant la fin (100 pages)
       sourceContext { subjectId, origin, importedAt } — d'où l'import est parti
     Ce sont les MÊMES données que le pipeline actuel range dans un élément de
     file (state.courseImport.files[i]) ; l'Import Center ne crée aucun second
     format : index.html le convertit en élément de file (courseImportAddPrepared). */
  var KIND_MIME = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: "text/plain" };
  function buildImportResult(input){
    input = input || {};
    var file = input.file || null, kind = input.kind || "text";
    var text = String(input.extractedText == null ? "" : input.extractedText);
    var ctx = input.sourceContext || {};
    return {
      file: file,
      filename: input.filename || (file && file.name) || "",
      mimeType: (file && file.type) || KIND_MIME[kind] || "",
      size: file ? file.size : text.length,
      kind: kind,
      extractedText: text,
      charCount: text.length,
      numPages: input.numPages == null ? null : input.numPages,
      truncated: !!input.truncated,
      sourceContext: {
        subjectId: ctx.subjectId || null,
        origin: ctx.origin || "unknown",
        importedAt: ctx.importedAt || Date.now(),
      },
    };
  }

  /* ── 6. PRÉSENTATION ─────────────────────────────────────────────────────── */
  function formatSize(bytes, locale, units){
    var u = units || { b: "o", kb: "Ko", mb: "Mo" };
    var nf = function(v, d, minD){
      try{ return new Intl.NumberFormat(locale || "fr-FR", { minimumFractionDigits: minD === undefined ? d : minD, maximumFractionDigits: d }).format(v); }
      catch(e){ return String(Math.round(v * 10) / 10); }
    };
    if(bytes < 1024) return nf(bytes, 0) + " " + u.b;
    if(bytes < MB) return nf(bytes / 1024, 0) + " " + u.kb;
    return nf(bytes / MB, 1, 0) + " " + u.mb;         /* « 15 Mo », « 4,8 Mo » : jamais « 15,0 Mo » */
  }
  function kindLabel(kind){ return { pdf: "PDF", docx: "DOCX", text: "TXT" }[kind] || ""; }

  global.RevemImport = {
    MAX_BYTES: MAX_BYTES, MIN_TEXT_CHARS: MIN_TEXT_CHARS, MAX_PDF_PAGES: MAX_PDF_PAGES, ACCEPT: ACCEPT,
    KINDS: KINDS, STATES: STATES, DUPLICATE_WINDOW_MS: DUPLICATE_WINDOW_MS,
    extOf: extOf, kindOfName: kindOfName, kindOfMime: kindOfMime,
    validateMeta: validateMeta, validateContent: validateContent, validateText: validateText,
    hasPdfSignature: hasPdfSignature, hasZipSignature: hasZipSignature, looksBinary: looksBinary,
    errorInfo: errorInfo, classifyExtractionError: classifyExtractionError,
    createMachine: createMachine, fingerprint: fingerprint,
    buildImportResult: buildImportResult, formatSize: formatSize, kindLabel: kindLabel,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
