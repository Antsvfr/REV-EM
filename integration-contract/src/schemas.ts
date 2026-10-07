import { z } from "zod";
import { isoDate, isoDateTime, opaqueId, safeText, sha256Hex, strict, uuid, versionField } from "./common.ts";

/* ═══════════════════════════════════════════════════════════════════════════
   Ce que contient le contrat — et ce qu'il ne contient JAMAIS
   ───────────────────────────────────────────────────────────────────────────
   • des RÉFÉRENCES (identifiants opaques, titres, dates, statuts) ; jamais les notes, la
     transcription, l'audio ni le contenu d'un support — ils restent chez LexNote ;
   • jamais l'identifiant d'utilisateur, l'e-mail ou le nom d'une des deux applications : l'identité
     est portée par un LIEN pseudonyme (IntegrationUserLink.linkId) établi côté serveur ;
   • les champs « hint » sont des INDICATIONS non fiables : l'application qui reçoit les revalide
     contre ses propres données avant tout usage.
   ═══════════════════════════════════════════════════════════════════════════ */

export const COURSE_KINDS = ["CM", "TD", "TP", "OTHER", "UNKNOWN"] as const;

/* Une séance du planning REV-EM (REV-EM = source de vérité du planning).
   Référence stable = (revemEventId, occurrenceStart) : une série récurrente est développée en
   occurrences qui partagent l'UID ICS ; l'UID seul ne désigne pas UNE séance. */
export const RevemCourseEvent = strict({
  integrationVersion: versionField,
  eventRef: strict({
    revemEventId: opaqueId,
    icsUid: safeText(255).optional(),
    occurrenceStart: isoDateTime,
  }),
  title: safeText(200),
  start: isoDateTime,
  end: isoDateTime,
  allDay: z.boolean(),
  location: safeText(200).optional(),
  kind: z.enum(COURSE_KINDS),
  subject: strict({
    revemSubjectId: opaqueId.optional(),
    /** INDICATION non fiable : le receveur la rapproche de SES matières, il ne la crée pas aveuglément. */
    nameHint: safeText(120).optional(),
  }),
}).refine((e) => Date.parse(e.end) >= Date.parse(e.start), { message: "end avant start", path: ["end"] });
export type RevemCourseEvent = z.infer<typeof RevemCourseEvent>;

/* Une séance LexNote (LexNote = source de vérité des notes, transcriptions, supports).
   RÉFÉRENCE seulement : titre, date, statut, présence de capture. Jamais le contenu. */
export const SESSION_STATUSES = ["in_progress", "completed"] as const;
export const LexNoteSessionReference = strict({
  integrationVersion: versionField,
  lexnoteSessionId: opaqueId,
  title: safeText(200),
  date: isoDate,
  status: z.enum(SESSION_STATUSES),
  number: z.number().int().min(0).max(999).nullable().optional(),
  capture: strict({
    hasAudio: z.boolean(),
    hasTranscript: z.boolean(),
    transcriptWords: z.number().int().min(0),
    audioMs: z.number().int().min(0),
  }).optional(),
  /** Rattachement éventuel à l'événement REV-EM qui a lancé la séance (réconciliation, jamais une confiance). */
  revemEventRef: strict({ revemEventId: opaqueId, occurrenceStart: isoDateTime }).optional(),
  updatedAt: isoDateTime,
});
export type LexNoteSessionReference = z.infer<typeof LexNoteSessionReference>;

/* Provenance et vérification : les MÊMES valeurs que LexNote (domain/legal.ts). REV-EM ne les
   « améliore » jamais : un support dont la provenance est AI ou UNKNOWN n'est pas présenté comme vérifié. */
export const PROVENANCES = ["PROFESSOR", "USER_NOTE", "DOCUMENT", "TRANSCRIPTION", "AI", "VERIFIED_SOURCE", "UNKNOWN"] as const;
export const VERIFICATIONS = ["VERIFIED", "UNVERIFIED", "POTENTIAL_CONFLICT", "NEEDS_REVIEW"] as const;
export const ARTIFACT_TYPES = ["INTELLIGENT_COURSE", "SUMMARY", "STUDY_SHEET", "MIND_MAP", "DIAGRAM", "FLASHCARDS", "QUIZ"] as const;

/* Un support généré par LexNote (cours intelligent, fiche, carte mentale…). RÉFÉRENCE seulement :
   le contenu reste chez LexNote ; REV-EM l'ouvre par lien profond (openPath), ne le copie pas. */
export const StudyArtifactReference = strict({
  integrationVersion: versionField,
  artifactId: opaqueId,
  lexnoteSessionId: opaqueId,
  type: z.enum(ARTIFACT_TYPES),
  title: safeText(200),
  generatedAt: isoDateTime,
  provenance: z.enum(PROVENANCES),
  verification: z.enum(VERIFICATIONS),
  generatedBy: strict({ providerId: safeText(64), model: safeText(128) }).optional(),
  /** Empreinte du contenu au moment de la référence : détecte une version périmée sans transporter le contenu. */
  contentSha256: sha256Hex.optional(),
  /** Chemin LexNote relatif, validé par deeplinks.ts (jamais une URL absolue venue du réseau). */
  openPath: z.string().regex(/^\/artifact\/[A-Za-z0-9_.:\-]{1,128}$/),
});
export type StudyArtifactReference = z.infer<typeof StudyArtifactReference>;

/* Le LIEN entre un utilisateur REV-EM et une installation LexNote.
   LexNote n'a pas de compte : `peer` désigne l'AUTRE application par une référence opaque.
   Côté REV-EM : peer = installation LexNote. Côté LexNote : peer = linkId pseudonyme REV-EM
   (jamais l'identifiant d'authentification, jamais l'e-mail). */
export const LINK_STATUSES = ["pending", "active", "revoked", "expired"] as const;
export const LINK_SCOPES = ["session:open", "artifact:read", "event:read"] as const;
export const IntegrationUserLink = strict({
  integrationVersion: versionField,
  linkId: uuid,
  status: z.enum(LINK_STATUSES),
  scopes: z.array(z.enum(LINK_SCOPES)).min(1).max(LINK_SCOPES.length),
  createdAt: isoDateTime,
  activatedAt: isoDateTime.optional(),
  revokedAt: isoDateTime.optional(),
  expiresAt: isoDateTime.optional(),
  peer: strict({ app: z.enum(["revem", "lexnote"]), externalReference: opaqueId }),
});
export type IntegrationUserLink = z.infer<typeof IntegrationUserLink>;

/* L'INTENTION « ouvrir (ou créer) la séance de LexNote pour cet événement ».
   Elle est conservée CÔTÉ SERVEUR REV-EM ; l'URL ne transporte qu'un jeton court qui la désigne
   (voir token.ts) — jamais l'événement lui-même, jamais un identifiant d'utilisateur. */
export const CourseSessionIntent = strict({
  integrationVersion: versionField,
  intentId: uuid,
  action: z.literal("open_or_create_session"),
  event: RevemCourseEvent,
  requestedAt: isoDateTime,
  expiresAt: isoDateTime,
}).refine((i) => Date.parse(i.expiresAt) > Date.parse(i.requestedAt), { message: "expiresAt ≤ requestedAt", path: ["expiresAt"] });
export type CourseSessionIntent = z.infer<typeof CourseSessionIntent>;
