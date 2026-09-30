/* ============================================================
   ai-worker.js — Worker de l'assistant IA local (inférence hors thread principal)
   ------------------------------------------------------------
   Chargé par index.html via : new Worker("ai-worker.js", { type: "module" })
   Ce fichier ne contient que le BRANCHEMENT ; toute la logique (protocole,
   machine d'états, un seul moteur WebLLM, erreurs classées) est dans
   ai-host.js, partagée avec le mode « fil principal » de secours. Voir
   ai-host.js pour la description complète du protocole.

   Aucune clé API, aucun serveur à toi : les poids du modèle sont téléchargés
   par le navigateur de l'utilisateur depuis Hugging Face puis mis en cache
   par le navigateur lui-même. La bibliothèque WebLLM est chargée à la demande
   (import dynamique) à la version épinglée de ai-engine.js.
   ============================================================ */
import { createAiHost } from "./ai-host.js";

const host = createAiHost((msg) => self.postMessage(msg), { context: "worker" });

/* Toute erreur non gérée du worker est renvoyée STRUCTURÉE à la page : sans
   cela, la page ne voyait qu'un événement `error` vide. */
function reportWorkerError(e){
  const message = (e && (e.message || (e.reason && (e.reason.message || String(e.reason))))) || "erreur inconnue dans le worker";
  self.postMessage({ type: "WORKER_ERROR", id: null, state: host.state, message: String(message).slice(0, 500), filename: (e && e.filename) || "" });
}
self.addEventListener("error", reportWorkerError);
self.addEventListener("unhandledrejection", reportWorkerError);

self.onmessage = (event) => host.handle(event.data);

/* Poignée de main : la page sait ainsi que le worker a bien démarré et que ses
   imports locaux sont évalués (avant de lui confier un chargement de plusieurs Go). */
self.postMessage({ type: "WORKER_READY", id: null, state: host.state, webllmVersion: globalThis.RevemAI.WEBLLM_VERSION });
