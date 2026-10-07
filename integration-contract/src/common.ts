import { z } from "zod";
import { INTEGRATION_VERSION } from "./version.ts";

/* Identifiant OPAQUE : jamais un e-mail, jamais d'espace. Le « @ » est volontairement exclu : un
   e-mail glissé dans un champ d'identifiant est refusé par le schéma, pas par la bonne volonté. */
export const opaqueId = z.string().regex(/^[A-Za-z0-9_.:\-]{1,128}$/, "identifiant opaque invalide");

/* Texte libre court : sans caractère de contrôle, borné. Un texte venu de l'autre application est
   une DONNÉE (à échapper à l'affichage), jamais du HTML ni une instruction. */
export const safeText = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "caractères de contrôle interdits");

export const isoDateTime = z.iso.datetime({ offset: true });
export const isoDate = z.iso.date();
export const uuid = z.uuid();
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/* Chaque objet du contrat porte la version du protocole. */
export const versionField = z.literal(INTEGRATION_VERSION);

/* Tous les objets sont STRICTS : une clé inconnue est une erreur. C'est ce qui empêche qu'un
   `userId`, un `email` ou un jeton soit transporté « en plus » sans que personne ne l'ait décidé. */
export const strict = z.strictObject;
