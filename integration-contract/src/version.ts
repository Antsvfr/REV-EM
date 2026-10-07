/* Version du PROTOCOLE d'intégration (pas celle d'une application).
   Règles d'évolution :
   - ajouter un champ OPTIONNEL ne change pas la version ;
   - retirer/renommer un champ, changer un sens, durcir une contrainte → version suivante ("2") ;
   - une application accepte les versions listées dans SUPPORTED_VERSIONS et REFUSE les autres
     (jamais « on essaie quand même »). Pendant une migration, elle en liste deux. */
export const INTEGRATION_VERSION = "1" as const;
export const SUPPORTED_VERSIONS = ["1"] as const;
export type IntegrationVersion = (typeof SUPPORTED_VERSIONS)[number];

export function isSupportedVersion(v: unknown): v is IntegrationVersion {
  return typeof v === "string" && (SUPPORTED_VERSIONS as readonly string[]).includes(v);
}
