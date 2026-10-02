/* ============================================================================
   knowledge-engine.js — REV-EM KNOWLEDGE ENGINE (V1) : la logique PURE
   ----------------------------------------------------------------------------
   `globalThis.RevemKnowledge` — même patron que assistant-core.js, ai-engine.js,
   revision-bank.js… : aucune dépendance au DOM, à `state`, à WebLLM ni au réseau.
   Testable sous Node : `node tests/knowledge-engine.test.js`.

   CE QUE C'EST : un petit moteur qui, AVANT la génération, choisit dans une base
   de connaissances pédagogiques structurées les quelques éléments réellement
   pertinents pour la question, et les met en forme de façon compacte.
   CE QUE CE N'EST PAS : un RAG sur les cours de l'élève (Mes cours : autre chose,
   non implémenté), ni un accès Web, ni un moteur sémantique. Aucun appel LLM :
   tout est déterministe, testable, explicable score par score.

   LES DONNÉES ne vivent PAS ici : fichiers JSON versionnés dans Git (`ai-knowledge/`).
   Ajouter une connaissance = ajouter un fichier JSON + une ligne dans le manifeste.
   Ce fichier ne change pas. Voir ai-knowledge/README.md et AI_KNOWLEDGE.md.

   LA CHAÎNE :
     question ─▶ retrieve ─▶ { selected, scores, topics, withheld }      (ce fichier)
              ─▶ toBlocks ─▶ blocs « complet » / « compact »             (ce fichier)
              ─▶ RevemAssistant.buildGeneralPrompt ─▶ choisit ce qui TIENT dans le budget

   RÈGLES DE CONFIANCE (skill revem-knowledge-quality) :
     • un élément n'est injecté que si `isInjectable` le permet : vérifié, ou — seulement
       en mode « démo » explicite — `status:"demo"`. Un brouillon n'est jamais injecté ;
     • un élément non vérifié est ÉTIQUETÉ comme tel dans le contexte envoyé au modèle ;
     • une source n'apparaît que si elle existe dans les métadonnées de l'élément.
   ============================================================================ */
(function(global){
  "use strict";

  var SCHEMA_VERSION = 1;
  var DOMAINS  = ["finance", "economics", "accounting", "mathematics", "statistics", "marketing", "management"];
  var STATUSES = ["demo", "draft", "reviewed"];
  var LEVELS   = ["beginner", "intermediate", "advanced"];
  /* L'analyseur de questions (assistant-core.js) utilise « math » / « stats » : on traduit, sans le dupliquer. */
  var ANALYZER_DOMAIN = { mathematics: "math", statistics: "stats" };
  var KNOWLEDGE_DOMAIN = { math: "mathematics", stats: "statistics" };

  /* Points de score — l'ordre EST la spécification :
     concept exact > alias > sujet > mot-clé fort > concept lié > domaine générique. */
  var SCORE = {
    concept: 100,        // le titre de l'élément figure dans la question
    alias: 80,           // un de ses alias (toutes langues)
    topicPrimary: 40,    // son sujet principal figure dans la question
    topicOther: 30,      // un de ses autres sujets
    keyword: 15,         // chaque mot-clé fort (plafonné)
    keywordCap: 45,
    related: 10,         // l'élément est lié à un élément déjà très bien classé (jamais suffisant seul)
    domain: 10,          // même domaine que la question (jamais suffisant seul)
    shortAlias: 35,      // alias/sujet de 1 à 3 lettres (« van », « tri ») SANS corroboration : trop ambigu
    shortTopic: 15,
    context: 0.8,        // facteur pour ce qui vient de la CONVERSATION et non de la question elle-même
  };
  var MIN_SCORE = 40;          // en dessous : « NO KNOWLEDGE » — la réponse WebLLM reste normale
  var RELATIVE_CUTOFF = 0.45;  // un élément doit valoir au moins 45 % du meilleur
  var TOP_K = { rapide: 2, avance: 3, expert: 3 };
  var MAX_K = 5;

  /* ── 1. TEXTE ─────────────────────────────────────────────────────────────
     Normalisation UNIQUE, appliquée aux données ET aux questions : minuscules, sans accents,
     apostrophes et ponctuation → espaces, pluriels élémentaires retirés (« obligations »
     = « obligation », « taux » = « tau » des deux côtés : seule la COHÉRENCE compte). */
  function fold(s){
    s = String(s == null ? "" : s);
    var out = "";
    for(var i = 0; i < s.length; i++){
      var ch = s.charAt(i).toLowerCase();
      if(ch.charCodeAt(0) > 127 && ch.normalize) ch = ch.normalize("NFD").charAt(0);
      out += ch;
    }
    return out;
  }
  function stem(w){ return (w.length > 3 && /[sx]$/.test(w)) ? w.slice(0, -1) : w; }
  function tokens(s){
    var parts = fold(s).split(/[^a-z0-9]+/), out = [];
    for(var i = 0; i < parts.length; i++) if(parts[i]) out.push(stem(parts[i]));
    return out;
  }
  function norm(s){ return tokens(s).join(" "); }
  function estimateTokens(s){ return Math.ceil(String(s || "").length / 3.2); }   // même règle que RevemAssistant
  function isShort(phrase){ return phrase.indexOf(" ") < 0 && phrase.length <= 3; }
  function uniq(a){ var seen = {}, out = []; (a || []).forEach(function(x){ if(!seen[x]){ seen[x] = 1; out.push(x); } }); return out; }
  function arr(x){ return Array.isArray(x) ? x : []; }
  function str(x){ return typeof x === "string" ? x : ""; }

  /* ── 2. SCHÉMA ET VALIDATION ─────────────────────────────────────────────── */
  var ID_RE = /^[a-z]+(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;     // « finance.npv », « statistics.normal-distribution »

  /* validateItem(item, ctx) → { errors:[], warnings:[] }
     ctx : { topics: lexique {id: {…}} (facultatif) }. Ne touche à rien. */
  function validateItem(item, ctx){
    ctx = ctx || {};
    var e = [], w = [];
    if(!item || typeof item !== "object"){ return { errors: ["élément absent ou non objet"], warnings: [] }; }
    var id = str(item.id);
    if(!id) e.push("id manquant");
    else if(!ID_RE.test(id)) e.push("id invalide « " + id + " » (attendu : domaine.nom-en-kebab, ex. finance.npv)");
    if(DOMAINS.indexOf(item.domain) < 0) e.push("domain invalide « " + item.domain + " » (" + DOMAINS.join(", ") + ")");
    else if(id && id.split(".")[0] !== item.domain) e.push("l'id « " + id + " » ne commence pas par son domaine « " + item.domain + " »");
    if(!str(item.title).trim()) e.push("title manquant");
    if(!str(item.topic).trim()) e.push("topic manquant");
    if(!str(item.summary).trim()) e.push("summary manquant");
    ["aliases", "keywords", "facts", "mechanisms", "formulas", "examples", "commonMistakes", "relatedConcepts", "sources", "topics", "avoid"].forEach(function(k){
      if(item[k] !== undefined && !Array.isArray(item[k])) e.push(k + " doit être un tableau");
    });
    if(item.level !== undefined && LEVELS.indexOf(item.level) < 0) e.push("level invalide « " + item.level + " »");
    if(item.status !== undefined && STATUSES.indexOf(item.status) < 0) e.push("status invalide « " + item.status + " »");
    if(typeof item.verified !== "boolean") e.push("verified doit être true ou false (jamais absent)");
    if(!(typeof item.version === "number" && item.version >= 1 && Math.floor(item.version) === item.version)) e.push("version doit être un entier ≥ 1");
    if(typeof item.timeSensitive !== "boolean") e.push("timeSensitive doit être true ou false");
    if(item.lastReviewed !== null && item.lastReviewed !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(item.lastReviewed))) e.push("lastReviewed doit être null ou une date AAAA-MM-JJ");

    // — le contenu ne doit pas être vide de sens
    if(!arr(item.aliases).length && !arr(item.keywords).length) w.push("ni alias ni mots-clés : l'élément ne sera presque jamais retrouvé");
    arr(item.formulas).forEach(function(f, i){
      if(!(typeof f === "string" && f.trim()) && !(f && typeof f === "object" && str(f.expression).trim())) e.push("formulas[" + i + "] : chaîne ou { name, expression }");
    });
    arr(item.sources).forEach(function(s, i){
      if(!s || typeof s !== "object" || !str(s.name).trim() || !str(s.type).trim()) e.push("sources[" + i + "] : { name, type, reference? } exigés — jamais une source inventée");
    });

    // — provenance et confiance (skill revem-knowledge-quality)
    if(item.verified === true){
      if(!arr(item.sources).length) e.push("verified:true exige au moins une source réelle");
      if(!item.lastReviewed) e.push("verified:true exige lastReviewed");
      if(item.status === "demo") e.push("un élément status:\"demo\" ne peut pas être verified:true");
    } else if(item.verified === false){
      if(!arr(item.sources).length) w.push("aucune source : provenance manquante (acceptable seulement tant que verified:false)");
    }
    if(item.timeSensitive === true && !item.lastReviewed) w.push("timeSensitive sans lastReviewed : impossible de dire de quand date l'information");

    // — taille : un élément doit rester récupérable seul
    var t = estimateTokens(formatItem(item, "full"));
    if(t > 600) w.push("élément long (≈" + t + " jetons en version complète) : le découper en éléments atomiques");

    // — références
    if(ctx.topics){
      var tp = [item.topic].concat(arr(item.topics));
      tp.forEach(function(x){ if(x && !ctx.topics[x]) e.push("sujet inconnu « " + x + " » : l'ajouter à ai-knowledge/topics.json"); });
      if(item.topic && arr(item.topics).length && arr(item.topics).indexOf(item.topic) < 0) w.push("topic principal absent de topics[]");
    }
    return { errors: e, warnings: w };
  }

  /* validatePack(items, lexicon) → { ok, errors:[«id : message»], warnings:[…], stats }
     Vérifie : schéma, id en double, références cassées, alias partagés, doublons de concept. */
  function validatePack(items, lexicon){
    var errors = [], warnings = [], ids = {}, titles = {}, aliasOwner = {};
    var topics = lexicon && lexicon.topics ? lexicon.topics : null;
    var list = arr(items);
    list.forEach(function(it, i){
      var label = (it && it.id) || ("#" + i);
      var r = validateItem(it, { topics: topics });
      r.errors.forEach(function(m){ errors.push(label + " : " + m); });
      r.warnings.forEach(function(m){ warnings.push(label + " : " + m); });
      if(!it || !it.id) return;
      if(ids[it.id]) errors.push(it.id + " : id en double"); ids[it.id] = true;
      var tn = norm(it.title);
      if(tn){ if(titles[tn] && titles[tn] !== it.id) errors.push(it.id + " : même titre que " + titles[tn] + " (doublon de concept)"); titles[tn] = it.id; }
      uniq(arr(it.aliases).map(norm).concat([tn])).forEach(function(a){
        if(!a) return;
        if(aliasOwner[a] && aliasOwner[a] !== it.id) warnings.push(it.id + " : l'alias « " + a + " » est aussi utilisé par " + aliasOwner[a] + " (ambiguïté)");
        else aliasOwner[a] = it.id;
      });
    });
    list.forEach(function(it){
      if(!it || !it.id) return;
      arr(it.relatedConcepts).forEach(function(r){ if(!ids[r]) errors.push(it.id + " : relatedConcepts référence « " + r + " » qui n'existe pas"); if(r === it.id) errors.push(it.id + " : s'auto-référence"); });
    });
    var stats = { items: list.length, verified: list.filter(function(x){ return x && x.verified === true; }).length,
                  demo: list.filter(function(x){ return x && x.status === "demo"; }).length,
                  timeSensitive: list.filter(function(x){ return x && x.timeSensitive === true; }).length,
                  withSources: list.filter(function(x){ return x && arr(x.sources).length > 0; }).length };
    return { ok: errors.length === 0, errors: errors, warnings: warnings, stats: stats };
  }

  /* validateLexicon(lexicon) → { ok, errors }  — { version, topics: { id: { domain, terms:[…] } } } */
  function validateLexicon(lex){
    var errors = [];
    if(!lex || typeof lex !== "object" || !lex.topics || typeof lex.topics !== "object"){ return { ok: false, errors: ["lexique absent : { version, topics }"] }; }
    Object.keys(lex.topics).forEach(function(id){
      var t = lex.topics[id];
      if(!/^[a-z][a-z0-9_]*$/.test(id)) errors.push(id + " : identifiant de sujet invalide (snake_case)");
      if(!t || DOMAINS.indexOf(t.domain) < 0) errors.push(id + " : domain invalide");
      if(!t || !arr(t.terms).length) errors.push(id + " : aucun terme");
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ── 3. CONFIANCE : qu'a-t-on le droit d'envoyer au modèle ? ────────────────
     policy.mode : « auto » (éléments VÉRIFIÉS seulement — défaut), « demo » (+ éléments de démonstration,
     pour tester le moteur), « off » (rien). Un brouillon (status:"draft") n'est JAMAIS injecté. */
  function isInjectable(item, policy){
    var mode = policy && policy.mode ? policy.mode : "auto";
    if(mode === "off") return false;
    if(!item) return false;
    if(item.verified === true && item.status !== "demo") return true;
    if(mode === "demo" && item.status === "demo") return true;
    return false;
  }

  /* ── 4. INDEX — construit UNE fois, réutilisé pour chaque question ─────────── */
  function buildIndex(items, lexicon){
    var list = arr(items).filter(function(x){ return x && x.id; });
    var idx = { items: list, byId: {}, meta: {}, phrases: {}, topicTerms: {}, topicInfo: {}, maxN: 1, size: list.length, builtAt: 0, version: SCHEMA_VERSION };
    function addPhrase(phrase, id, kind){
      if(!phrase) return;
      var slot = idx.phrases[phrase] || (idx.phrases[phrase] = []);
      for(var i = 0; i < slot.length; i++) if(slot[i].id === id){ if(rank(kind) > rank(slot[i].kind)) slot[i].kind = kind; return; }
      slot.push({ id: id, kind: kind });
      var n = phrase.split(" ").length; if(n > idx.maxN) idx.maxN = n;
    }
    function rank(k){ return k === "concept" ? 3 : k === "alias" ? 2 : 1; }
    list.forEach(function(it){
      idx.byId[it.id] = it;
      addPhrase(norm(it.title), it.id, "concept");
      arr(it.aliases).forEach(function(a){ addPhrase(norm(a), it.id, "alias"); });
      arr(it.keywords).forEach(function(k){ addPhrase(norm(k), it.id, "keyword"); });
      idx.meta[it.id] = { avoid: arr(it.avoid).map(norm).filter(Boolean), topics: uniq([it.topic].concat(arr(it.topics)).filter(Boolean)) };
    });
    var topics = lexicon && lexicon.topics ? lexicon.topics : {};
    Object.keys(topics).forEach(function(tid){
      idx.topicInfo[tid] = { domain: topics[tid].domain };
      arr(topics[tid].terms).forEach(function(term){
        var p = norm(term); if(!p) return;
        var slot = idx.topicTerms[p] || (idx.topicTerms[p] = []);
        if(slot.indexOf(tid) < 0) slot.push(tid);
        var n = p.split(" ").length; if(n > idx.maxN) idx.maxN = n;
      });
    });
    return idx;
  }

  /* n-grammes d'une suite de jetons (1..maxN mots), du plus long au plus court */
  function ngrams(toks, maxN){
    var out = [];
    for(var n = Math.min(maxN, toks.length); n >= 1; n--)
      for(var i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(" "));
    return out;
  }

  /* detectTopics(text, index, opts) → [ { id, domain } ] — les sujets de la question (analyse, sans LLM).
     opts.domain : domaine de la question (nomenclature de l'analyseur) — il corrobore les termes très courts. */
  function detectTopics(text, index, opts){
    opts = opts || {};
    if(!index) return [];
    var dom = KNOWLEDGE_DOMAIN[opts.domain] || opts.domain || "general";
    var found = {}, order = [];
    ngrams(tokens(text), index.maxN).forEach(function(g){
      var tids = index.topicTerms[g]; if(!tids) return;
      tids.forEach(function(tid){
        if(isShort(g) && dom !== (index.topicInfo[tid] || {}).domain) return;        // « tri » (sorting) ≠ « TRI »
        if(!found[tid]){ found[tid] = 1; order.push({ id: tid, domain: (index.topicInfo[tid] || {}).domain }); }
      });
    });
    return order;
  }

  /* ── 5. RETRIEVAL ───────────────────────────────────────────────────────────
     retrieve(question, opts) → {
       selected:[{ id, score, reasons, injectable:true }], candidates, topics:[ids], withheld:[{id,score,why}],
       none, minScore, k, ms }
     opts : { index, domain (analyseur), contextText (sujet de la conversation, facultatif), tier, k, minScore, policy } */
  function retrieve(question, opts){
    var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
    opts = opts || {};
    var index = opts.index;
    var res = { selected: [], candidates: 0, topics: [], withheld: [], none: true, minScore: opts.minScore || MIN_SCORE, k: 0, ms: 0 };
    if(!index || !index.size || !String(question || "").trim()){ res.ms = elapsed(t0); return res; }
    var dom = KNOWLEDGE_DOMAIN[opts.domain] || opts.domain || "general";
    var k = Math.min(MAX_K, opts.k || TOP_K[opts.tier] || TOP_K.avance);
    var min = opts.minScore || MIN_SCORE;
    res.k = k;

    var qToks = tokens(question);
    var qNorm = " " + qToks.join(" ") + " ";
    var cToks = opts.contextText ? tokens(opts.contextText) : [];
    var qTopics = detectTopics(question, index, { domain: opts.domain });
    var cTopics = cToks.length ? detectTopics(opts.contextText, index, { domain: opts.domain }) : [];
    res.topics = uniq(qTopics.map(function(t){ return t.id; }).concat(cTopics.map(function(t){ return t.id; })));
    var qTopicSet = {}, cTopicSet = {};
    qTopics.forEach(function(t){ qTopicSet[t.id] = 1; }); cTopics.forEach(function(t){ cTopicSet[t.id] = 1; });

    // 1) phrases (concept / alias / mot-clé) de la question, puis du contexte de conversation
    var hits = {};     // id → { concept, alias, shortAlias, keywords:{phrase:factor}, fromContext }
    function collect(toksArr, factor){
      ngrams(toksArr, index.maxN).forEach(function(g){
        var slot = index.phrases[g]; if(!slot) return;
        slot.forEach(function(h){
          var o = hits[h.id] || (hits[h.id] = { concept: 0, alias: 0, shortAlias: 0, keywords: {} });
          if(h.kind === "concept") o.concept = Math.max(o.concept, factor);
          else if(h.kind === "alias"){ if(isShort(g)) o.shortAlias = Math.max(o.shortAlias, factor); else o.alias = Math.max(o.alias, factor); }
          else o.keywords[g] = Math.max(o.keywords[g] || 0, factor);
        });
      });
    }
    collect(qToks, 1);
    if(cToks.length) collect(cToks, SCORE.context);

    // 2) score de chaque élément touché ; les éléments touchés par un sujet seul aussi
    var scored = {};
    function ensure(id){ return scored[id] || (scored[id] = { id: id, score: 0, reasons: {} }); }
    index.items.forEach(function(it){
      var h = hits[it.id];
      var s = 0, why = {};
      var avoided = false, meta = index.meta[it.id];
      for(var a = 0; a < meta.avoid.length; a++) if(qNorm.indexOf(" " + meta.avoid[a] + " ") >= 0){ avoided = true; break; }
      if(avoided) return;
      // sujets
      var topicPts = 0, topicWhy = [];
      meta.topics.forEach(function(tid){
        var inQ = qTopicSet[tid], inC = !inQ && cTopicSet[tid];
        if(!inQ && !inC) return;
        var pts = (tid === it.topic) ? SCORE.topicPrimary : SCORE.topicOther;
        topicPts += inQ ? pts : Math.round(pts * SCORE.context); topicWhy.push(tid);
      });
      var domOk = it.domain === dom;
      if(h){
        if(h.concept){ s += Math.round(SCORE.concept * h.concept); why.concept = true; }
        if(h.alias){ var a1 = Math.round(SCORE.alias * h.alias); if(a1 > 0){ if(!why.concept) s += a1; why.alias = true; } }
        if(h.shortAlias){
          var corroborated = domOk || topicPts > 0 || Object.keys(h.keywords).length > 0;
          var sa = Math.round((corroborated ? SCORE.alias : SCORE.shortAlias) * h.shortAlias);
          if(!why.concept && !why.alias) s += sa; why.alias = true; if(!corroborated) why.weak = true;
        }
        var kn = Object.keys(h.keywords);
        if(kn.length){ var kp = 0; kn.forEach(function(kw){ kp += Math.round(SCORE.keyword * h.keywords[kw]); }); s += Math.min(SCORE.keywordCap, kp); why.keywords = kn.length; }
      }
      if(topicPts){ s += topicPts; why.topic = topicWhy; }
      if(s > 0 && domOk){ s += SCORE.domain; why.domain = true; }
      if(s > 0){ var o = ensure(it.id); o.score = s; o.reasons = why; }
    });
    // 3) « concept lié » : bonus pour les voisins d'un élément déjà très bien classé (jamais suffisant seul)
    var strong = Object.keys(scored).filter(function(id){ return scored[id].score >= SCORE.alias; });
    strong.forEach(function(sid){
      var it = index.byId[sid];
      arr(it.relatedConcepts).forEach(function(rid){ if(scored[rid] && !scored[rid].reasons.related){ scored[rid].score += SCORE.related; scored[rid].reasons.related = sid; } });
      index.items.forEach(function(o){ if(o.id !== sid && arr(o.relatedConcepts).indexOf(sid) >= 0 && scored[o.id] && !scored[o.id].reasons.related){ scored[o.id].score += SCORE.related; scored[o.id].reasons.related = sid; } });
    });

    var all = Object.keys(scored).map(function(id){ return scored[id]; });
    res.candidates = all.length;
    all.sort(function(a, b){ return b.score - a.score || (a.id < b.id ? -1 : 1); });
    var top = all.length ? all[0].score : 0;
    all.forEach(function(c){
      if(c.score < min || c.score < top * RELATIVE_CUTOFF) return;
      var it = index.byId[c.id];
      if(!isInjectable(it, opts.policy)){
        res.withheld.push({ id: c.id, score: c.score, why: (opts.policy && opts.policy.mode === "off") ? "off" : (it.status === "demo" ? "demo" : it.verified ? "n/a" : "unverified") });
        return;
      }
      if(res.selected.length < k) res.selected.push({ id: c.id, score: c.score, reasons: c.reasons, injectable: true });
    });
    res.none = res.selected.length === 0;
    res.ms = elapsed(t0);
    return res;
  }
  function elapsed(t0){ var n = (global.performance && performance.now) ? performance.now() : Date.now(); return Math.round((n - t0) * 100) / 100; }

  /* ── 6. MISE EN FORME — contexte COMPACT, jamais le JSON brut ────────────── */
  function formulaText(f){
    if(typeof f === "string") return f;
    return (f.name ? f.name + " : " : "") + f.expression + (f.note ? " (" + f.note + ")" : "");
  }
  function head(arr_, n){ return arr(arr_).slice(0, n); }
  /* detail : « full » (idée, faits, mécanismes, formules, exemple, erreurs) | « compact » (idée, UN mécanisme, UNE formule). */
  function formatItem(item, detail){
    var L = [];
    L.push("Concept: " + item.title + (item.level ? " (" + item.level + ")" : ""));
    L.push("Key idea: " + item.summary);
    if(detail === "full") head(item.facts, 2).forEach(function(x){ L.push("Fact: " + x); });
    head(item.mechanisms, detail === "full" ? 2 : 1).forEach(function(x){ L.push("Mechanism: " + x); });
    head(item.formulas, detail === "full" ? 2 : 1).forEach(function(x){ L.push("Formula: " + formulaText(x)); });
    if(detail === "full"){
      head(item.examples, 1).forEach(function(x){ L.push("Example: " + x); });
      head(item.commonMistakes, 2).forEach(function(x){ L.push("Common mistake: " + x); });
    }
    var srcs = arr(item.sources).filter(function(s){ return s && s.name; });
    if(srcs.length) L.push("Source: " + srcs.map(function(s){ return s.name + (s.reference ? " — " + s.reference : "") + " (" + s.type + ")"; }).join("; "));
    if(item.timeSensitive) L.push("Time-sensitive: may be outdated" + (item.lastReviewed ? " (last reviewed " + item.lastReviewed + ")" : "") + "; never present it as current.");
    if(item.verified !== true) L.push("Status: UNVERIFIED " + (item.status === "demo" ? "demo" : "draft") + " content — use as a hint, do not treat as authoritative.");
    return L.join("\n");
  }

  /* toBlocks(selected, index) → [ { id, score, full, compact, fullTokens, compactTokens, verified, timeSensitive, hasSource } ]
     Le CHOIX de ce qui tient dans le budget se fait dans assistant-core (un seul budget central). */
  function toBlocks(selected, index){
    return arr(selected).map(function(s){
      var it = index.byId[s.id];
      var full = formatItem(it, "full"), compact = formatItem(it, "compact");
      return { id: it.id, score: s.score, full: full, compact: compact, fullTokens: estimateTokens(full), compactTokens: estimateTokens(compact),
               verified: it.verified === true, timeSensitive: it.timeSensitive === true, hasSource: arr(it.sources).length > 0 };
    });
  }

  /* parsePack(files) : { manifest, lexicon, items } → { index, report } — chargement d'un lot déjà lu (la page lit les fichiers). */
  function loadPack(lexicon, items){
    var report = validatePack(items, lexicon);
    var lex = validateLexicon(lexicon);
    // un élément invalide n'entre JAMAIS dans l'index (jamais de demi-connaissance servie au modèle)
    var bad = {};
    report.errors.forEach(function(m){ bad[m.split(" : ")[0]] = true; });
    var good = arr(items).filter(function(it){ return it && it.id && !bad[it.id]; });
    return { index: buildIndex(good, lexicon), report: report, lexiconOk: lex.ok, lexiconErrors: lex.errors, rejected: Object.keys(bad) };
  }

  global.RevemKnowledge = {
    SCHEMA_VERSION: SCHEMA_VERSION, DOMAINS: DOMAINS, STATUSES: STATUSES, LEVELS: LEVELS, SCORE: SCORE, MIN_SCORE: MIN_SCORE, TOP_K: TOP_K,
    ANALYZER_DOMAIN: ANALYZER_DOMAIN, KNOWLEDGE_DOMAIN: KNOWLEDGE_DOMAIN,
    norm: norm, tokens: tokens, estimateTokens: estimateTokens,
    validateItem: validateItem, validatePack: validatePack, validateLexicon: validateLexicon,
    isInjectable: isInjectable, buildIndex: buildIndex, detectTopics: detectTopics, retrieve: retrieve,
    formatItem: formatItem, toBlocks: toBlocks, loadPack: loadPack,
  };
  if(typeof module !== "undefined" && module.exports) module.exports = global.RevemKnowledge;
})(typeof globalThis !== "undefined" ? globalThis : this);
