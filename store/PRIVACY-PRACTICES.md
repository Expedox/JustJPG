# Datenschutz-Tab & Berechtigungen (zum Kopieren)

Diese Texte gehören in den Reiter **„Privacy practices“** im Developer Dashboard.
Google prüft sie von Hand, deshalb auf **Englisch**. Jedes Feld hat maximal 1000 Zeichen,
alle Texte hier passen. Unter jedem Block steht auf Deutsch, was er bedeutet.

---

## Single purpose description

```
JustJPG saves images from web pages as JPG files. The user picks an image (right-click menu, a hover button, a keyboard shortcut or a gallery of the page's images); the extension fetches the best available version of that image, converts it locally to JPG (from WEBP, AVIF, HEIC, PNG, SVG, canvas or a video frame) and downloads it. Every feature serves this one purpose.
```

> Deutsch: Der eine Zweck des Addons ist „Bilder von Webseiten als JPG speichern“. Alle Funktionen dienen genau dem.

---

## Permission justifications

### contextMenus
```
Adds the "Save as JPG" entry to the right-click menu, which is the main way to save an image. The toolbar icon's menu also gets "Save visible area as JPG" and a link to the shortcut settings.
```
> Für den Rechtsklick-Menüeintrag.

### downloads
```
Saves the converted JPG file to the user's download folder, optionally in a subfolder and with the file name pattern the user configured, or opens the "Save as" dialog if the user chose that option.
```
> Um die fertige JPG-Datei zu speichern.

### storage
```
Stores the user's settings (JPG quality, file name template, language, which buttons are shown, etc.) and a file-name counter. Nothing else is stored and nothing is sent anywhere.
```
> Für die Einstellungen.

### scripting
```
Used only on the user's action: (1) when the gallery popup opens, to list the images of the current tab in all frames; (2) when the keyboard shortcut is pressed, to find which frame the mouse pointer is in; (3) right after installation, to make the extension work in tabs that were already open; (4) to briefly hide the extension's own button while an element screenshot is taken.
```
> Um beim Öffnen der Galerie, beim Tastenkürzel und direkt nach der Installation mit der Seite zu sprechen.

### offscreen
```
Image decoding and JPG encoding need a DOM context (Image elements, canvas, object URLs), which a Manifest V3 service worker does not have. The offscreen document decodes WEBP/AVIF/PNG/SVG, runs the bundled HEIC decoder (WebAssembly) and encodes the JPG. It is closed again after one minute without work.
```
> Das Umwandeln der Bilder braucht eine unsichtbare Hilfsseite, weil der Hintergrund-Teil von Chrome-Erweiterungen keine Bilder zeichnen kann.

### declarativeNetRequestWithHostAccess
```
Many image servers reject requests that do not carry the page's Referer header, so the image the user sees cannot be downloaded. While the user saves an image, the extension adds a temporary session rule that sets the Referer to the page the image is on. The rule only applies to the extension's own requests (tabId -1) to that one image host and is removed immediately afterwards. Website requests are never modified.
```
> Manche Bildserver liefern Bilder nur aus, wenn sie wissen, von welcher Seite die Anfrage kommt. Das Addon gibt diese Angabe nur bei seinen eigenen Downloads mit, nur für die Dauer des Speicherns.

### Host permission (<all_urls>)
```
Images can come from any website and are usually served from a different domain (CDNs). Host access is required to: (1) run the content script that finds the image under the cursor (also behind overlays and in CSS backgrounds), shows the optional hover button and restores right-click on images; (2) download the original image file from its server without being blocked by CORS; (3) capture the visible tab as a last-resort screenshot of an image that cannot be downloaded otherwise (captureVisibleTab). Apart from the page title and image alt text used locally for the file name, it does not read page content, and it never sends page data, form data or browsing history anywhere.
```
> Bilder liegen auf beliebigen Seiten und meist auf fremden Servern. Ohne Zugriff auf alle Seiten könnte das Addon weder das Bild unter dem Mauszeiger finden noch die Originaldatei laden.

### Remote code
**Antwort: „No, I am not using remote code.“**
```
All code is included in the package. The HEIC decoder (libheif, LGPL-3.0) is bundled as a local WebAssembly file; 'wasm-unsafe-eval' in the CSP is needed only to run this bundled WebAssembly. No scripts are loaded from any server.
```
> Kein Code wird aus dem Internet nachgeladen. Der HEIC-Decoder ist im Paket enthalten.

---

## Data usage

**Welche Nutzerdaten sammelt das Addon?** → **Keine Kästchen ankreuzen.**

| Kategorie | Ankreuzen? | Warum |
|---|---|---|
| Personally identifiable information | nein | wird nicht erhoben |
| Health information | nein | |
| Financial and payment information | nein | |
| Authentication information | nein | |
| Personal communications | nein | |
| Location | nein | |
| Web history | nein | es wird kein Verlauf gespeichert oder gesendet |
| User activity | nein | Klicks werden nur lokal ausgewertet, nichts wird aufgezeichnet |
| Website content | nein | Bilder werden nur auf Wunsch des Nutzers lokal umgewandelt und in seinen Download-Ordner gelegt. Nichts wird an den Entwickler oder Dritte übertragen |

**Die drei Bestätigungen am Ende alle ankreuzen:**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** Adresse, unter der `docs/privacy.html` veröffentlicht ist (siehe `store/CHECKLIST.md`, Schritt 3).

---

## Test instructions (optional, Reiter „Test instructions“)

Kein Login nötig. Dieser Text hilft dem Prüfer:

```
No account or login needed.
1. Open any page with images, e.g. https://unsplash.com or a Wikipedia article.
2. Right-click an image → "Save as JPG". A confirmation appears at the bottom right and the JPG is in the Downloads/JustJPG folder.
3. Hover an image (≥120 px) → click the "JPG" button that appears.
4. Click the toolbar icon → gallery of all images → select some → "Save N images as JPG".
5. Options page: quality, file name templates, language (default English).
Images in WEBP/AVIF format are converted to JPG; existing JPGs are saved unchanged.
```
