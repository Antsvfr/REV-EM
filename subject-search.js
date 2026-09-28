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

   CLASSEMENT — une CASCADE, pas un mélange de niveaux
   ------------------------------------------------------------------------
   Trois niveaux, du plus strict au plus permissif. Dès qu'un niveau trouve
   au moins un résultat, les niveaux suivants ne sont PAS consultés : la
   priorité va TOUJOURS aux correspondances qui commencent par la saisie,
   jamais un mélange où une correspondance plus faible s'intercalerait entre
   deux correspondances fortes.

     1. commence par la saisie           "mar" → "Marketing"
     2. un mot commence par la saisie    "mar" → "Gestion du marketing"
                                          (seulement si le niveau 1 est vide)
     3. contient la saisie               "commercial" → "Management commercial"
                                          (seulement si les niveaux 1 et 2 sont vides)

   Dans un même niveau, tri alphabétique sensible à la locale
   (`Intl.Collator`) : « Économie » se classe avec les E, pas après le Z —
   un tri par code de caractère brut mettrait la majuscule accentuée à part.
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

  /* `items` n'est jamais modifié ni recopié au-delà du tri final : la liste
     réelle (state.userSubjects, etc.) reste la source unique — voir
     SUBJECT_SEARCH.md pour la règle « pas de deuxième liste ». */
  function filterAndSortSubjects(query, items, getText){
    var list = items || [];
    var text = typeof getText === "function" ? getText : defaultGetText;
    var q = normalize(query);

    /* Rien à filtrer : l'ordre existant de l'appelant est respecté, on ne
       fait que trier — c'est à l'appelant de décider s'il veut même appeler
       cette fonction quand la recherche est vide (voir index.html : l'état
       « sans recherche » garde son groupement par semestre, il n'appelle
       pas cette fonction du tout). */
    if(!q) return sortByText(list, text);

    var startsWith = [], wordStart = [], contains = [];
    list.forEach(function(item){
      var n = normalize(text(item));
      if(!n) return;
      if(n.indexOf(q) === 0){ startsWith.push(item); return; }
      var isWordStart = n.split(" ").some(function(w){ return w.indexOf(q) === 0; });
      if(isWordStart){ wordStart.push(item); return; }
      if(n.indexOf(q) !== -1) contains.push(item);
    });

    var tier = startsWith.length ? startsWith : (wordStart.length ? wordStart : contains);
    return sortByText(tier, text);
  }

  global.LyonSubjectSearch = {
    normalize: normalize,
    filterAndSortSubjects: filterAndSortSubjects,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
