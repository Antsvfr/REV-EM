/* ============================================================================
   quick-actions.js — « Que veux-tu faire ? »
   ----------------------------------------------------------------------------
   Le moteur qui décide QUELLES actions valent la peine d'être proposées, et
   dans quel ordre. Il ne connaît ni le DOM, ni `state`, ni la navigation : on
   lui donne un CONTEXTE (des chiffres et des booléens, tous vrais) et il rend
   une action principale et deux à quatre actions secondaires.

   Le même découpage que `smart-revision.js`, `statistics.js` et
   `command-center.js` : un moteur pur d'un côté, un branchement de l'autre.
   Conséquence directe : il se teste sous Node en quelques millisecondes, sans
   navigateur (`tests/quick-actions.test.js`).

   TROIS RÈGLES, ET ELLES SONT TENUES PAR LE CODE
   ------------------------------------------------------------------------
   1. Aucune action inutile. Une action dont la condition `when` est fausse
      n'est jamais rendue — même s'il ne reste rien d'autre à afficher.
      « Réviser mes erreurs » n'existe pas sans erreurs ; « Continuer mon
      quiz » n'existe pas sans quiz commencé. On préfère trois actions vraies
      à cinq actions dont deux mentent.
   2. Une hiérarchie, pas une grille. Au plus CINQ actions : une principale,
      quatre secondaires au maximum. C'est un choix, pas un menu.
   3. Pas deux fois la même intention. Au plus DEUX actions par famille
      (reprendre / réviser / planifier / bibliothèque / outil), sinon la zone
      proposerait « Lancer un quiz », « Réviser mes flashcards » et « Passer
      un examen » côte à côte, c'est-à-dire trois fois la même chose.

   POURQUOI UN POIDS PLUTÔT QU'UN ARBRE DE `if`
   ------------------------------------------------------------------------
   Les situations se combinent : on peut avoir un quiz en cours ET des
   erreurs ET un cours récent ET un planning. Un arbre de conditions
   deviendrait illisible au troisième cas. Chaque action porte donc son propre
   poids, éventuellement calculé à partir du contexte — la découverte, par
   exemple, ne pèse lourd que pour un compte vide.
   ========================================================================== */
(function(global){
  "use strict";

  /* Au plus une principale + quatre secondaires. */
  var MAX_TOTAL  = 5;
  /* Au plus deux actions de la même intention. */
  var FAMILY_CAP = 2;

  /* ── LE CATALOGUE ────────────────────────────────────────────────────────
     `when(c)`   : l'action a-t-elle un sens ICI ? Si non, elle n'existe pas.
     `weight(c)` : à quel point elle compte, dans CE contexte.
     `family`    : l'intention, pour ne pas la répéter.
     `icon`      : une clé de DASH_ICONS (index.html) — le moteur ne dessine
                   rien, il nomme.
     Aucun libellé ici : les textes vivent dans translations.js, sous la clé
     `qa.<id>`. Le moteur ne parle aucune langue.                            */
  var CATALOGUE = [
    /* ── REPRENDRE ─────────────────────────────────────────────────────────
       Une session commencée bat tout le reste : rien n'est plus frustrant
       que de perdre un quiz à mi-parcours parce que l'accueil ne le sait
       pas. */
    { id: "quiz_resume",      icon: "play",     family: "resume",
      when:   function(c){ return !!c.quizInProgress; },
      weight: function(){ return 100; } },

    { id: "session_resume",   icon: "target",   family: "resume",
      when:   function(c){ return !!c.sessionInProgress; },
      weight: function(){ return 98; } },

    { id: "flash_resume",     icon: "layers",   family: "resume",
      when:   function(c){ return !!c.flashInProgress; },
      weight: function(){ return 96; } },

    /* ── RÉVISER ─────────────────────────────────────────────────────────── */
    { id: "smart_revision",   icon: "target",   family: "revise",
      when:   function(c){ return c.recoCount > 0; },
      weight: function(){ return 88; } },

    { id: "review_wrong",     icon: "compass",  family: "revise",
      when:   function(c){ return c.wrongCount > 0; },
      weight: function(){ return 80; } },

    { id: "resume_course",    icon: "book",     family: "resume",
      when:   function(c){ return !!c.recentChapter; },
      weight: function(){ return 72; } },

    /* ── PLANIFIER ───────────────────────────────────────────────────────── */
    { id: "study_plan",       icon: "clock",    family: "plan",
      when:   function(c){ return c.planTasksToday > 0; },
      weight: function(){ return 68; } },

    { id: "planning_today",   icon: "calendar", family: "plan",
      when:   function(c){ return c.todayEvents > 0; },
      weight: function(){ return 64; } },

    /* ── LANCER ──────────────────────────────────────────────────────────── */
    { id: "quiz_start",       icon: "target",   family: "revise",
      when:   function(c){ return !c.quizInProgress && c.quizCount > 0; },
      weight: function(c){ return c.hasAnyData ? 56 : 58; } },

    { id: "flash_start",      icon: "layers",   family: "revise",
      when:   function(c){ return !c.flashInProgress && c.flashCount > 0; },
      weight: function(){ return 52; } },

    /* Un examen blanc sur trois questions n'est pas un examen blanc. */
    { id: "exam",             icon: "exam",     family: "revise",
      when:   function(c){ return !c.quizInProgress && c.quizCount >= 10; },
      weight: function(){ return 42; } },

    /* ── CONSTRUIRE SA BIBLIOTHÈQUE ──────────────────────────────────────── */
    { id: "import_course",    icon: "upload",   family: "library",
      when:   function(){ return true; },
      weight: function(c){ return c.hasAnyData ? 34 : 95; } },

    { id: "new_subject",      icon: "plus",     family: "library",
      when:   function(){ return true; },
      weight: function(c){
        if(c.subjectCount === 0) return 90;      /* rien du tout : c'est LA chose à faire */
        return c.hasAnyData ? 28 : 79;
      } },

    { id: "explore_subjects", icon: "book",     family: "library",
      when:   function(c){ return c.subjectCount > 0; },
      weight: function(c){ return c.hasAnyData ? 30 : 78; } },

    /* ── S'ORGANISER ─────────────────────────────────────────────────────── */
    { id: "planning_setup",   icon: "calendar", family: "plan",
      when:   function(c){ return !c.hasPlanning; },
      weight: function(c){ return c.hasAnyData ? 26 : 56; } },

    /* ── OUTIL ───────────────────────────────────────────────────────────── */
    { id: "ai",               icon: "spark",    family: "tool",
      when:   function(c){ return c.aiAvailable !== false; },
      weight: function(){ return 24; } },
  ];

  /* Chaque entrée garde son rang de catalogue : à poids égal, l'ordre
     d'écriture tranche, et le résultat ne dépend donc pas de la stabilité du
     tri du moteur JavaScript. */
  CATALOGUE.forEach(function(a, i){ a.order = i; });

  /* ── LE CONTEXTE ─────────────────────────────────────────────────────────
     Tout est optionnel : un contexte vide décrit un compte vide, et le moteur
     répond quand même quelque chose d'utile. Aucune valeur n'est inventée —
     l'appelant ne passe que ce qu'il a réellement mesuré.                   */
  var DEFAULTS = {
    quizInProgress:    null,   /* {label, index, total} — un quiz commencé, non terminé */
    flashInProgress:   null,   /* {label, index, total} */
    sessionInProgress: null,   /* {kind:"smart"|"planning", index, total} */
    recoCount:         0,      /* getSmartRevisionRecommendations().length */
    wrongCount:        0,      /* poolWrong().length */
    recentChapter:     null,   /* {id, title, type} */
    planTasksToday:    0,      /* tâches non faites du plan de révision, aujourd'hui */
    todayEvents:       0,      /* cours à l'emploi du temps aujourd'hui */
    hasPlanning:       false,  /* un emploi du temps a-t-il été importé ? */
    quizCount:         0,      /* questions réellement disponibles */
    flashCount:        0,      /* cartes réellement disponibles */
    subjectCount:      0,
    aiAvailable:       true,
    hasAnyData:        false,  /* l'utilisateur a-t-il déjà révisé quoi que ce soit ? */
  };

  function num(v){ return (typeof v === "number" && isFinite(v) && v > 0) ? v : 0; }

  function normalizeContext(raw){
    var src = raw || {};
    var c = {};
    Object.keys(DEFAULTS).forEach(function(k){
      var d = DEFAULTS[k];
      if(typeof d === "number")       c[k] = num(src[k]);
      else if(typeof d === "boolean") c[k] = (src[k] === undefined) ? d : !!src[k];
      else                            c[k] = src[k] || null;
    });
    return c;
  }

  /* ── available() ─────────────────────────────────────────────────────────
     TOUT ce qui a un sens dans ce contexte, du plus important au moins
     important. Sans plafond : c'est `pick()` qui choisit. Utile pour tester,
     et pour toute autre surface qui voudrait la liste complète.             */
  function available(rawCtx){
    var c = normalizeContext(rawCtx);
    return CATALOGUE
      .filter(function(a){ return a.when(c); })
      .map(function(a){
        return { id: a.id, icon: a.icon, family: a.family,
                 weight: a.weight(c), order: a.order };
      })
      .sort(function(x, y){ return (y.weight - x.weight) || (x.order - y.order); });
  }

  /* ── pick() ──────────────────────────────────────────────────────────────
     Une action principale, puis les secondaires, en respectant le plafond par
     famille et le plafond total. Si le contexte ne justifie qu'une seule
     action, on n'en rend qu'une : la zone rétrécit, elle ne se remplit pas.  */
  function pick(rawCtx, opts){
    var options   = opts || {};
    var maxTotal  = num(options.max) || MAX_TOTAL;
    var familyCap = (typeof options.familyCap === "number" && options.familyCap > 0)
      ? options.familyCap : FAMILY_CAP;

    var pool  = available(rawCtx);
    var used  = {};
    var taken = [];

    pool.forEach(function(a){
      if(taken.length >= maxTotal) return;
      var n = used[a.family] || 0;
      if(n >= familyCap) return;
      used[a.family] = n + 1;
      taken.push(a);
    });

    return {
      primary:   taken.length ? taken[0] : null,
      secondary: taken.slice(1),
      all:       taken,
    };
  }

  global.LyonQuickActions = {
    CATALOGUE:        CATALOGUE,
    DEFAULTS:         DEFAULTS,
    MAX_TOTAL:        MAX_TOTAL,
    FAMILY_CAP:       FAMILY_CAP,
    normalizeContext: normalizeContext,
    available:        available,
    pick:             pick,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
