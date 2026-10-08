/* ============================================================================
   connected-apps.js — logique PURE de « Réglages › Applications connectées » (liaison REV-EM ⇄ LexNote)
   ----------------------------------------------------------------------------
   `globalThis.RevemLinks` — même patron que course-hub.js : ni DOM, ni `state`, ni Supabase. Testable sous Node :
   `node tests/connected-apps.test.js`.

   CE QU'IL FAIT : transformer l'état renvoyé par l'Edge Function `integration-link` (contrat lexnote-revem/v1,
   « connection-state ») en un modèle d'affichage ; valider l'URL d'autorisation avant d'y envoyer l'étudiant ;
   lire (et nettoyer) le paramètre de retour `?lexnote_link=connected` — l'URL ne PROUVE rien, l'état est toujours
   revérifié côté serveur.

   CE QU'IL NE FAIT PAS : appeler le réseau, stocker quoi que ce soit, manipuler un jeton. Aucun secret ne transite par
   le navigateur : la signature inter-applications vit uniquement dans les Edge Functions.
   ============================================================================ */
(function(global){
  "use strict";

  var RETURN_PARAM = "lexnote_link";

  /* « Connecté » exige que les DEUX côtés l'affirment (verified) : jamais une simple ligne locale. */
  function describe(conn, err){
    if(!conn){
      if(err) return { kind: "error", reason: errorReason(err.code) };
      return { kind: "loading" };
    }
    switch(conn.state){
      case "CONNECTED":
        return conn.verified === true && conn.peerStatus === "CONNECTED"
          ? { kind: "connected", since: conn.linkedAt || null }
          : { kind: "pending" };
      case "NOT_CONNECTED": return { kind: "not_connected" };
      case "PENDING":       return { kind: "pending" };
      case "REVOKED":       return { kind: "revoked", by: conn.revokedBy || null, at: conn.revokedAt || null };
      default:              return { kind: "error", reason: conn.errorCode === "PEER_UNREACHABLE" ? "unreachable" : conn.errorCode === "PEER_MISSING" ? "missing" : "generic" };
    }
  }

  function errorReason(code){
    switch(code){
      case "UNAVAILABLE": case "TIMEOUT": case "OFFLINE": return "unreachable";
      case "CONFLICT": return "already";
      case "INTERNAL": return "unconfigured";
      default: return "generic";
    }
  }

  /* Seules les actions suivantes sont proposées à l'étudiant selon l'état affiché. */
  function actions(view){
    return {
      connect:    view.kind === "not_connected" || view.kind === "revoked" || (view.kind === "error" && view.reason !== "unreachable" && view.reason !== "unconfigured"),
      disconnect: view.kind === "connected" || view.kind === "pending" || (view.kind === "error" && view.reason !== "unconfigured"),
      verify:     view.kind !== "loading",
    };
  }

  /* L'URL vient de NOTRE Edge Function, mais on ne redirige jamais sur une valeur non vérifiée :
     https obligatoire (http seulement vers localhost), aucun identifiant dans l'URL, aucun autre schéma. */
  function safeConfirmUrl(u){
    try{
      var x = new URL(String(u));
      if(x.username || x.password) return null;
      var local = x.hostname === "localhost" || x.hostname === "127.0.0.1";
      if(x.protocol === "https:" || (x.protocol === "http:" && local)) return x.toString();
      return null;
    }catch(e){ return null; }
  }

  /* Retour de LexNote : `?lexnote_link=connected`. Renvoie le statut lu et la query nettoyée (sans le paramètre). */
  function parseReturn(search){
    var p = new URLSearchParams(search || "");
    var v = p.get(RETURN_PARAM);
    if(v === null) return { status: null, cleanSearch: search || "" };
    p.delete(RETURN_PARAM);
    var rest = p.toString();
    return { status: v === "connected" ? "connected" : "unknown", cleanSearch: rest ? "?" + rest : "" };
  }

  global.RevemLinks = { RETURN_PARAM: RETURN_PARAM, describe: describe, actions: actions, safeConfirmUrl: safeConfirmUrl, parseReturn: parseReturn, errorReason: errorReason };
})(typeof globalThis !== "undefined" ? globalThis : this);
