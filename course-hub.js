/* ============================================================================
   course-hub.js — la logique PURE du « Hub de révision » d'un cours
   ----------------------------------------------------------------------------
   `globalThis.RevemHub` — même patron que smart-revision.js, statistics.js,
   command-center.js, quick-actions.js, subject-search.js, ai-engine.js et
   import-center.js : aucune dépendance au DOM, à `state`, à WebLLM ni à
   Supabase. Testable sous Node : `node tests/course-hub.test.js`.

   CE QU'IL FAIT
     • dit, pour un cours, l'ÉTAT de chacune de ses cinq ressources
       (NOT_GENERATED · QUEUED · GENERATING · READY · ERROR) ;
     • tient la FILE SÉQUENTIELLE des générations : un seul travail à la fois,
       aucun doublon, jamais deux lancements pour la même ressource ;
     • donne la référence stable d'un cours (courseId / chapterId / subjectId).

   CE QU'IL NE FAIT PAS : générer quoi que ce soit (cela reste le pipeline
   existant — courseImportRunAllSteps), toucher au stockage, dessiner.

   ⚠ « courseId » n'est PAS un second identifiant : dans REV-EM le chapitre EST
   le cours (voir COURSE_PIPELINE_AUDIT.md). courseId === chapterId. Aucune donnée
   nouvelle, aucune migration : l'état READY se DÉDUIT de ce qui est réellement
   enregistré dans le chapitre ; les états QUEUED/GENERATING/ERROR n'existent
   que pendant la session (jamais persistés, jamais inventés au rechargement).
   ============================================================================ */
(function(global){
  "use strict";

  var STATES = ["NOT_GENERATED", "QUEUED", "GENERATING", "READY", "ERROR"];

  /* Les cinq destinations. `field` = le champ RÉEL du chapitre qui les stocke ;
     `generable` = produit par le pipeline d'import ; `count` = affiche un nombre
     réel (jamais fabriqué). « questions » est une ENTRÉE vers l'assistant, pas
     une ressource générée : elle est toujours disponible. */
  var RESOURCES = [
    { key: "fiche",      field: "content",     icon: "file",      generable: true,  count: false, view: "resource" },
    { key: "summary",    field: "summary",     icon: "lines",     generable: true,  count: false, view: "resource" },
    { key: "quiz",       field: "aiQuiz",      icon: "quizcheck", generable: true,  count: true,  view: "play" },
    /* Quiz Flash : une séance COURTE tirée de la MÊME banque de questions que « Quiz » — pas
       de seconde génération. `alias` = la ressource dont il dépend (état, file, erreurs). */
    { key: "quizflash",  field: "aiQuiz",      icon: "bolt",      generable: true,  count: true,  view: "play", alias: "quiz" },
    { key: "flashcards", field: "aiFlashcards", icon: "cards",    generable: true,  count: true,  view: "play" },
    { key: "questions",  field: null,          icon: "chat",      generable: false, count: false, view: "assistant" },
  ];
  var GENERABLE = RESOURCES.filter(function(r){ return r.generable && !r.alias; }).map(function(r){ return r.key; });
  /* Clés reconnues par la file : les quatre du hub + les questions de révision
     (5ᵉ étape du pipeline d'import, qui n'a pas de carte propre). */
  var QUEUE_KEYS = GENERABLE.concat(["reviewQuestions", "enrich_quiz", "enrich_flashcards"]);
  /* Motifs d'échec qui signifient « l'assistant IA n'est pas là » : la préparation reprendra seule. */
  var AI_WAIT_CODES = ["AI_UNAVAILABLE", "AI_LOADING"];

  function meta(key){
    for(var i = 0; i < RESOURCES.length; i++) if(RESOURCES[i].key === key) return RESOURCES[i];
    return null;
  }

  /* ── 1. RÉFÉRENCE STABLE D'UN COURS ─────────────────────────────────────── */
  /* Jamais de recherche par titre : uniquement les identifiants stockés. */
  function courseRef(ch){
    if(!ch || !ch.id) return null;
    return { courseId: ch.id, chapterId: ch.id, subjectId: ch.subjectId || null };
  }

  /* ── 2. DONNÉES RÉELLEMENT PRÉSENTES ────────────────────────────────────── */
  function hasText(v){ return typeof v === "string" && v.trim().length > 0; }
  function dataCount(ch, key){
    var m = meta(key);
    if(!ch || !m || !m.field) return 0;
    var v = ch[m.field];
    if(m.count) return Array.isArray(v) ? v.length : 0;
    return hasText(v) ? 1 : 0;
  }
  function hasData(ch, key){ return dataCount(ch, key) > 0; }

  /* Un cours a une SOURCE s'il a un PDF/fichier conservé ou un texte d'origine :
     c'est ce qui distingue « chapitre vide » de « cours importé pas encore traité ». */
  function sourceKind(ch){
    if(!ch) return "none";
    if(ch.hasOriginalFile) return "file";
    if(hasText(ch.originalText)) return "text";
    return "none";
  }

  /* ── 3. LA FILE — un objet simple, gardé par la page dans `state` ─────────
       { current: {chapterId, key} | null,
         queue:   [{chapterId, key}, …],
         errors:  { chapterId: { key: {code, message} } },
         running: boolean }
     Un seul travail à la fois (`current`) : c'est la garantie « un seul travail
     WebLLM ». Toutes les fonctions ci-dessous sont pures sur cet objet. */
  function newGen(){ return { current: null, queue: [], errors: {}, running: false, waiting: {} }; }

  function isQueued(gen, chapterId, key){
    return gen.queue.some(function(t){ return t.chapterId === chapterId && t.key === key; });
  }
  function isRunning(gen, chapterId, key){
    return !!gen.current && gen.current.chapterId === chapterId && gen.current.key === key;
  }
  /* Ajoute des ressources à générer. Renvoie celles qui ont VRAIMENT été
     ajoutées : déjà en file ou en cours = ignorées (aucun double lancement).
     Une nouvelle demande efface l'erreur précédente de la ressource. */
  function enqueue(gen, chapterId, keys){
    var added = [];
    (keys || []).forEach(function(key){
      if(QUEUE_KEYS.indexOf(key) < 0) return;
      if(isQueued(gen, chapterId, key) || isRunning(gen, chapterId, key)) return;
      if(added.indexOf(key) >= 0) return;
      gen.queue.push({ chapterId: chapterId, key: key });
      if(gen.errors[chapterId]) delete gen.errors[chapterId][key];
      added.push(key);
    });
    return added;
  }
  /* Prend le prochain travail — seulement si rien ne tourne déjà. */
  function takeNext(gen){
    if(gen.current || !gen.queue.length) return null;
    gen.current = gen.queue.shift();
    return gen.current;
  }
  /* Termine le travail en cours. `error` = null si réussi, sinon {code, message}. */
  function complete(gen, task, error){
    if(gen.current && task && gen.current.chapterId === task.chapterId && gen.current.key === task.key) gen.current = null;
    if(error){
      gen.errors[task.chapterId] = gen.errors[task.chapterId] || {};
      gen.errors[task.chapterId][task.key] = { code: error.code || "GENERATION_FAILED", message: error.message || "" };
    }
  }
  /* L'IA n'est pas disponible : tout ce qui attendait pour ce cours échoue
     proprement (avec le même motif), rien ne reste « en préparation » à vie. */
  function failQueuedFor(gen, chapterId, error){
    var rest = [];
    gen.queue.forEach(function(t){
      if(t.chapterId === chapterId){
        gen.errors[chapterId] = gen.errors[chapterId] || {};
        gen.errors[chapterId][t.key] = { code: error.code, message: error.message || "" };
      } else rest.push(t);
    });
    gen.queue = rest;
    if(AI_WAIT_CODES.indexOf(error.code) >= 0){ gen.waiting = gen.waiting || {}; gen.waiting[chapterId] = true; }
  }
  /* Cours dont la préparation attend l'assistant IA. */
  function hasWaiting(gen){ return !!gen.waiting && Object.keys(gen.waiting).length > 0; }
  function takeWaiting(gen){ var ids = Object.keys(gen.waiting || {}); gen.waiting = {}; return ids; }
  /* Les ressources à relancer pour un cours : celles qui ont échoué faute d'IA. */
  function resumeKeys(gen, chapterId){
    var errs = gen.errors[chapterId] || {};
    return Object.keys(errs).filter(function(k){ return AI_WAIT_CODES.indexOf(errs[k].code) >= 0; });
  }
  function clearError(gen, chapterId, key){
    if(gen.errors[chapterId]) delete gen.errors[chapterId][key];
  }
  function busyFor(gen, chapterId){
    return (!!gen.current && gen.current.chapterId === chapterId) || gen.queue.some(function(t){ return t.chapterId === chapterId; });
  }

  /* ── 4. L'ÉTAT D'UNE RESSOURCE ──────────────────────────────────────────────
     Règles, dans cet ordre :
       • des données existent          → READY (on NE régénère JAMAIS d'office ;
                                          une régénération garde l'ancienne version)
       • un travail est en cours       → GENERATING
       • un travail attend             → QUEUED
       • le dernier essai a échoué     → ERROR
       • sinon                         → NOT_GENERATED
     `simplified` : READY, mais produit sans IA (mode simplifié du chapitre). */
  function resourceState(ch, gen, key, flags){
    var m = meta(key);
    if(!m) return null;
    if(!m.generable) return { key: key, state: "READY", count: 0, simplified: false, stale: false, error: null, kind: m.view };
    var qk = m.alias || key;                      // clé de la file / des erreurs (Quiz Flash → quiz)
    var count = dataCount(ch, key);
    var id = ch && ch.id;
    var stale = !!(flags && flags.stale && flags.stale[key]);
    if(count > 0) return { key: key, state: "READY", count: count, simplified: !!ch.heuristicMode, stale: stale, error: null, kind: m.view };
    if(gen && isRunning(gen, id, qk)) return { key: key, state: "GENERATING", count: 0, simplified: false, stale: false, error: null, kind: m.view };
    if(gen && isQueued(gen, id, qk)) return { key: key, state: "QUEUED", count: 0, simplified: false, stale: false, error: null, kind: m.view };
    var err = gen && gen.errors[id] && gen.errors[id][qk];
    if(err) return { key: key, state: "ERROR", count: 0, simplified: false, stale: false, error: err, kind: m.view };
    return { key: key, state: "NOT_GENERATED", count: 0, simplified: false, stale: false, error: null, kind: m.view };
  }
  function allStates(ch, gen, flags){
    return RESOURCES.map(function(r){ return resourceState(ch, gen, r.key, flags); });
  }

  /* Libellé court de l'état — CLÉ de traduction + variables ; jamais de nombre
     qui ne serait pas réellement connu. */
  function statusLabel(st){
    if(!st) return { key: "", vars: {} };
    if(st.key === "questions") return { key: "hub.state.ask", vars: {} };
    if(st.state === "READY"){
      if(st.stale) return { key: "hub.state.stale", vars: {} };
      if(st.key === "quizflash") return { key: "hub.state.flash_ready", vars: {} };
      if(st.key === "quiz") return { key: st.count === 1 ? "hub.state.quiz_one" : "hub.state.quiz_n", vars: { n: st.count } };
      if(st.key === "flashcards") return { key: st.count === 1 ? "hub.state.cards_one" : "hub.state.cards_n", vars: { n: st.count } };
      return { key: (st.simplified ? "hub.state.simple_" : "hub.state.ready_") + st.key, vars: {} };
    }
    return { key: "hub.state." + st.state, vars: {} };
  }
  /* Enregistre un échec connu d'ailleurs (ex. une étape de l'import qui a échoué
     avant l'arrivée sur la page du cours) : la ressource affichera ERROR. */
  function recordError(gen, chapterId, key, error){
    if(QUEUE_KEYS.indexOf(key) < 0) return;
    gen.errors[chapterId] = gen.errors[chapterId] || {};
    gen.errors[chapterId][key] = { code: (error && error.code) || "GENERATION_FAILED", message: (error && error.message) || "" };
  }

  /* Ce que « Générer tout » doit demander : les clés manquantes fournies par le
     pipeline existant (coursePendingStepKeys), sans doublon ni clé inconnue, et
     JAMAIS ce qui tourne déjà. */
  function keysForGenerateAll(pendingKeys, gen, chapterId){
    return (pendingKeys || []).filter(function(k, i, arr){
      return QUEUE_KEYS.indexOf(k) >= 0 && arr.indexOf(k) === i && !isQueued(gen, chapterId, k) && !isRunning(gen, chapterId, k);
    });
  }

  global.RevemHub = {
    STATES: STATES, RESOURCES: RESOURCES, GENERABLE: GENERABLE, QUEUE_KEYS: QUEUE_KEYS,
    meta: meta, courseRef: courseRef, hasData: hasData, dataCount: dataCount, sourceKind: sourceKind, hasText: hasText,
    newGen: newGen, isQueued: isQueued, isRunning: isRunning, enqueue: enqueue, takeNext: takeNext,
    complete: complete, failQueuedFor: failQueuedFor, hasWaiting: hasWaiting, takeWaiting: takeWaiting, resumeKeys: resumeKeys, clearError: clearError, recordError: recordError, busyFor: busyFor,
    resourceState: resourceState, allStates: allStates, statusLabel: statusLabel, keysForGenerateAll: keysForGenerateAll,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
