/* ============================================================================
   output-processor.js — AI OUTPUT PROCESSOR : du texte BRUT du modèle à la réponse PROPRE
   ----------------------------------------------------------------------------
   `globalThis.RevemOutput` — même patron que assistant-core.js, ai-engine.js… : logique PURE,
   ni DOM, ni `state`, ni WebLLM, ni réseau. Testable sous Node : `node tests/output-processor.test.js`.

   POURQUOI (cause constatée, voir AI_OUTPUT.md) : le texte reçu de WebLLM était considéré comme « prêt à afficher ».
   WebLLM 0.2.85 ne fournit AUCUN champ `reasoning_content` : le raisonnement d'un modèle comme DeepSeek-R1
   arrive EN CLAIR dans `delta.content`, et selon le gabarit de chat du modèle, la balise OUVRANTE <think> peut
   ne jamais être émise (le gabarit l'a déjà placée dans le prompt) : on reçoit alors le raisonnement, puis un
   `</think>` ORPHELIN, puis la réponse. L'ancien filtre n'enlevait que les paires <think>…</think> complètes :
   tout ce qui précède un `</think>` orphelin (le raisonnement, avec ses brouillons de réponse) restait affiché,
   le tag aussi, et ce texte était renvoyé au modèle au tour suivant.

   LA CHAÎNE (tout est DÉTERMINISTE : aucun second appel au modèle) :

     RAW STREAM ─▶ push(delta)          un DELTA est ajouté ; jamais un texte « complet » recollé
                ─▶ extract              filtre du raisonnement, par ÉTAT (balises coupées entre deux chunks, orphelines)
                ─▶ visible()            ce qui peut être affiché PENDANT le flux (rien du raisonnement, aucune balise partielle)
                ─▶ finish()             sanitize (jetons spéciaux, typographie) · boucle · doublons évidents
                ─▶ validate()           diagnostic : vide, raisonnement tronqué, boucle, langue, alphabet étranger…
                ─▶ texte propre ─▶ UI ─▶ historique (la version NETTOYÉE, jamais le brut)

   Ce module NETTOIE la structure et les artefacts ; il ne réécrit JAMAIS le sens (aucun remplacement de mots,
   aucune « correction » de français, aucun filtre d'alphabet destructif).
   ============================================================================ */
(function(global){
  "use strict";

  var LATIN_LANGS = ["fr", "en", "es", "de", "it"];

  function now(){ return (global.performance && global.performance.now) ? global.performance.now() : Date.now(); }
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

  /* ── 1. BALISES ET JETONS SPÉCIAUX ───────────────────────────────────────────
     Réellement émises par les modèles configurés (ai-engine.js TIERS) :
       • <think> … </think>       DeepSeek-R1 (Expert) ;
       • <|eot_id|>, <|end|>, <|im_end|> …  jetons de fin de tour de Llama / Phi / Qwen ;
       • <｜end▁of▁sentence｜>     jeton de fin de DeepSeek (barres PLEINE LARGEUR).
     Pas de longue liste inventée. */
  var THINK_TAG = /<\/?think>/gi;
  var SPECIAL_BODY = "[A-Za-z0-9_▁\\- .]{1,40}";
  var SPECIAL_RE = new RegExp("<[|｜]" + SPECIAL_BODY + "[|｜]>", "g");
  var SPECIAL_PARTIAL_RE = /<[|｜][A-Za-z0-9_▁\- .]{0,40}$/;

  function removeSpecial(s){
    var n = 0;
    var out = s.replace(SPECIAL_RE, function(){ n++; return ""; });
    return { text: out, count: n };
  }
  /* Un morceau de balise en fin de flux (« <thi », « </th », « <| ») ne s'affiche JAMAIS : le chunk suivant le complétera. */
  function trimPartial(s, final){
    var i = s.lastIndexOf("<");
    if(i < 0 || s.length - i > 46) return s;
    var tail = s.slice(i), low = tail.toLowerCase();
    if(final && tail.length < 2) return s;                        // un « < » isolé en toute fin de réponse terminée est du texte (« si a < »)
    if("<think>".indexOf(low) === 0 || "</think>".indexOf(low) === 0 || SPECIAL_PARTIAL_RE.test(tail)) return s.slice(0, i);
    return s;
  }

  /* ── 2. FILTRE DU RAISONNEMENT (machine à états sur le texte accumulé) ───────
     extract(raw, { reasoning, final, finishReason }) → { answer, reasoning, state, unfinished, orphanClose, tags }

     • on travaille sur le texte ACCUMULÉ : une balise coupée entre deux chunks (« <thi » + « nk> ») est reconnue dès
       qu'elle est complète, et en attendant (trimPartial) elle n'est pas affichée ;
     • `</think>` AVANT toute balise ouvrante (orphelin) ⇒ tout ce qui le précède EST du raisonnement ;
     • palier à raisonnement (`reasoning: true`) et AUCUNE balise reçue pendant le flux ⇒ on suppose que le modèle est en
       train de raisonner et on MASQUE tout jusqu'à `</think>` (le gabarit a pu consommer la balise ouvrante) ;
     • fin de flux sans aucune balise : c'est une réponse directe… sauf coupure par la limite de longueur d'un palier
       à raisonnement (le texte est alors du raisonnement inachevé : jamais affiché comme une réponse). */
  function extract(raw, o){
    o = o || {};
    var s = String(raw == null ? "" : raw);
    var rf = !!o.reasoning, fin = !!o.final;
    var re = /<(\/?)think>/gi, m, parts = [], last = 0, firstTag = null, opens = 0, closes = 0;
    while((m = re.exec(s))){
      if(m.index > last) parts.push({ t: "text", v: s.slice(last, m.index) });
      var kind = m[1] ? "close" : "open";
      parts.push({ t: kind });
      if(firstTag === null) firstTag = kind;
      if(kind === "open") opens++; else closes++;
      last = m.index + m[0].length;
    }
    if(last < s.length) parts.push({ t: "text", v: s.slice(last) });
    var inThink;
    if(firstTag === "close") inThink = true;                           // </think> orphelin : ce qui précède est du raisonnement
    else if(firstTag === null && rf && !fin) inThink = true;           // palier R1, flux en cours, rien reconnu : on retient
    else inThink = false;
    var ans = "", rea = "";
    for(var i = 0; i < parts.length; i++){
      var p = parts[i];
      if(p.t === "text"){ if(inThink) rea += p.v; else ans += p.v; }
      else if(p.t === "open") inThink = true;
      else inThink = false;
    }
    var unfinished = fin && inThink;
    if(fin && firstTag === null && rf){
      if(o.finishReason === "length"){ rea = s; ans = ""; unfinished = true; }   // coupé par la limite : du raisonnement, pas une réponse
      else { ans = s; rea = ""; unfinished = false; }                           // réponse directe sans raisonnement
    }
    var state = ans.replace(/^\s+/, "") ? "answering" : (inThink || unfinished || rea ? "thinking" : "waiting");
    return { answer: ans.replace(/^\s+/, ""), reasoning: rea, state: state, unfinished: unfinished, orphanClose: firstTag === "close", tags: opens + closes };
  }

  /* ── 3. BOUCLES : un même bloc répété à la suite (la défaillance classique d'un petit modèle ou d'un R1) ── */
  function findLoop(s){
    var n = s.length;
    if(n < 96) return null;
    for(var L = 12; L <= 400; L++){
      var reps = L < 40 ? 6 : 3;
      if(L * reps > n) continue;
      var start = n - L * reps, ok = true;
      for(var i = start + L; i < n; i++){ if(s.charCodeAt(i) !== s.charCodeAt(i - L)){ ok = false; break; } }
      if(!ok) continue;
      var unit = s.slice(n - L);
      if((unit.match(/[A-Za-zÀ-ÿ0-9]/g) || []).length < 6) continue;          // une ligne de points ou de tirets n'est pas une boucle
      var count = reps, from = start;
      while(from - L >= 0 && s.slice(from - L, from) === unit){ from -= L; count++; }
      return { unit: unit, length: L, reps: count, firstStart: from };
    }
    return null;
  }
  function collapseLoop(text){
    var lp = findLoop(text);
    if(!lp) return { text: text, collapsed: false };
    return { text: text.slice(0, lp.firstStart + lp.length).replace(/\s+$/, ""), collapsed: true };
  }

  /* ── 4. TYPOGRAPHIE (structure, jamais le sens) ──────────────────────────────
     Préserve : Markdown, listes, tableaux, blocs de code, formules, symboles. Espaces avant : ; ! ? NON touchés
     (typographie française légitime). */
  function tidy(text){
    var lines = String(text).replace(/\r\n?/g, "\n").split("\n"), out = [], fence = false, blank = 0;
    for(var i = 0; i < lines.length; i++){
      var line = lines[i];
      if(/^\s*```/.test(line)){ fence = !fence; out.push(line.replace(/[ \t]+$/, "")); blank = 0; continue; }
      if(fence){ out.push(line); blank = 0; continue; }
      var l = line.replace(/[ \t]+$/, "");
      if(/^\s*$/.test(l)){ blank++; if(blank <= 1) out.push(""); continue; }
      var m = /^(\s*)([\s\S]*)$/.exec(l), body = m[2];
      body = body.replace(/([^\s|])[ \t]{2,}(?=[^\s|])/g, "$1 ");                          // espaces multiples (hors alignement de tableau)
      body = body.replace(/([A-Za-zÀ-ÿ0-9)\]]) +([,.])(?=\s|$)/g, "$1$2");        // « mot ,  » → « mot, »
      out.push(m[1] + body); blank = 0;
    }
    return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  }

  /* ── 5. DOUBLONS ÉVIDENTS (filet de sécurité APRÈS la correction de la cause) ──
     Un paragraphe (≥ 120 caractères) quasi identique à un paragraphe PRÉCÉDENT est retiré SEULEMENT si : mêmes nombres
     (deux calculs qui ne diffèrent que par leurs chiffres sont légitimes) ET similarité de mots ≥ 0,92 ET longueurs voisines.
     Jamais dans un bloc de code, un tableau ou une formule courte. Une phrase répétée deux fois de suite est réduite à une. */
  function wordsOf(s){
    var w = s.toLowerCase().replace(/[^a-z0-9à-ÿ\s']/g, " ").split(/\s+/), out = [];
    for(var i = 0; i < w.length; i++) if(w[i].length > 1) out.push(w[i]);
    return out;
  }
  function jaccard(a, b){
    var sa = {}, sb = {}, i, inter = 0, uni = 0, k;
    for(i = 0; i < a.length; i++) sa[a[i]] = 1;
    for(i = 0; i < b.length; i++) sb[b[i]] = 1;
    for(k in sa){ uni++; if(sb[k]) inter++; }
    for(k in sb) if(!sa[k]) uni++;
    return uni ? inter / uni : 0;
  }
  function numbersOf(s){ return (s.match(/\d+(?:[.,]\d+)?/g) || []).join("|"); }
  function splitBlocks(text){
    var lines = text.split("\n"), blocks = [], cur = [], fence = false;
    for(var i = 0; i < lines.length; i++){
      var line = lines[i];
      if(/^\s*```/.test(line)) fence = !fence;
      if(!fence && /^\s*$/.test(line) && !/^\s*```/.test(line)){ if(cur.length){ blocks.push(cur.join("\n")); cur = []; } }
      else cur.push(line);
    }
    if(cur.length) blocks.push(cur.join("\n"));
    return blocks;
  }
  function sentenceDedupe(p){
    var parts = p.replace(/([.!?…])\s+/g, "$1\u0001").split("\u0001"), out = [], prev = "", removed = 0;
    for(var i = 0; i < parts.length; i++){
      var key = parts[i].toLowerCase().replace(/[^a-z0-9à-ÿ]/g, "");
      if(key.length >= 30 && key === prev){ removed++; continue; }
      out.push(parts[i]); prev = key;
    }
    return { text: out.join(" "), removed: removed };
  }
  function dedupe(text){
    var blocks = splitBlocks(text), kept = [], info = [], removed = 0;
    for(var i = 0; i < blocks.length; i++){
      var b = blocks[i], t = b.trim();
      if(/^```/.test(t) || /^\s*\|/.test(t)){ kept.push(b); continue; }          // code, tableau : jamais touchés
      if(!/^\s*(?:[-*+]|\d+[.)])\s/.test(t)){ var sd = sentenceDedupe(b); if(sd.removed){ removed += sd.removed; b = sd.text; t = b.trim(); } }
      if(t.length >= 120){
        var w = wordsOf(t), nums = numbersOf(t), dup = false;
        for(var j = 0; j < info.length; j++){
          if(info[j].nums !== nums) continue;
          var ratio = w.length / Math.max(1, info[j].w.length);
          if(ratio < 0.75 || ratio > 1.34) continue;
          if(jaccard(w, info[j].w) >= 0.92){ dup = true; break; }
        }
        if(dup){ removed++; continue; }
        info.push({ w: w, nums: nums });
      }
      kept.push(b);
    }
    return { text: kept.join("\n\n"), removed: removed };
  }

  /* ── 6. ALPHABETS ÉTRANGERS : DÉTECTION, jamais suppression ─────────────────
     « écart standard,衡量 les risques » : un fragment chinois dans une réponse française. On NE supprime PAS
     les alphabets non latins (« Que signifie 衡量 ? » est une demande légitime) : on les DÉTECTE, selon le contexte.
     Le grec n'est pas compté (μ, σ, Σ, π sont des symboles mathématiques). */
  var SCRIPTS = [
    ["Han", /[㐀-䶿一-鿿豈-﫿]/g],
    ["CJK-punctuation", /[、-〿！-／：-＠]/g],
    ["Kana", /[぀-ヿ]/g],
    ["Hangul", /[가-힯ᄀ-ᇿ]/g],
    ["Cyrillic", /[Ѐ-ӿ]/g],
    ["Arabic", /[؀-ۿ]/g],
    ["Hebrew", /[֐-׿]/g],
    ["Thai", /[฀-๿]/g],
    ["Devanagari", /[ऀ-ॿ]/g],
  ];
  var ANY_NONLATIN = /[、-ヿ㐀-䶿一-鿿豈-﫿！-＠가-힯ᄀ-ᇿЀ-ӿ֐-ۿ฀-๿ऀ-ॿ]/;
  function scriptStats(text){
    var found = [], total = 0, s = String(text || "");
    for(var i = 0; i < SCRIPTS.length; i++){
      var m = s.match(SCRIPTS[i][1]);
      if(m && m.length){ found.push({ script: SCRIPTS[i][0], count: m.length, sample: m.slice(0, 4).join("") }); total += m.length; }
    }
    return { found: found, total: total };
  }
  /* L'élève demande-t-il LUI-MÊME du contenu étranger (traduction, mot chinois, kanji…) ? Alors rien n'est signalé. */
  var FOREIGN_WORDS = /\b(chinois|chinese|chino|chinesisch|cinese|japonais|japanese|japones|japanisch|giapponese|coreen|korean|coreano|koreanisch|russe|russian|ruso|russisch|russo|arabe|arabic|arabisch|arabo|hebreu|hebrew|grec|greek|kanji|pinyin|hiragana|katakana|cyrillic|cyrillique|hanzi|mandarin|cantonais|cantonese)\b/;
  var TRANSLATE_WORDS = /\b(traduis|traduire|traduction|translate|translation|traduce|traducir|ubersetz\w*|traduci|traduzione|comment dit[- ]on|how (do|would|to) (you )?say|ca se dit|signification du mot|meaning of the word|significado de la palabra|bedeutung des wortes|significato della parola)\b/;
  function foreignAllowed(question, previousTexts){
    var q = String(question || "");
    if(ANY_NONLATIN.test(q)) return true;
    var f = fold(q);
    if(FOREIGN_WORDS.test(f) || TRANSLATE_WORDS.test(f)) return true;
    var prev = previousTexts || [];
    for(var i = 0; i < prev.length; i++) if(ANY_NONLATIN.test(String(prev[i] || ""))) return true;     // la conversation porte déjà sur un texte étranger
    return false;
  }
  function detectForeignScript(text, o){
    o = o || {};
    var st = scriptStats(text);
    var flagged = !o.allowForeign && LATIN_LANGS.indexOf(o.lang) >= 0 && st.total > 0;
    return { flagged: flagged, found: st.found, total: st.total };
  }

  /* ── 7. L'ASSEMBLEUR (un par génération) ───────────────────────────────────── */
  function createAssembler(o){
    o = o || {};
    var raw = "", reasoning = !!o.reasoning, mode = o.mode || "text";       // « text » : chat ; « light » : cours / JSON (reasoning + balises seulement)
    var cumulative = 0, lastCheck = 0, loop = null, visCache = null, visLen = -1, t0 = now(), pushes = 0;

    function push(delta){
      delta = String(delta == null ? "" : delta);
      if(!delta) return { changed: false, loop: false };
      pushes++;
      /* WebLLM envoie des DELTAS (choices[0].delta.content, vérifié dans ai-host.js) : un jeton à la fois. Garde-fou : un « delta » qui recolle
         TOUT le texte déjà reçu puis y ajoute au moins 3 caractères (1 seulement au-delà de 16) est un texte CUMULÉ — impossible pour un vrai
         jeton, qui n'est jamais un préfixe du texte entier — : on remplace, on n'ajoute pas (sinon « A », « AB », « ABC » donnerait « AABABC »). */
      if(raw.length >= 4 && delta.length >= raw.length + (raw.length >= 16 ? 1 : 3) && delta.indexOf(raw) === 0){ cumulative++; raw = delta; }
      else raw += delta;
      var lp = false;
      if(!loop && raw.length - lastCheck >= 60){
        lastCheck = raw.length;
        var f = findLoop(raw);
        if(f){ loop = f; lp = true; }
      }
      return { changed: true, loop: lp };
    }
    /* Ce qui peut être affiché PENDANT le flux : rien du raisonnement, aucune balise (même partielle), aucun jeton spécial. */
    function visible(){
      if(visLen === raw.length && visCache !== null) return visCache;
      var ex = extract(trimPartial(raw), { reasoning: reasoning, final: false });
      var t = removeSpecial(ex.answer).text;
      t = trimPartial(t).replace(/^\s+/, "");
      visCache = t; visLen = raw.length;
      return t;
    }
    function state(){ return extract(trimPartial(raw), { reasoning: reasoning, final: false }).state; }

    function finish(info){
      info = info || {};
      var tp = now();
      var ex = extract(raw, { reasoning: reasoning, final: true, finishReason: info.finishReason });
      var text = ex.answer, flags = { reasoningStripped: !!(ex.reasoning || ex.tags), orphanClose: ex.orphanClose, truncatedThinking: ex.unfinished, tagsRemoved: 0,
                                       specialTokensRemoved: 0, duplicatesRemoved: 0, loop: !!loop || !!info.loopAborted, loopCollapsed: false, cumulativeChunks: cumulative };
      var sp = removeSpecial(text); text = sp.text; flags.specialTokensRemoved = sp.count;
      text = trimPartial(text, true);
      var leftover = text.match(THINK_TAG);
      if(leftover){ flags.tagsRemoved = leftover.length; text = text.replace(THINK_TAG, ""); }
      if(mode === "text"){
        var cl = collapseLoop(text); if(cl.collapsed){ text = cl.text; flags.loop = true; flags.loopCollapsed = true; }
        var dd = dedupe(text); flags.duplicatesRemoved = dd.removed; text = dd.text;
        text = tidy(text);
      } else text = text.replace(/^\s+/, "").replace(/\s+$/, "");
      return { text: text, raw: raw, reasoningChars: ex.reasoning.length, answerChars: text.length, rawChars: raw.length, state: ex.state, flags: flags, mode: mode, pushes: pushes,
               processingMs: Math.round((now() - tp) * 100) / 100, streamMs: Math.round((tp - t0) * 10) / 10 };
    }
    return { push: push, visible: visible, state: state, finish: finish, raw: function(){ return raw; } };
  }

  /* ── 8. CONTRÔLE QUALITÉ DÉTERMINISTE ────────────────────────────────────────
     validate(proc, ctx) → { ok, issues:[{code, severity, …}] }. Détecte (jamais ne corrige) : réponse vide, raisonnement tronqué,
     boucle, alphabet étranger, langue probablement incohérente, longueur anormale. NE JUGE PAS si les affirmations sont vraies.
     ctx : { lang, allowForeign, finishReason, maxTokens, detectLanguage(text) → lang|null } */
  function validate(proc, ctx){
    ctx = ctx || {};
    var issues = [], text = (proc && proc.text) || "", flags = (proc && proc.flags) || {};
    if(flags.truncatedThinking && !text.trim()) issues.push({ code: "REASONING_TRUNCATED", severity: "error" });
    else if(!text.trim()) issues.push({ code: "EMPTY", severity: "error" });
    if(flags.loop) issues.push({ code: "LOOP", severity: "warn", collapsed: !!flags.loopCollapsed });
    if(ctx.finishReason === "length") issues.push({ code: "LENGTH_CUT", severity: "warn" });
    if(/<\/?think>|<[|｜]/.test(text)) issues.push({ code: "TAGS_REMAINING", severity: "warn" });
    var fs = detectForeignScript(text, { lang: ctx.lang, allowForeign: ctx.allowForeign });
    if(fs.flagged) issues.push({ code: "FOREIGN_SCRIPT", severity: "warn", scripts: fs.found.map(function(x){ return x.script + "×" + x.count; }), sample: fs.found[0].sample });
    if(ctx.detectLanguage && ctx.lang && !ctx.allowForeign && text.length >= 200){
      var d = ctx.detectLanguage(text);
      if(d && d !== ctx.lang) issues.push({ code: "LANG_MISMATCH", severity: "warn", expected: ctx.lang, detected: d });
    }
    if(ctx.maxTokens && text.length > ctx.maxTokens * 6) issues.push({ code: "ANOMALOUS_LENGTH", severity: "warn" });
    if(flags.duplicatesRemoved) issues.push({ code: "DUPLICATE_REMOVED", severity: "info", count: flags.duplicatesRemoved });
    if(flags.reasoningStripped) issues.push({ code: "REASONING_STRIPPED", severity: "info", orphanClose: !!flags.orphanClose, chars: proc.reasoningChars });
    var ok = true;
    for(var i = 0; i < issues.length; i++) if(issues[i].severity === "error") ok = false;
    return { ok: ok, issues: issues, codes: issues.map(function(x){ return x.code; }) };
  }

  /* Pour les consommateurs qui n'ont qu'un TEXTE complet (tests, anciens appels) : filtre + sanitize en une fois. */
  function processComplete(raw, o){
    var a = createAssembler(o || {});
    a.push(raw);
    return a.finish(o || {});
  }

  global.RevemOutput = {
    extract: extract, trimPartial: trimPartial, removeSpecial: removeSpecial, findLoop: findLoop, collapseLoop: collapseLoop, tidy: tidy, dedupe: dedupe,
    scriptStats: scriptStats, detectForeignScript: detectForeignScript, foreignAllowed: foreignAllowed,
    createAssembler: createAssembler, validate: validate, processComplete: processComplete,
  };
  if(typeof module !== "undefined" && module.exports) module.exports = global.RevemOutput;
})(typeof globalThis !== "undefined" ? globalThis : this);
