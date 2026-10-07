import { opaqueId } from "./common.ts";

/* ═══════════════════════════════════════════════════════════════════════════
   Liens profonds
   ───────────────────────────────────────────────────────────────────────────
   RÈGLES
   • Une URL ne porte JAMAIS : identifiant d'utilisateur, e-mail, nom de matière, donnée de cours.
     Elle porte au plus un identifiant OPAQUE d'objet et, pour un lancement, un jeton court signé.
   • Le jeton est dans le FRAGMENT (#t=…), pas dans la requête : un fragment n'est ni envoyé au
     serveur, ni dans les journaux d'accès, ni dans l'en-tête Referer.
   • Un lien est une INTENTION de navigation, pas une autorisation : l'autorisation vient du jeton
     vérifié et du lien (IntegrationUserLink), jamais de l'URL.

   REV-EM est un site STATIQUE (GitHub Pages) sans routeur : pas de réécriture serveur possible. Ses
   routes sont donc dans le fragment (`#/course/<id>`). LexNote est une application React
   (react-router, BrowserRouter) : ses routes sont des chemins.
   ═══════════════════════════════════════════════════════════════════════════ */

export const LEXNOTE_PATHS = {
  /** Point d'entrée d'un lancement depuis REV-EM (jeton dans le fragment). */
  launch: "/integrations/revem/session",
  /** Alias intégration : redirige vers la route existante `/session/:id` de LexNote. */
  course: (sessionId: string) => `/course/${enc(sessionId)}`,
  artifact: (artifactId: string) => `/artifact/${enc(artifactId)}`,
} as const;

export const REVEM_ROUTES = {
  course: (eventId: string) => `#/course/${enc(eventId)}`,
  revision: (subjectId: string) => `#/revision/${enc(subjectId)}`,
} as const;

function enc(id: string): string {
  if (!opaqueId.safeParse(id).success) throw new Error("identifiant opaque invalide : " + String(id).slice(0, 40));
  return id; // l'alphabet d'opaqueId n'exige aucun échappement
}

export type LexNoteTarget =
  | { kind: "launch" }
  | { kind: "course"; sessionId: string }
  | { kind: "artifact"; artifactId: string };

export type RevemTarget =
  | { kind: "course"; eventId: string }
  | { kind: "revision"; subjectId: string };

const ID = "([A-Za-z0-9_.:\\-]{1,128})";

/** Analyse un chemin LexNote. Retourne null pour tout ce qui n'est pas EXACTEMENT une route d'intégration. */
export function parseLexNotePath(pathname: string): LexNoteTarget | null {
  if (pathname === LEXNOTE_PATHS.launch) return { kind: "launch" };
  let m = new RegExp(`^/course/${ID}$`).exec(pathname);
  if (m) return { kind: "course", sessionId: m[1] };
  m = new RegExp(`^/artifact/${ID}$`).exec(pathname);
  if (m) return { kind: "artifact", artifactId: m[1] };
  return null;
}

/** Analyse le fragment REV-EM (`#/course/<id>`, `#/revision/<id>`). */
export function parseRevemHash(hash: string): RevemTarget | null {
  let m = new RegExp(`^#/course/${ID}$`).exec(hash);
  if (m) return { kind: "course", eventId: m[1] };
  m = new RegExp(`^#/revision/${ID}$`).exec(hash);
  if (m) return { kind: "revision", subjectId: m[1] };
  return null;
}

/** Lien de lancement LexNote : le jeton court voyage dans le fragment. */
export function buildLexNoteLaunchUrl(lexnoteOrigin: string, token: string): string {
  if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(token)) throw new Error("jeton mal formé");
  return `${assertOrigin(lexnoteOrigin)}${LEXNOTE_PATHS.launch}#t=${token}`;
}

export function buildLexNoteUrl(lexnoteOrigin: string, path: string): string {
  if (!parseLexNotePath(path)) throw new Error("chemin LexNote non autorisé");
  return `${assertOrigin(lexnoteOrigin)}${path}`;
}

/** Lit le jeton dans un fragment `#t=…` (et nulle part ailleurs). */
export function readTokenFromHash(hash: string): string | null {
  const m = /^#t=([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)$/.exec(hash);
  return m ? m[1] : null;
}

/* Une origine (https://hôte[:port], sans chemin) — http n'est admis que pour localhost. */
export function assertOrigin(origin: string): string {
  let u: URL;
  try { u = new URL(origin); } catch { throw new Error("origine invalide"); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "https:" || (local && u.protocol === "http:"))) throw new Error("origine non sécurisée");
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("origine : pas de chemin ni d'identifiants");
  return u.origin;
}

/* Un retour (returnTo) n'est accepté que s'il pointe vers une origine de la liste blanche. */
export function isAllowedReturn(candidate: string, allowedOrigins: readonly string[]): boolean {
  try {
    const u = new URL(candidate);
    return allowedOrigins.includes(u.origin) && !u.username && !u.password;
  } catch { return false; }
}
