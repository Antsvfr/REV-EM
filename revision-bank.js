/* ============================================================================
   revision-bank.js — la BANQUE de révision d'un cours et le SESSION BUILDER
   ----------------------------------------------------------------------------
   `globalThis.RevemBank` — même patron que smart-revision.js, statistics.js,
   command-center.js, quick-actions.js, subject-search.js, ai-engine.js,
   import-center.js et course-hub.js : aucune dépendance au DOM, à `state`, à
   WebLLM ni à Supabase. Testable sous Node : `node tests/revision-bank.test.js`.

   LA DISTINCTION FONDAMENTALE
     BANQUE   = l'ensemble PERSISTANT des questions / cartes d'un cours. Elle est
                créée par l'IA (lots, un seul travail GPU à la fois) puis ne bouge plus.
                Elle vit dans les champs DÉJÀ existants du chapitre (`aiQuiz`,
                `aiFlashcards`, colonnes jsonb `chapters.ai_quiz` / `ai_flashcards`) :
                aucune migration, aucun second système.
     SESSION  = une sélection TEMPORAIRE construite ICI, en JavaScript, à chaque
                clic : instantanée, sans WebLLM, sans réseau. La banque n'est
                JAMAIS modifiée par une session (tout est travaillé sur des copies).

   CE QU'UNE SESSION GARANTIT
     • sélection ET ordre différents d'une session à l'autre (tant que la banque le permet) ;
     • les questions absentes de la session précédente passent d'abord ;
     • couverture : un tour de table par concept (ou par section du cours) ;
     • difficulté mélangée quand elle est connue ;
     • les choix d'un QCM sont mélangés, et l'index de la bonne réponse est
       RECALCULÉ à partir de la permutation (jamais « correct = 1 » figé) ;
     • algorithme : Fisher-Yates, jamais `sort(() => Math.random() - 0.5)`.
   ============================================================================ */
(function(global){
  "use strict";

  /* ── Tailles ──────────────────────────────────────────────────────────────
     QUIZ_SESSION_SIZE = 10 : la taille de la « Révision express » déjà présente
     dans REV-EM (poolExpress(10)). QUIZ_FLASH_SIZE = 5 : le mode court — seul
     chiffre NOUVEAU de cette étape (aucun « Quiz Flash » n'existait). */
  var QUIZ_SESSION_SIZE = 10;
  var QUIZ_FLASH_SIZE   = 5;
  var FLASH_DECK_SIZE   = 15;     // paquet de flashcards : tout si ≤ 15, sinon un tirage de 15
  var MIN_VIABLE        = 3;      // en dessous, une banque n'est pas exploitable
  var REVERSE_RATE      = 0.3;    // part des cartes « inversibles » retournées dans une session
  var BANK_MAX          = 60;     // garde-fou : l'enrichissement ne gonfle pas la banque sans fin
  var QUIZ_BATCH        = 8;      // questions par appel IA (un JSON court = fiable sur un petit modèle)
  var CARD_BATCH        = 10;
  var MAX_BATCHES       = 4;      // jamais plus de 4 appels pour une banque
  var STALE_LEN_RATIO   = 0.15;   // un texte qui change de plus de 15 % de longueur = cours « modifié »

  var DIFFICULTIES = ["easy", "medium", "hard"];
  var TYPES = ["definition", "comprehension", "application", "exemple", "vrai_faux", "association", "calcul", "mcq"];

  /* ── 1. ALÉATOIRE ─────────────────────────────────────────────────────────
     `rng` = fonction () → [0,1). Par défaut : crypto.getRandomValues (uniforme,
     non prévisible) ; repli sur Math.random. Injectable pour les tests. */
  function defaultRng(){
    try{
      var c = global.crypto;
      if(c && typeof c.getRandomValues === "function"){
        var a = new Uint32Array(1); c.getRandomValues(a);
        return a[0] / 4294967296;
      }
    }catch(e){}
    return Math.random();
  }
  /* mulberry32 — graine → rng reproductible (tests). */
  function seededRng(seed){
    var a = seed >>> 0;
    return function(){
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(n, rng){ return Math.floor((rng || defaultRng)() * n); }

  /* Fisher-Yates, sur une COPIE : le tableau reçu n'est jamais modifié. */
  function shuffleArray(arr, rng){
    var r = rng || defaultRng;
    var a = Array.prototype.slice.call(arr || []);
    for(var i = a.length - 1; i > 0; i--){
      var j = Math.floor(r() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  /* ── 2. TEXTE ─────────────────────────────────────────────────────────────── */
  function stripTags(s){ return String(s == null ? "" : s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); }
  function normalizeText(s){
    var t = String(s == null ? "" : s).toLowerCase();
    if(t.normalize) t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return t.replace(/[^a-z0-9]+/g, " ").trim();
  }
  /* FNV-1a 32 bits → base 36. Pas cryptographique : sert d'identifiant stable et
     d'empreinte de contenu, rien de plus. */
  function hashText(s){
    var h = 0x811c9dc5; s = String(s);
    for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function words(s){ return normalizeText(s).split(" ").filter(function(w){ return w.length > 2; }); }
  function jaccard(a, b){
    var A = {}, B = {}, i, inter = 0, union = 0;
    a.forEach(function(w){ A[w] = 1; }); b.forEach(function(w){ B[w] = 1; });
    for(var k in A){ union++; if(B[k]) inter++; }
    for(var k2 in B){ if(!A[k2]) union++; }
    return union ? inter / union : 0;
  }

  /* ── 3. EMPREINTE DU COURS (cours modifié ?) ──────────────────────────────── */
  function contentSignature(text){
    var t = normalizeText(text);
    return { hash: hashText(t), len: t.length };
  }
  /* Une banque est OBSOLÈTE si le texte source a changé de façon significative
     depuis sa génération. Une banque ancienne (sans empreinte) n'est jamais
     déclarée obsolète : on n'invalide pas ce qu'on ne peut pas comparer. */
  function isStale(items, sourceText){
    var ref = null;
    (items || []).some(function(it){ if(it && it.srcHash){ ref = it; return true; } return false; });
    if(!ref) return false;
    var now = contentSignature(sourceText);
    if(!now.len) return false;
    if(now.hash === ref.srcHash) return false;
    var oldLen = ref.srcLen || now.len;
    return Math.abs(now.len - oldLen) / Math.max(1, oldLen) > STALE_LEN_RATIO;
  }

  /* ── 4. TAILLE DE LA BANQUE ET PLAN DE GÉNÉRATION ─────────────────────────────
     Adaptée à la quantité de contenu RÉELLEMENT disponible : jamais 50 questions
     sur un cours de deux paragraphes. */
  function bankTargets(charCount){
    var n = Math.max(0, charCount | 0);
    if(n < 1500)  return { quiz: 6,  flashcards: 6 };
    if(n < 4000)  return { quiz: 10, flashcards: 10 };
    if(n < 12000) return { quiz: 16, flashcards: 16 };
    if(n < 30000) return { quiz: 22, flashcards: 22 };
    return { quiz: 28, flashcards: 28 };
  }
  function needsEnrichment(count, target){
    return count < Math.max(MIN_VIABLE, Math.ceil(target * 0.6));
  }

  var FOCUS = [
    ["definition", "comprehension", "vrai_faux"],
    ["application", "exemple", "comprehension"],
    ["association", "definition", "application"],
    ["comprehension", "exemple", "vrai_faux"],
  ];
  /* Découpe le texte en `parts` tranches contiguës de taille voisine (frontières de
     paragraphes), chacune bornée à `maxChars` : chaque lot d'appel IA voit une PARTIE
     DIFFÉRENTE du cours → la banque couvre le cours entier, pas seulement son début. */
  function sliceSource(text, parts, maxChars){
    text = String(text || "");
    maxChars = maxChars || 7000;
    parts = Math.max(1, parts | 0);
    if(text.length <= maxChars || parts === 1) return [text.slice(0, maxChars)];
    var paras = text.split(/\n{2,}/);
    if(paras.length < parts) paras = text.split(/(?<=[.!?])\s+/);
    var total = paras.reduce(function(n, p){ return n + p.length + 2; }, 0);
    var per = total / parts, out = [], cur = "";
    paras.forEach(function(p){
      if(cur.length >= per && out.length < parts - 1){ out.push(cur); cur = ""; }
      cur += (cur ? "\n\n" : "") + p;
    });
    if(cur) out.push(cur);
    return out.map(function(s){ return s.slice(0, maxChars); });
  }
  /* Le plan : combien de lots, et pour chacun quelle tranche, combien d'éléments, quel
     accent de types de questions. `have` = ce que la banque contient déjà. */
  function batchPlan(kind, target, have, charCount){
    var remaining = Math.max(0, target - (have | 0));
    if(!remaining) return [];
    var size = kind === "flashcards" ? CARD_BATCH : QUIZ_BATCH;
    var n = Math.min(MAX_BATCHES, Math.ceil(remaining / size));
    var plan = [], left = remaining;
    for(var i = 0; i < n; i++){
      var count = Math.min(size, Math.ceil(left / (n - i)));
      plan.push({ index: i, count: count, slice: i, slices: n, focus: FOCUS[i % FOCUS.length] });
      left -= count;
    }
    return plan;
  }

  /* ── 5. QUESTIONS : normalisation et QUALITÉ ──────────────────────────────── */
  var POSITIONAL = /^(toutes? les (r[ée]ponses?|propositions?)|aucune? des (r[ée]ponses?|propositions?)|les deux|a et b|b et c|a et c|a, b|ni a ni b|all of the above|none of the above)|ci-dessus|ci-dessous|\b(r[ée]ponses?|propositions?)\s+[abcd]\b/i;
  function hasPositionalOption(opts){ return (opts || []).some(function(o){ return POSITIONAL.test(normalizeText(o).replace(/\s+/g, " ")) || POSITIONAL.test(String(o)); }); }
  function isTrueFalse(opts){
    if(!opts || opts.length !== 2) return false;
    var n = opts.map(normalizeText).sort().join("|");
    return n === "faux|vrai" || n === "false|true" || n === "falsch|wahr" || n === "falso|verdadero" || n === "falso|vero";
  }
  function cleanType(t){
    t = normalizeText(t).replace(/ /g, "_");
    if(t === "vrai_ou_faux" || t === "true_false" || t === "vf") t = "vrai_faux";
    return TYPES.indexOf(t) >= 0 ? t : null;
  }
  function cleanDifficulty(d){
    d = normalizeText(d);
    var map = { facile: "easy", easy: "easy", moyen: "medium", medium: "medium", intermediaire: "medium", difficile: "hard", hard: "hard" };
    return map[d] || null;
  }

  /* Normalise UNE question brute (sortie de l'IA ou ancienne question) vers la forme de
     la banque. Conserve les champs historiques (uid, q, opts, correct, exp, ai, theme) :
     tout le code existant (qstats, quiz, correction) continue de fonctionner.
     ctx : { courseId, chapterId, subjectId, srcHash, srcLen, section, now } */
  function normalizeQuestion(raw, ctx){
    ctx = ctx || {};
    if(!raw || typeof raw !== "object") return null;
    var q = stripTags(raw.q);
    var opts = Array.isArray(raw.opts) ? raw.opts.map(stripTags).slice(0, 4) : null;
    if(!q || !opts || opts.length < 2 || typeof raw.correct !== "number" || !isFinite(raw.correct)) return null;
    var correct = Math.max(0, Math.min(opts.length - 1, Math.round(raw.correct)));
    var type = cleanType(raw.type) || (isTrueFalse(opts) ? "vrai_faux" : "mcq");
    var course = ctx.courseId || ctx.chapterId || "";
    var id = (ctx.keepUid && raw.uid) ? String(raw.uid) : "q_" + hashText(course + "|" + normalizeText(q));
    var out = {
      uid: id, id: id, ai: true, theme: "ai", type: type,
      q: q, opts: opts, correct: correct, exp: stripTags(raw.exp),
      sourceQuote: raw.sourceQuote ? String(raw.sourceQuote) : "",
      exampleQuote: raw.exampleQuote ? String(raw.exampleQuote) : "",
      chapterId: ctx.chapterId || undefined, courseId: course || undefined, subjectId: ctx.subjectId || undefined,
    };
    var concept = stripTags(raw.concept).slice(0, 60);
    if(concept) out.concept = concept;
    var diff = cleanDifficulty(raw.difficulty);
    if(diff) out.difficulty = diff;
    if(ctx.section !== undefined && ctx.section !== null) out.section = ctx.section;
    if(ctx.srcHash){ out.srcHash = ctx.srcHash; out.srcLen = ctx.srcLen || 0; }
    return out;
  }

  /* La qualité : on PRÉFÈRE 20 bonnes questions à 100 douteuses. Renvoie les raisons de rejet. */
  function validateQuestion(q){
    var reasons = [];
    if(!q || !q.q || q.q.length < 12) reasons.push("question-trop-courte");
    if(q && q.q && q.q.length > 400) reasons.push("question-trop-longue");
    var opts = (q && q.opts) || [];
    if(opts.length < 2 || opts.length > 6) reasons.push("nombre-de-choix");
    if(opts.some(function(o){ return !o || o.length > 220; })) reasons.push("choix-vide-ou-trop-long");
    var norm = opts.map(normalizeText);
    if(norm.some(function(o, i){ return norm.indexOf(o) !== i; })) reasons.push("choix-en-double");
    if(!(q && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < opts.length)) reasons.push("bonne-reponse-invalide");
    if(hasPositionalOption(opts)) reasons.push("choix-dependant-de-la-position");
    if(reasons.length) return { ok: false, reasons: reasons };
    var isTF = isTrueFalse(opts);
    if(!isTF){
      var good = norm[q.correct];
      if(good.length >= 8 && normalizeText(q.q).indexOf(good) >= 0) reasons.push("reponse-dans-la-question");
      if(opts.length >= 3){
        var others = opts.filter(function(_, i){ return i !== q.correct; });
        var mean = others.reduce(function(n, o){ return n + o.length; }, 0) / others.length;
        if(opts[q.correct].length > 40 && opts[q.correct].length > mean * 2.5) reasons.push("bonne-reponse-trop-longue");
      }
    }
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* Lot brut → { items, rejected }. Dédoublonne contre `existing` (même identifiant, ou
     énoncé quasi identique : Jaccard ≥ 0,8). */
  function dedupe(list, existing){
    var kept = [], seen = {};
    var pool = (existing || []).map(function(e){ return { id: e.id || e.uid, w: words(e.q || e.front || "") }; });
    (list || []).forEach(function(it){
      var id = it.id || it.uid, w = words(it.q || it.front || "");
      if(seen[id]) return;
      for(var i = 0; i < pool.length; i++){
        if(pool[i].id === id || (w.length >= 3 && pool[i].w.length >= 3 && jaccard(w, pool[i].w) >= 0.8)) return;
      }
      seen[id] = 1; kept.push(it); pool.push({ id: id, w: w });
    });
    return kept;
  }
  function parseQuizBatch(arr, ctx, existing){
    var rejected = [], good = [];
    (Array.isArray(arr) ? arr : []).forEach(function(raw){
      var n = normalizeQuestion(raw, ctx);
      if(!n){ rejected.push({ reasons: ["format"] }); return; }
      var v = validateQuestion(n);
      if(v.ok) good.push(n); else rejected.push({ reasons: v.reasons, q: n.q });
    });
    return { items: dedupe(good, existing), rejected: rejected };
  }

  /* ── 6. FLASHCARDS : normalisation, sens inverse ──────────────────────────── */
  var DEF_Q = /^(?:qu['’]est[- ]ce (?:que|qu['’])\s*(?:un |une |le |la |les |l['’])?|que signifie |c['’]est quoi (?:un |une |le |la |les |l['’])?|d[ée]finis(?:sez)? |d[ée]finir |what is (?:a |an |the )?|was ist |que es |che cos['’]?[eè] )(.{2,60}?)\s*\??$/i;
  /* Une carte est INVERSIBLE si recto = « Qu'est-ce que X ? » (ou un terme court) et verso =
     une définition : alors « définition → terme » a un sens. Sinon (réponse oui/non,
     liste, nombre, énumération…) elle ne se retourne pas. Renvoie { ok, term }. */
  function deriveReversible(card){
    var f = stripTags(card && card.front), b = stripTags(card && card.back);
    if(!f || !b || b.length < 20 || b.length > 220) return { ok: false, term: "" };
    if(/^(oui|non|vrai|faux|true|false)\b/i.test(b) || /^[\d\s.,%€$-]+$/.test(b)) return { ok: false, term: "" };
    var term = "";
    var m = DEF_Q.exec(f);
    if(m) term = m[1].trim();
    else if(f.indexOf("?") < 0 && f.length <= 40 && f.split(/\s+/).length <= 5) term = f;
    if(!term) return { ok: false, term: "" };
    var nt = normalizeText(term);
    if(!nt || normalizeText(b).indexOf(nt) >= 0) return { ok: false, term: "" };   // le verso contiendrait la réponse
    return { ok: true, term: term.charAt(0).toUpperCase() + term.slice(1) };
  }
  function normalizeFlashcard(raw, ctx){
    ctx = ctx || {};
    if(!raw || typeof raw !== "object") return null;
    var front = stripTags(raw.front), back = stripTags(raw.back);
    if(front.length < 3 || back.length < 2 || normalizeText(front) === normalizeText(back)) return null;
    var course = ctx.courseId || ctx.chapterId || "";
    var id = "f_" + hashText(course + "|" + normalizeText(front));
    var rev = deriveReversible({ front: front, back: back });
    var out = {
      id: id, front: front, back: back, ai: true, reversible: rev.ok, revTerm: rev.ok ? rev.term : "",
      sourceQuote: raw.sourceQuote ? String(raw.sourceQuote) : "",
      exampleQuote: raw.exampleQuote ? String(raw.exampleQuote) : "",
      chapterId: ctx.chapterId || undefined, courseId: course || undefined, subjectId: ctx.subjectId || undefined,
    };
    var concept = stripTags(raw.concept).slice(0, 60);
    if(concept) out.concept = concept;
    if(ctx.section !== undefined && ctx.section !== null) out.section = ctx.section;
    if(ctx.srcHash){ out.srcHash = ctx.srcHash; out.srcLen = ctx.srcLen || 0; }
    return out;
  }
  function parseCardBatch(arr, ctx, existing){
    var good = [], rejected = [];
    (Array.isArray(arr) ? arr : []).forEach(function(raw){
      var n = normalizeFlashcard(raw, ctx);
      if(n) good.push(n); else rejected.push({ reasons: ["format"] });
    });
    return { items: dedupe(good, existing), rejected: rejected };
  }

  /* Fusion (enrichissement) : l'existant reste en tête, les nouveautés s'ajoutent,
     sans doublon, sans dépasser BANK_MAX. */
  function mergeBank(existing, incoming){
    var base = (existing || []).slice();
    var add = dedupe(incoming, base);
    return base.concat(add).slice(0, BANK_MAX);
  }

  /* ── 7. SESSIONS ────────────────────────────────────────────────────────────── */
  function idOf(it){ return it.id || it.uid || (it.front !== undefined ? "f_" + hashText(it.front) : hashText(it.q || "")); }
  function playableQuestion(q){
    return !!q && typeof q.q === "string" && Array.isArray(q.opts) && q.opts.length >= 2 && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.opts.length;
  }
  function playableCard(c){ return !!c && typeof c.front === "string" && typeof c.back === "string" && c.front.trim() && c.back.trim(); }
  function groupKey(it){
    if(it.concept) return "c:" + normalizeText(it.concept);
    if(it.section !== undefined && it.section !== null) return "s:" + it.section;
    return "";
  }
  function newSessionId(rng){ return "s_" + Date.now().toString(36) + Math.floor((rng || defaultRng)() * 1679616).toString(36); }

  /* Sélection : « fraîches » (absentes de la session précédente) d'abord, puis le reste ;
     dans chaque passe, un tour de table par concept/section (couverture) ; au sein d'un
     groupe, la question dont la difficulté est la moins représentée gagne (mélange des
     niveaux). Le hasard décide de tout le reste. */
  function selectItems(pool, size, opts){
    var rng = opts.rng || defaultRng, last = {};
    (opts.lastIds || []).forEach(function(i){ last[i] = 1; });
    size = Math.min(size, pool.length);
    var chosen = [], taken = {}, diffCount = { easy: 0, medium: 0, hard: 0 };
    var hasKeys = pool.some(function(it){ return groupKey(it); });
    var usesDiff = !opts.ignoreDifficulty && pool.some(function(it){ return it.difficulty; });
    function pass(candidates){
      var groups = {}, order = [];
      shuffleArray(candidates, rng).forEach(function(it){
        var k = hasKeys ? groupKey(it) : "";
        if(!groups[k]){ groups[k] = []; order.push(k); }
        groups[k].push(it);
      });
      order = shuffleArray(order, rng);
      var progressed = true;
      while(chosen.length < size && progressed){
        progressed = false;
        for(var gi = 0; gi < order.length && chosen.length < size; gi++){
          var g = groups[order[gi]];
          if(!g.length) continue;
          var pick = 0;
          if(usesDiff){
            var best = Infinity;
            for(var c = 0; c < Math.min(3, g.length); c++){
              var cnt = g[c].difficulty ? diffCount[g[c].difficulty] : 0;
              if(cnt < best){ best = cnt; pick = c; }
            }
          }
          var it = g.splice(pick, 1)[0];
          chosen.push(it); taken[idOf(it)] = 1;
          if(it.difficulty) diffCount[it.difficulty]++;
          progressed = true;
        }
      }
    }
    pass(pool.filter(function(it){ return !last[idOf(it)]; }));
    if(chosen.length < size) pass(pool.filter(function(it){ return !taken[idOf(it)]; }));
    return chosen;
  }
  function sameSequence(a, b){
    if(!b || a.length !== b.length) return false;
    for(var i = 0; i < a.length; i++) if(a[i] !== b[i]) return false;
    return true;
  }
  /* Ordre final : mélangé, et jamais IDENTIQUE à la session précédente (même
     ensemble, même ordre) quand il existe une autre possibilité. */
  function orderItems(items, lastOrder, rng){
    var out = shuffleArray(items, rng);
    for(var tries = 0; tries < 8 && out.length > 1 && sameSequence(out.map(idOf), lastOrder); tries++) out = shuffleArray(items, rng);
    return out;
  }

  /* Mélange des CHOIX d'une question : copie, jamais l'original. `perm[k]` = indice
     d'origine du choix affiché en position k ; `correct` est RECALCULÉ. Les questions dont
     un choix dépend de la position (« Toutes les réponses… », « A et B ») et les
     Vrai/Faux (ordre naturel) ne sont pas mélangées. */
  function shuffleChoices(q, rng){
    var opts = q.opts.slice();
    var fixed = hasPositionalOption(opts) || isTrueFalse(opts);
    var perm = opts.map(function(_, i){ return i; });
    if(!fixed) perm = shuffleArray(perm, rng);
    var out = Object.assign({}, q);
    out.opts = perm.map(function(i){ return opts[i]; });
    out.correct = perm.indexOf(q.correct);
    out.perm = perm;
    out.choicesShuffled = !fixed;
    return out;
  }

  /* SESSION DE QUIZ. `bank` n'est jamais modifiée. Options :
     size, lastIds (session précédente), lastOrder, rng, kind ("quiz" | "flash"). */
  function buildQuizSession(bank, options){
    options = options || {};
    var rng = options.rng || defaultRng;
    var kind = options.kind === "flash" ? "flash" : "quiz";
    var size = options.size || (kind === "flash" ? QUIZ_FLASH_SIZE : QUIZ_SESSION_SIZE);
    var pool = (bank || []).filter(playableQuestion);
    var chosen = selectItems(pool, size, { rng: rng, lastIds: options.lastIds });
    var ordered = orderItems(chosen, options.lastOrder, rng);
    var items = ordered.map(function(q){ return shuffleChoices(q, rng); });
    return {
      sessionId: newSessionId(rng), kind: kind, startedAt: Date.now(),
      questionIds: ordered.map(idOf), items: items, size: items.length, bankSize: pool.length,
    };
  }

  /* SESSION DE FLASHCARDS : mêmes principes ; certaines cartes INVERSIBLES sont retournées
     (définition → terme). Jamais toutes : `reverseRate`, et seulement si `reversible`. */
  function buildFlashSession(bank, options){
    options = options || {};
    var rng = options.rng || defaultRng;
    var pool = (bank || []).filter(playableCard);
    var size = options.size || (pool.length <= FLASH_DECK_SIZE ? pool.length : FLASH_DECK_SIZE);
    var chosen = selectItems(pool, size, { rng: rng, lastIds: options.lastIds, ignoreDifficulty: true });
    var ordered = orderItems(chosen, options.lastOrder, rng);
    var rate = options.reverseRate === undefined ? REVERSE_RATE : options.reverseRate;
    var items = ordered.map(function(c){
      var rev = c.reversible === undefined ? deriveReversible(c) : { ok: !!c.reversible, term: c.revTerm || deriveReversible(c).term };
      var out = Object.assign({}, c);
      if(rev.ok && rev.term && rate > 0 && rng() < rate){
        out.front = c.back; out.back = rev.term; out.reversed = true;
      } else out.reversed = false;
      return out;
    });
    return {
      sessionId: newSessionId(rng), kind: "flashcards", startedAt: Date.now(),
      questionIds: ordered.map(idOf), items: items, size: items.length, bankSize: pool.length,
    };
  }

  /* Un résultat de session, rattaché à la SESSION (pas à l'ordre permanent de la banque). */
  function sessionRecord(session, result){
    return {
      sessionId: session.sessionId, kind: session.kind, questionIds: session.questionIds.slice(),
      score: result.score, total: result.total, startedAt: session.startedAt, completedAt: result.completedAt || Date.now(),
    };
  }

  /* ── 8. PROMPTS (texte pur ; le contexte du cours est ajouté par la page) ───── */
  var TYPE_HINT = {
    definition: "définition d'un terme", comprehension: "compréhension d'un concept", application: "application à un cas concret",
    exemple: "question portant sur un exemple du cours", vrai_faux: "affirmation vraie ou fausse (uniquement si le cours s'y prête)",
    association: "association entre deux notions", calcul: "petit calcul (uniquement si le cours contient des chiffres/formules)",
  };
  function quizBatchInstruction(o){
    o = o || {};
    var n = o.count || QUIZ_BATCH;
    var focus = (o.focus || FOCUS[0]).map(function(t){ return TYPE_HINT[t] || t; }).join(" ; ");
    var avoid = (o.existingStems || []).slice(0, 20).map(function(s){ return "- " + String(s).slice(0, 120); }).join("\n");
    return "TÂCHE : génère " + n + " questions pour réviser CETTE partie du cours, uniquement à partir du contenu ci-dessus. " +
      "Varie les formes quand le contenu le permet : " + focus + ". Chaque question traite un point DIFFÉRENT. " +
      "QCM : 4 choix, UNE seule bonne réponse, les mauvais choix doivent être plausibles mais clairement faux d'après le cours, de longueur comparable à la bonne réponse. " +
      "INTERDIT : « toutes les réponses ci-dessus », « A et B », « aucune des réponses », une question qui contient sa propre réponse. " +
      "Vrai/faux : opts = [\"Vrai\",\"Faux\"]. " +
      "Pour chaque question : \"concept\" (nom court de la notion traitée), \"type\" (definition | comprehension | application | exemple | vrai_faux | association | calcul), " +
      "\"difficulty\" (easy | medium | hard), \"exp\" (explication d'une phrase), \"sourceQuote\" (COURTE citation EXACTE du contenu justifiant la réponse) et, si un exemple lié apparaît, \"exampleQuote\" (citation exacte), sinon vide. " +
      (avoid ? "\nQuestions DÉJÀ présentes, à ne PAS refaire :\n" + avoid + "\n" : "") +
      "Réponds UNIQUEMENT par un tableau JSON, sans texte autour : [{\"q\":\"...\",\"opts\":[\"a\",\"b\",\"c\",\"d\"],\"correct\":0,\"concept\":\"...\",\"type\":\"definition\",\"difficulty\":\"medium\",\"exp\":\"...\",\"sourceQuote\":\"...\",\"exampleQuote\":\"...\"}]";
  }
  function cardBatchInstruction(o){
    o = o || {};
    var n = o.count || CARD_BATCH;
    var avoid = (o.existingStems || []).slice(0, 20).map(function(s){ return "- " + String(s).slice(0, 120); }).join("\n");
    return "TÂCHE : génère " + n + " flashcards de révision pour CETTE partie du cours (définitions, notions, formules, dates, mécanismes, distinctions importantes), uniquement à partir du contenu ci-dessus. " +
      "Recto court : pour une définition, formule-le « Qu'est-ce que … ? » ; verso court : une phrase. Chaque carte traite un point DIFFÉRENT. " +
      "Pour chaque carte : \"concept\" (nom court de la notion), \"sourceQuote\" (COURTE citation EXACTE du contenu justifiant la réponse) et, si un exemple lié apparaît, \"exampleQuote\" (citation exacte), sinon vide. " +
      (avoid ? "\nCartes DÉJÀ présentes, à ne PAS refaire :\n" + avoid + "\n" : "") +
      "Réponds UNIQUEMENT par un tableau JSON, sans texte autour : [{\"front\":\"...\",\"back\":\"...\",\"concept\":\"...\",\"sourceQuote\":\"...\",\"exampleQuote\":\"...\"}]";
  }

  global.RevemBank = {
    QUIZ_SESSION_SIZE: QUIZ_SESSION_SIZE, QUIZ_FLASH_SIZE: QUIZ_FLASH_SIZE, FLASH_DECK_SIZE: FLASH_DECK_SIZE,
    MIN_VIABLE: MIN_VIABLE, REVERSE_RATE: REVERSE_RATE, BANK_MAX: BANK_MAX, MAX_BATCHES: MAX_BATCHES,
    DIFFICULTIES: DIFFICULTIES, TYPES: TYPES,
    defaultRng: defaultRng, seededRng: seededRng, randInt: randInt, shuffleArray: shuffleArray,
    stripTags: stripTags, normalizeText: normalizeText, hashText: hashText,
    contentSignature: contentSignature, isStale: isStale,
    bankTargets: bankTargets, needsEnrichment: needsEnrichment, sliceSource: sliceSource, batchPlan: batchPlan,
    normalizeQuestion: normalizeQuestion, validateQuestion: validateQuestion, parseQuizBatch: parseQuizBatch,
    normalizeFlashcard: normalizeFlashcard, parseCardBatch: parseCardBatch, deriveReversible: deriveReversible,
    dedupe: dedupe, mergeBank: mergeBank,
    playableQuestion: playableQuestion, playableCard: playableCard, hasPositionalOption: hasPositionalOption, isTrueFalse: isTrueFalse,
    shuffleChoices: shuffleChoices, buildQuizSession: buildQuizSession, buildFlashSession: buildFlashSession, sessionRecord: sessionRecord,
    quizBatchInstruction: quizBatchInstruction, cardBatchInstruction: cardBatchInstruction,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
