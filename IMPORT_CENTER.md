# Import Center — audit, architecture, compatibilité, frontière avec la Phase 2

Phase 1 : **un seul espace pour importer un cours**, sélection/dépôt fiables,
validation réelle, états propres, erreurs claires, et une frontière nette vers
l'automatisation (Phase 2, **non commencée**).

Étiquettes utilisées (comme dans `AI_AUDIT.md`) : **PASS** = vérifié pour de vrai
ici · **PASS MOCK** = vérifié contre un double · **NOT TESTED** = non vérifiable
dans cet environnement · **NOT TESTED WEBKIT / WKWEBVIEW** = exige Safari/WebKit ou
le vrai `REV-EM.app`.

## 1. Audit de l'ancien système (avant toute modification)

**Combien de systèmes d'import de cours ?** Un seul *pipeline* (`state.courseImport`
→ `courseImportStart` → `courseImportProcessFile` → détection → confirmation →
génération), mais **deux interfaces qui le dupliquaient** :
1. la page « Importer un cours » de la bibliothèque (`renderImportPick`) : zone de
   dépôt + texte collé + file de 10 fichiers ;
2. la carte « Automatiser mes révisions » de la page Ressources
   (`renderCourseAutomationCard`) : **la même zone de dépôt copiée**, avec les mêmes
   `id="import-dropzone"` / `id="import-file-input"` (identifiants dupliqués).

Les autres `<input type="file">` du site sont **d'autres fonctions**, pas des imports
de cours : sauvegarde JSON (`catalog-import-input`, `settings-import-input`),
calendrier `.ics` (`planning-ics-input`), sujets d'examen (`exams-sujet-input`),
texte de contexte de l'assistant (`ai-file-input`), avatar (`account-avatar-input`).
Elles n'ont pas été touchées.

**Points d'entrée trouvés : 11**, dont **9 aboutissaient à la même page** :

| # | Où | Avant | Après |
|---|---|---|---|
| 1 | Tableau de bord — tuile « Importer un cours » (`quick-actions.js`) | `goToCourseImport(); switchTab("library")` (quitte le tableau de bord) | `openImportCenter` par-dessus la page |
| 2 | Tableau de bord — état vide (`data-dash-import`) | idem | idem |
| 3 | Barre de navigation Ressources → « Importer un cours » | idem | idem |
| 4 | Command Center (Ctrl+K) | idem | idem |
| 5 | Mes matières — bouton d'en-tête | `goToCourseImport()` | idem |
| 6 | Une matière — « Importer un cours » | `goToCourseImport(subjectId)` | idem, **contexte affiché et transmis** |
| 7 | Ressources — carte d'automatisation | **seconde zone de dépôt** | un bouton vers le même Import Center |
| 8 | Révision intelligente — état vide | `goToCourseImport(); switchTab(…)` | idem |
| 9 | Mes statistiques — état vide | idem | idem |
| 10 | Assistant IA — « Importer et enregistrer sans IA » | idem | idem |
| 11 | Page « Importer un cours » de la bibliothèque | zone de dépôt complète | **supprimée** (vue de secours : un seul bouton) |

**Problèmes trouvés (PASS : lecture du code, plusieurs reproduits en test) :**
- **D1 — clignotement du glisser-déposer** : `dragover`/`dragleave` appelaient
  `render()` de toute la page ; `dragleave` se déclenche aussi en passant sur chaque
  enfant. La zone était détruite et recréée pendant le glissement.
- **D2 — aucun garde contre le dépôt hors zone** : déposer un PDF à côté de la zone
  fait **quitter l'application** (le navigateur — ou le WKWebView de REV-EM.app —
  navigue vers le fichier).
- **D3 — validation tardive et superficielle** : le type était déduit du **nom**
  (`courseFileKind`), la taille et le format vérifiés seulement au traitement. Un
  « .pdf » qui n'en est pas un partait vers PDF.js.
- **D4 — erreurs techniques affichées** : `item.error = e.message` montrait
  « Invalid PDF structure. » (message de PDF.js) à l'utilisateur.
- **D5 — PDF protégé par mot de passe** : même chemin, même message technique.
- **D6 — lecteur PDF jamais libéré** (`doc.destroy()` absent) et lecture **non
  annulable**.
- **D7 — fichiers en trop ignorés en silence** (`slice(0, 10 - …)`), doublons non
  détectés dans la file.
- **D8 — chaque point d'entrée arrachait l'utilisateur à sa page** (`switchTab("library")`).
- **D9 — interface d'import non traduite** (français en dur), `<input>` en
  `display:none`, dropzone `role="button"` contenant un `<input>` (interactif imbriqué).
- **D10 — deux zones de dépôt avec les mêmes `id`**.

**Fonctions encore nécessaires (conservées) :** tout le pipeline à partir de
`courseImportStart` (détection, confirmation, génération, reprise, dédoublonnage de
chapitre), `extractCourseFileText`/`extractPdfText`/`extractDocxText` (étendues, pas
réécrites), `courseImportRemoveFile`, `courseImportAddPasteAsFile` (devenue un
adaptateur autour de `courseImportAddPrepared`, gardée pour la compatibilité).
**Supprimées / fusionnées :** `courseImportAddFiles` (remplacée par
`courseImportAddPrepared`), la zone de dépôt de `renderImportPick` et de
`renderCourseAutomationCard`, tous les écouteurs `dragover/dragleave/drop` locaux,
`goToCourseImport`→ simple alias vers `openImportCenter`, et le CSS `.import-dropzone*`
/ `.import-filelist` / `.import-file-row`.

## 2. Architecture

**Avant** — 9 boutons → `goToCourseImport()` → page bibliothèque (vue `import`) avec sa
propre zone de dépôt ; 1 bouton → seconde zone de dépôt dans Ressources ; validation
et extraction mélangées dans `courseImportProcessFile`.

**Après**

```
Dashboard · Mes matières · Une matière · Ressources · Nav · Ctrl+K · états vides
   │  data-import-center="<origine>"  (UN écouteur global)   ou   openImportCenter()
   ▼
openImportCenter({ contextSubjectId, origin })          ← import-center.js (logique pure) :
   │  fenêtre modale (`.modal--import`, feuille sur mobile)   validateMeta / validateContent /
   │  IDLE → (DRAGGING) → VALIDATING → READY                  machine d'états / ImportResult
   │       → PROCESSING → SUCCESS   (ou ERROR, à tout moment)
   ▼
icProcess() : lit le contenu (PDF.js / mammoth / texte), étapes RÉELLES, annulable
   ▼
ImportResult { file, filename, mimeType, size, kind, extractedText, charCount,
               numPages, truncated, sourceContext:{subjectId, origin, importedAt} }
   ▼
icHandoff(result)   ←──── LA FRONTIÈRE (voir §8)
   ▼
courseImportAddPrepared(result) → courseImportStart()   (pipeline existant, inchangé)
```

Fichiers : `import-center.js` (nouveau, pur, 106 vérifications sous Node),
`index.html` (§7ter-bis, ≈ 400 lignes : DOM et événements), `translations.js`
(67 clés × 5 langues), `sw.js` (précache, `rev-em-v5`).

**Emplacement final :** l'import n'est plus une *page* mais une **fenêtre**, ouverte
depuis n'importe où sans quitter la page courante. Le tableau de bord reste propre : il
ne garde que la tuile principale (« Importer un cours — Ajoute un PDF et REV-EM
s'occupe du reste »). Décision : une modale large (720 px, feuille ancrée en bas sur
mobile) plutôt qu'une vue dédiée, parce que l'import est un geste ponctuel qui doit
s'ouvrir *depuis* le contexte (matière, tableau de bord) et y revenir.

## 3. Glisser-déposer

- **Compteur** d'entrées/sorties (`dragDepth`) : `dragenter`/`dragleave` se déclenchent
  aussi sur chaque enfant ; sans compteur la zone clignote. Testé : 4 passages
  enfant/parent → l'état reste `DRAGGING`, **zéro redessin** (MutationObserver).
- Le survol n'allume qu'une **classe CSS** ; aucun `render()`.
- `dragover` fait `preventDefault()` (sans cela le navigateur refuse le dépôt) ;
  seuls les glissers qui contiennent des **fichiers** sont pris en compte (un texte
  glissé est ignoré).
- **Garde de fenêtre (D2)** : Import Center fermé, déposer un fichier sur la fenêtre
  **n'emmène plus l'application ailleurs** ; cela ouvre l'Import Center avec le fichier.
- Un seul chemin : sélecteur et dépôt appellent `icAcceptFiles()` (`validateMeta` →
  lecture des 4 premiers Ko → `validateContent`). Plusieurs fichiers déposés : le
  premier est retenu et **l'interface le dit** (« Un seul fichier à la fois »).

## 4. Sélecteur de fichiers

Un **seul** `<input type="file">` par ouverture, hors du rendu, ouvert par **une seule**
fonction (`icOpenPicker`) — appelée par le bouton « Choisir un fichier », « Remplacer »,
et un clic souris sur la zone (le bouton ne double pas l'appel). `accept` contient les
extensions **et** les types MIME (`.pdf,application/pdf,.docx,…`). L'input est masqué
visuellement (pas `display:none`, capricieux dans certaines WebView) et remis à zéro
après chaque choix (re-choisir le même fichier redéclenche `change`). Aucune API
Chromium (`showOpenFilePicker`, File System Access) — vérifié par test.

## 5. Formats annoncés = formats lus

PDF (PDF.js), DOCX (mammoth), TXT, Markdown, et le texte collé (fonction conservée,
dans un volet repliable). **Testés avec les vraies bibliothèques** (PDF.js 4.0.379 et
mammoth, installées depuis npm et servies à la place du CDN) sur de vrais fichiers.
PPTX, images, `.doc`, tableurs : reconnus et **refusés proprement**, avec le message
« Les fichiers .pptx ne sont pas encore pris en charge. Exporte ton cours en PDF, ou
colle son texte. » Pas d'OCR, et l'interface ne le prétend pas.

## 6. Validations et erreurs

`validateMeta` (présent, non vide, ≤ 15 Mo, format) puis `validateContent` (signature
réelle : `%PDF-` dans les 1 024 premiers octets, ZIP `PK` pour DOCX, absence d'octet
nul pour le texte) puis, au traitement, les erreurs de PDF.js/mammoth classées :

| Cas | Code | Message (FR) | Action proposée |
|---|---|---|---|
| Fichier vide | `EMPTY` | Ce fichier est vide. | autre fichier |
| > 15 Mo | `TOO_LARGE` | Le document est trop volumineux (16 Mo). La limite est de 15 Mo. | autre fichier |
| Extension inconnue / PPTX / image | `UNSUPPORTED[_KNOWN]` | … pas encore pris en charge … | autre fichier |
| « .pdf » qui n'en est pas un | `NOT_A_PDF` | Ce fichier n'est pas un PDF valide. | autre fichier |
| PDF endommagé | `INVALID_PDF` | REV-EM n'a pas réussi à lire ce PDF : il semble endommagé. | autre fichier |
| PDF protégé | `PASSWORD_PROTECTED` | Ce PDF est protégé par un mot de passe… | autre fichier |
| PDF sans texte | `NO_TEXT` | REV-EM n'a pas trouvé de texte exploitable… | autre fichier |
| Lecteur injoignable | `READER_LOAD_FAILED` | … Vérifie ta connexion internet… | **Réessayer** |
| Lecture interrompue / autre | `INTERRUPTED` / `EXTRACT_FAILED` | … Tu peux réessayer. | **Réessayer** |
| Génération IA déjà en cours | `ENGINE_BUSY` | Une génération est déjà en cours… | **Réessayer** |

Une erreur de validation **ne ferme jamais** la fenêtre : elle s'affiche (`role="alert"`)
au-dessus de la zone, qui reste utilisable. Le détail technique va à la **console**
(`[REV-EM · Import]`), jamais à l'écran. Un PDF sans texte n'est **jamais** transmis à
l'automatisation (`NO_TEXT`).

## 7. Machine d'états, progression, annulation

Une seule variable `state` (`IDLE, DRAGGING, VALIDATING, READY, PROCESSING, SUCCESS,
ERROR`), table de transitions dans `import-center.js` : les états impossibles ne sont
pas représentables. Le double clic sur « Importer » est neutralisé **par la machine**
(`beginProcess()` n'est possible que depuis `READY`) ; deux événements du même fichier
à < 1,2 s sont une seule intention. Testé : 3 clics → **un** démarrage du pipeline.

**Progression** : uniquement des étapes réelles — « Préparation du document… » →
« Ouverture du lecteur PDF… » → « Lecture du PDF : page 4 sur 9… ». La barre n'existe que
quand un progrès est **mesurable** (pages PDF) ; sinon un spinner et le nom de l'étape.
Aucun pourcentage inventé. **Annulation** : « Annuler la lecture » (et Échap) arrête
réellement la lecture entre deux pages et **conserve le fichier**.

## 8. PRÊT POUR PHASE 2

**Point d'entrée unique à remplacer : `icHandoff(result)`** (`index.html`, §7ter-bis).

- **Entrée** : `result` est un `ImportResult` (`RevemImport.buildImportResult`) —
  `{ file, filename, mimeType, size, kind, extractedText, charCount, numPages, truncated,
  sourceContext:{ subjectId, origin, importedAt } }`. `subjectId` est la matière imposée
  quand l'import part d'une matière (sinon `null`) ; `origin` dit d'où l'utilisateur est
  parti (`dashboard | nav | subjects | subject | resources | command-center |
  empty-state | ai-panel | window-drop | result | wizard`).
- **Aujourd'hui** : `icHandoff` ferme la fenêtre, crée un import vierge
  (`freshCourseImportState(subjectId)`), appelle `courseImportAddPrepared(result)` puis
  `courseImportStart()` (détection → confirmation → génération : le pipeline de
  `COURSE_PIPELINE_AUDIT.md`).
- **Phase 2** : classement (matière / chapitre), génération, sauvegarde, synchronisation
  se branchent **ici** : soit en remplaçant le corps de `icHandoff`, soit en faisant de
  `courseImportAddPrepared` l'entrée de la nouvelle chaîne. Le texte est **déjà extrait**
  (`preExtracted`), le `File` d'origine est conservé (le PDF est stocké dans IndexedDB par
  `courseImportResolveTarget`). Rien d'autre n'a à changer dans l'Import Center.
- **Sortie déjà disponible pour la suite** : `sourceContext.subjectId` alimente
  `lockedSubjectId` (matière imposée) — le contexte « import depuis Finance » est déjà
  transmis de bout en bout.

## 9. WKWebView / REV-EM.app — le sélecteur de fichiers

### Cause du bouton « Importer un cours » qui n'ouvrait rien sur Mac
Sur **macOS**, WKWebView n'ouvre **aucun** panneau de fichiers par lui-même. `input.click()` (ou un clic sur
`<input type="file">`) demande à l'application hôte d'afficher le panneau via
`WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`. **Si l'application n'implémente pas cette
méthode, WebKit se comporte comme si l'utilisateur avait cliqué « Annuler »** (documentation Apple de cette méthode) :
rien ne s'ouvre, aucune erreur n'est levée, la page ne reçoit rien. Le code de la page était correct (un seul
`<input type="file">` présent dans le DOM, jamais supprimé par un rendu, identifiant unique, non désactivé, non
`display:none`, `input.click()` appelé dans le geste de l'utilisateur, `change` écouté) — la correction est **native**.

L'ancienne version de cette section affirmait « aucun code Swift n'est requis pour un `<input type="file">` simple » :
**c'était faux pour macOS** (vrai sur iOS, où WKWebView a un sélecteur par défaut).

### ACTION XCODE REQUISE (le projet macOS n'est pas dans ce dépôt)
Fichier prêt à intégrer : **`macos/REVEMOpenPanel.swift`** (non compilé ici : aucun compilateur Swift dans cet
environnement — à compiler dans Xcode).
1. Ajouter `macos/REVEMOpenPanel.swift` à la cible macOS de REV-EM.app (Xcode → *File → Add Files to…*, cocher la cible).
2. Dans la classe qui est le `WKUIDelegate` du WKWebView (là où `webView.uiDelegate = …` est défini), ajouter :
   ```swift
   func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
       REVEMOpenPanel.present(for: webView, parameters: parameters, completionHandler: completionHandler)
   }
   ```
   S'il n'existe **aucun** `WKUIDelegate` : `webView.uiDelegate = REVEMWebUIDelegate.shared` (gère aussi `alert()` /
   `confirm()`, que WKWebView macOS ignore sinon). Ne pas créer un second délégué s'il en existe déjà un : il
   remplacerait celui qui gère les autres panneaux.
3. **Seulement si l'app est sandboxée** (*Signing & Capabilities → App Sandbox*) : *File Access → User Selected File* =
   **Read Only**, soit `com.apple.security.files.user-selected.read-only` = `YES`. C'est la seule permission nécessaire :
   le fichier choisi dans le panneau est alors lisible, rien d'autre sur le disque. Pas d'accès global, pas d'écriture.
4. Recompiler, puis faire le test F ci-dessous.

Le glisser-déposer depuis le Finder et « Coller le texte » ne dépendent PAS de cette méthode : ils fonctionnent déjà.

### Ce que fait la page en attendant (et pour toujours, comme filet de sécurité)
- « Importer un cours » ouvre **directement** le sélecteur, dans le même geste (l'Import Center s'affiche derrière pour
  recevoir le fichier, le vérifier, le remplacer, ou accepter un dépôt / un texte collé).
- Chaque ouverture est **surveillée** (`icWatchPicker`, verdict pur `RevemImport.pickerVerdict`) : une vraie fenêtre fait
  perdre le focus à la page ; un fichier revient (`change`) ; ou l'utilisateur annule (`cancel`, ce n'est **pas** une
  panne). Annulation instantanée sans fenêtre, ou aucun signe après 1,5 s → alerte « Aucune fenêtre de sélection ne s'est
  ouverte » avec ce qui marche (glisser le fichier, coller le texte, réessayer) ; dans l'app Mac (détectée par
  `RevemImport.isEmbeddedWebKit`), l'alerte précise qu'une mise à jour de l'application est nécessaire.
- Limite connue : dans un navigateur qui ne signalerait pas la perte de focus à l'ouverture de sa fenêtre, l'alerte
  pourrait apparaître derrière une fenêtre réellement ouverte si l'utilisateur met plus de 1,5 s à choisir ; elle
  disparaît dès qu'un fichier arrive. Formulation volontairement non alarmante.

**NOT TESTED WKWEBVIEW / NOT TESTED SAFARI** : ni Safari/WebKit ni `REV-EM.app` ne sont disponibles ici. Le comportement
« le sélecteur ne s'ouvre pas » est SIMULÉ dans Chromium (`tests/import-picker.test.mjs`, scénario 5).

## 10. Test manuel (très court)
- **A** Tableau de bord → « Importer un cours » : le sélecteur de fichiers s'ouvre aussitôt ; l'Import Center est derrière.
- **B** « Choisir un fichier » → un PDF → « Fichier prêt » → « Importer le cours ».
- **C** Glisser un PDF depuis le Finder sur la fenêtre (et aussi hors de la fenêtre).
- **D** Un `.pptx` et un PDF protégé : message clair, la fenêtre reste ouverte.
- **E** Mobile / fenêtre étroite : feuille en bas, bouton pleine largeur.
- **F — REV-EM.app (macOS)** : après l'action Xcode du §9 — « Importer un cours » → le panneau du Finder s'ouvre → choisir
  un PDF → « Fichier prêt » → « Importer le cours » → page du cours ; puis Annuler le panneau (aucune alerte) ; puis
  glisser un PDF depuis le Finder. Avant l'action Xcode : le panneau ne s'ouvre pas et l'alerte « Aucune fenêtre de
  sélection ne s'est ouverte » apparaît — c'est le comportement attendu tant que l'app n'est pas mise à jour.
