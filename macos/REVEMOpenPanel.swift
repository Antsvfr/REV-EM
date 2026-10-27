// REV-EM.app (macOS) — ouverture du sélecteur de fichiers pour <input type="file"> dans le WKWebView.
//
// POURQUOI CE FICHIER EXISTE
//   Sur macOS, WKWebView n'ouvre AUCUN panneau de fichiers par lui-même. Quand la page appelle input.click()
//   (bouton « Importer un cours » / « Choisir un fichier »), WebKit demande à l'application d'afficher le panneau via
//   WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:). Si l'application n'implémente pas
//   cette méthode, WebKit se comporte comme si l'utilisateur avait cliqué « Annuler » : rien ne s'ouvre, aucune erreur.
//   C'est la cause du bouton « qui semble fonctionner mais n'ouvre aucun fichier » dans REV-EM.app.
//
// CE FICHIER N'EST PAS COMPILÉ PAR LE SITE : il est à AJOUTER au projet Xcode de REV-EM.app (voir IMPORT_CENTER.md, §9).
//
// INTÉGRATION (3 étapes)
//   1. Ajouter ce fichier à la cible macOS de REV-EM.app (Xcode → File → Add Files to…, cocher la cible).
//   2. Là où le WKWebView est créé, s'assurer que   webView.uiDelegate = <objet>   est défini, puis, DANS LA CLASSE de cet
//      objet (celle qui est déjà le WKUIDelegate, si elle existe — ne pas en créer une seconde, elle remplacerait les
//      alert()/confirm() déjà gérés), ajouter :
//
//          func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
//                       initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
//              REVEMOpenPanel.present(for: webView, parameters: parameters, completionHandler: completionHandler)
//          }
//
//      Si l'application n'a pas encore de WKUIDelegate : `webView.uiDelegate = REVEMWebUIDelegate.shared` (classe ci-dessous).
//   3. Si l'application est sandboxée (App Sandbox activé) : Signing & Capabilities → App Sandbox → File Access →
//      « User Selected File » = Read Only  (clé com.apple.security.files.user-selected.read-only = YES).
//      Rien d'autre : pas d'accès global au disque, pas de « Downloads », pas de lecture/écriture.

import AppKit
import WebKit
import UniformTypeIdentifiers

enum REVEMOpenPanel {
    /// Les formats que l'Import Center sait réellement lire (même liste que `ACCEPT` dans import-center.js).
    /// La page revérifie de toute façon le format, la taille et le contenu du fichier reçu.
    @available(macOS 11.0, *)
    static var importableTypes: [UTType] {
        var types: [UTType] = [.pdf, .plainText]
        if let docx = UTType(filenameExtension: "docx") { types.append(docx) }
        if let md = UTType(filenameExtension: "md") { types.append(md) }
        if let markdown = UTType(filenameExtension: "markdown") { types.append(markdown) }
        return types
    }

    /// Affiche le sélecteur natif (feuille attachée à la fenêtre de REV-EM) et rend les fichiers choisis à WebKit.
    /// Annuler → completionHandler(nil) : la page reçoit l'événement `cancel`, ce n'est pas une erreur.
    /// Le completionHandler est appelé EXACTEMENT une fois, quoi qu'il arrive (sinon WebKit attendrait indéfiniment).
    static func present(for webView: WKWebView, parameters: WKOpenPanelParameters,
                        completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        if #available(macOS 11.0, *) {
            panel.allowedContentTypes = importableTypes
        } else {
            panel.allowedFileTypes = ["pdf", "docx", "txt", "md", "markdown"]
        }
        panel.prompt = NSLocalizedString("Importer", comment: "Bouton du sélecteur de fichiers de REV-EM")
        panel.message = NSLocalizedString("Choisis le cours à importer dans REV-EM (PDF, Word ou texte).",
                                          comment: "Message du sélecteur de fichiers de REV-EM")

        let finish: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .OK && !panel.urls.isEmpty ? panel.urls : nil)
        }
        if let window = webView.window {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(panel.runModal())
        }
    }
}

/// Délégué minimal, À N'UTILISER QUE si l'application n'a encore AUCUN WKUIDelegate.
/// Il gère aussi alert() / confirm() de la page (sans eux, WKWebView macOS les ignore : confirm() renverrait false).
final class REVEMWebUIDelegate: NSObject, WKUIDelegate {
    static let shared = REVEMWebUIDelegate()

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        REVEMOpenPanel.present(for: webView, parameters: parameters, completionHandler: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        if let window = webView.window { alert.beginSheetModal(for: window) { _ in completionHandler() } }
        else { alert.runModal(); completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: NSLocalizedString("Annuler", comment: ""))
        if let window = webView.window { alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) } }
        else { completionHandler(alert.runModal() == .alertFirstButtonReturn) }
    }
}
