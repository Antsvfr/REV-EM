/* ============================================================================
   subject-search.js — filtrer et classer une liste par nom, en tapant
   ----------------------------------------------------------------------------
   `window.LyonSubjectSearch.filterAndSortSubjects(query, items, getText)`

   Un moteur pur, comme `smart-revision.js`, `statistics.js`,
   `command-center.js` et `quick-actions.js` : aucune dépendance au DOM ni à
   `state`, testable sous Node en quelques millisecondes
   (`tests/subject-search.test.js`).

   Écrit pour la recherche de « Mes matières », mais SANS rien de spécifique
   aux matières : `getText` dit comment lire le nom d'un élément (`.name` par
   défaut), donc la même fonction sert demain à filtrer des chapitres
   (`.title`), des cours, ou n'importe quelle autre liste nommée — c'est le
   sens de « architecture future-proof » demandé, sans construire la
   recherche globale elle-même maintenant.

   CLASSEMENT — cinq niveaux, TOUS affichés, du plus pertinent au moins
   ------------------------------------------------------------------------
     1. le nom EST la saisie              "marketing" → "Marketing"
     2. le nom commence par la saisie     "mar"       → "Marketing"
     3. un MOT commence par la saisie     "mar"       → "Gestion du marketing"
     4. le nom contient la saisie         "ting"      → "Marketing"
     5. (égalité) ordre alphabétique      « Économie » se classe avec les E

   Les niveaux se MÉLANGENT dans une seule liste triée par niveau : "mar" sur
   [Marketing, Management, Management commercial, Gestion du marketing,
   Finance] donne « Marketing » puis « Gestion du marketing » — la
   correspondance forte d'abord, la plus faible ensuite, JAMAIS masquée.
   (Une version précédente n'affichait que le meilleur niveau non vide : un
   élève qui tapait « mar » ne voyait plus « Gestion du marketing » alors
   qu'elle correspond bien. Le classement remplace le filtrage en cascade.)

   Plusieurs mots ("gestion mar") : chaque mot saisi doit commencer un mot du
   nom (niveau 3) ou apparaître dans le nom (niveau 4).

   Accents et casse : ignorés POUR LA RECHERCHE SEULEMENT. Le nom affiché est
   toujours l'original ("Économie", pas "economie").

   Tri : `Intl.Collator` (sensible à la locale, insensible aux accents et à la
   casse, chiffres en ordre naturel : « Chapitre 2 » avant « Chapitre 10 »).
   Un tri par code de caractère brut mettrait « Économie » après « Zoologie ».
   ========================================================================== */
(function(global){
  "use strict";

  /* Même normalisation que command-center.js, dupliquée à dessein plutôt que
     partagée : ce fichier doit pouvoir être utilisé seul, sans dépendre de
     l'ordre de chargement d'un autre module. Les deux copies sont courtes et
     ne divergeront pas — voir command-center.js pour le détail du choix
     NFD/marques combinantes. */
  function normalize(s){
    return String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/['’`]/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /* `sensitivity: "base"` : insensible à la casse ET aux accents pour le tri
     aussi (pas seulement pour la comparaison de préfixe) — "café" et "Cafe"
     se classent l'un à côté de l'autre. */
  var collator = (typeof Intl !== "undefined" && Intl.Collator)
    ? new Intl.Collator("fr", { sensitivity: "base", numeric: true })
    : null;
  function compareText(a, b){
    return collator ? collator.compare(a, b) : String(a).localeCompare(String(b));
  }

  function defaultGetText(item){ return item && item.name; }

  function sortByText(items, getText){
    return items.slice().sort(function(a, b){ return compareText(getText(a) || "", getText(b) || ""); });
  }

  var EXACT = 1, STARTS = 2, WORD = 3, CONTAINS = 4;

  /* Niveau d'un nom normalisé pour une saisie normalisée, ou 0 (pas de
     correspondance). `words` = mots de la saisie. */
  function tierOf(n, q, words){
    if(n === q) return EXACT;
    if(n.indexOf(q) === 0) return STARTS;
    var nameWords = n.split(" ");
    if(nameWords.some(function(w){ return w.indexOf(q) === 0; })) return WORD;
    if(n.indexOf(q) !== -1) return CONTAINS;
    if(words.length > 1){
      var allWordStarts = words.every(function(t){ return nameWords.some(function(w){ return w.indexOf(t) === 0; }); });
      if(allWordStarts) return WORD;
      if(words.every(function(t){ return n.indexOf(t) !== -1; })) return CONTAINS;
    }
    return 0;
  }

  /* Le MEILLEUR élément pour un nom donné (pas une recherche : `query` est le
     nom complet détecté, pas une saisie partielle), avec son niveau de
     confiance — pour un appelant qui doit décider tout seul (ex. rattacher
     un cours importé à une matière ou un chapitre existant) plutôt
     qu'afficher une liste triée à un humain. `null` si rien ne correspond
     à aucun niveau. En cas d'égalité de niveau, le premier de `items` gagne
     (ordre stable), jamais un tri alphabétique qui déciderait à la place de
     l'appelant. */
  function bestMatch(query, items, getText){
    var list = items || [];
    var text = typeof getText === "function" ? getText : defaultGetText;
    var q = normalize(query);
    if(!q) return null;
    var words = q.split(" ").filter(Boolean);
    var best = null;
    for(var i = 0; i < list.length; i++){
      var label = text(list[i]) || "";
      var n = normalize(label);
      if(!n) continue;
      var tier = tierOf(n, q, words);
      if(tier && (!best || tier < best.tier)) best = { item: list[i], tier: tier };
    }
    return best;
  }

  /* `items` n'est jamais modifié : la liste réelle (state.userSubjects, etc.)
     reste la source unique — voir SUBJECT_SEARCH.md pour la règle « pas de
     deuxième liste ». Retourne une NOUVELLE liste. */
  function filterAndSortSubjects(query, items, getText){
    var list = items || [];
    var text = typeof getText === "function" ? getText : defaultGetText;
    var q = normalize(query);

    /* Rien à filtrer : on ne fait que trier (l'appelant décide s'il veut même
       appeler cette fonction quand la recherche est vide — voir index.html :
       l'état « sans recherche » garde son groupement par semestre). */
    if(!q) return sortByText(list, text);

    var words = q.split(" ").filter(Boolean);
    var ranked = [];
    list.forEach(function(item, order){
      var label = text(item) || "";
      var n = normalize(label);
      if(!n) return;
      var tier = tierOf(n, q, words);
      if(tier) ranked.push({ item: item, tier: tier, label: label, order: order });
    });
    ranked.sort(function(a, b){
      return (a.tier - b.tier) || compareText(a.label, b.label) || (a.order - b.order);
    });
    return ranked.map(function(r){ return r.item; });
  }

  global.LyonSubjectSearch = {
    normalize: normalize,
    filterAndSortSubjects: filterAndSortSubjects,
    /* Nom courant demandé par l'architecture : même fonction, sens explicite. */
    searchSubjects: filterAndSortSubjects,
    bestMatch: bestMatch,
    TIER_EXACT: EXACT, TIER_STARTS: STARTS, TIER_WORD: WORD, TIER_CONTAINS: CONTAINS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
