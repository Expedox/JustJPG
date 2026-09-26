# JustJPG

Chrome-Erweiterung, die **jedes Bild mit einem Klick als JPG speichert**, auch Bilder, die sich normal nicht herunterladen lassen oder nur als WEBP, AVIF oder HEIC kommen. Alles wird **lokal** konvertiert, nichts wird an einen Server geschickt.

## Installation

1. Repository herunterladen (oder `git clone`).
2. In Chrome `chrome://extensions` öffnen und oben rechts den **Entwicklermodus** einschalten.
3. **„Entpackte Erweiterung laden“** klicken und den Ordner `extension/` auswählen.
4. Optional: Das JustJPG-Symbol über das Puzzle-Symbol an die Symbolleiste anheften.

Nach der Installation öffnen sich die Einstellungen. Bereits offene Tabs funktionieren sofort, ohne dass du sie neu laden musst.

## Bedienung

| Auslöser | Was passiert |
|---|---|
| **Rechtsklick → „Als JPG speichern“** | Speichert das Bild unter dem Mauszeiger, auch wenn ein transparentes Overlay darüber liegt, das Bild ein CSS-Hintergrund ist oder die Seite den Rechtsklick blockiert. |
| **Hover-Button „JPG“** | Erscheint beim Überfahren von Bildern ab einer einstellbaren Größe. |
| **Tastenkürzel `Alt+Shift+S`** | Speichert das Bild unter dem Mauszeiger. Änderbar unter `chrome://extensions/shortcuts`. Ein zweites Kürzel für „sichtbarer Bereich“ ist dort frei belegbar. |
| **Klick aufs Symbol** | Galerie mit allen Bildern der Seite (inkl. iFrames), zum Auswählen und gesammelten Speichern. |
| **Rechtsklick aufs Symbol** | „Sichtbaren Bereich als JPG speichern“. |

## Wie „jeder Download“ funktioniert

Für jedes Bild probiert JustJPG diese Wege der Reihe nach:

1. **Größte Originaldatei**: höchste `srcset`-Variante, `<picture>`-Quellen, verlinkte Vollbilder und Lazy-Load-/Zoom-Attribute (`data-src`, `data-zoom-image` …). Geladen wird über die Rechte der Erweiterung, also ohne CORS-Grenzen und mit dem Referer der Seite, damit Hotlink-Schutz nicht greift.
2. **Laden im Kontext der Seite**: für `blob:`-URLs und Bilder, die an die Sitzung gebunden sind.
3. **Inhalte, die die Seite selbst zeichnet**: `<canvas>`, das aktuelle Standbild eines `<video>` und Inline-`<svg>`.
4. **Screenshot-Ausschnitt** als letzte Lösung, z.B. bei geschütztem Canvas oder Cross-Origin-Videos. Funktioniert auch in iFrames, hat aber nur Bildschirmauflösung.

Unterstützte Eingangsformate: WEBP, AVIF, HEIC/HEIF, PNG, GIF (erstes Bild), SVG, BMP, ICO, JPG, Canvas, Video-Standbild.
HEIC wird mit [libheif](https://github.com/strukturag/libheif) (via [libheif-js](https://github.com/catdad-experiments/libheif-js), LGPL-3.0) als WebAssembly lokal dekodiert.

## Einstellungen

- **Auslöser**: Rechtsklick-Menü, Rechtsklick-Sperre aufheben (nur auf Bildern, eigene Menüs von Web-Apps bleiben erhalten), Hover-Button (Position, Mindestgröße).
- **Speichern**: direkt oder „Speichern unter“-Dialog; Unterordner mit Platzhaltern (z.B. `JustJPG/{domain}`); bei vorhandener Datei nummerieren oder überschreiben.
- **Qualität**: JPG-Qualität 50–100 % (Standard 92 %), Hintergrundfarbe für Transparenz (Standard Weiß), vorhandene JPGs 1:1 übernehmen, größte Version bevorzugen, Screenshot-Fallback.
- **Dateiname**: 10 Vorlagen oder ein eigenes Muster mit den Platzhaltern `{name} {domain} {title} {alt} {date} {time} {year} {month} {day} {timestamp} {counter} {index} {width} {height} {format} {random}`. Kryptische Namen (Hashes, `image`, leer) werden automatisch durch ein Ersatzmuster ersetzt. Außerdem: Leerzeichen-Ersatz, Kleinschreibung, maximale Länge, Zähler zurücksetzen. Die Live-Vorschau zeigt das Ergebnis.
- **Sprache**: Englisch (Standard), Deutsch, Spanisch, Italienisch, Griechisch, Piratenenglisch, Piratendeutsch, Österreichisch oder automatisch nach Browsersprache.
- **Anzeige**: Bestätigung einblenden, Vorschau- und Mindestgröße in der Galerie. In der Galerie lassen sich Vorschaugröße („Vorschau ▾“) und Mindestgröße („Ab … px ▾“) direkt per Schieberegler ändern und werden gespeichert. Der Mindestgröße-Regler reicht nur so weit, wie es auf der Seite tatsächlich Bilder gibt.

## Grenzen

- DRM-geschützte Videos (Netflix & Co.) liefern auch im Screenshot nur ein schwarzes Bild. Das ist technisch so gewollt und lässt sich nicht umgehen.
- Auf `chrome://`-Seiten und im Chrome Web Store dürfen Erweiterungen grundsätzlich nicht laufen.
- Ist in Chrome „Vor dem Download nach dem Speicherort fragen“ aktiv, fragt Chrome auch im Modus „Direkt speichern“ nach.

## Sprachen

Englisch ist Standard. In den Einstellungen oben rechts lassen sich außerdem Deutsch, Spanisch, Italienisch, Griechisch, Piratenenglisch, Piratendeutsch, Österreichisch oder „Automatisch (Browsersprache)“ wählen. Die Umstellung wirkt sofort überall: Einstellungen, Galerie, Rechtsklick-Menü, Meldungen auf der Seite und Fehlertexte.

**Neue Sprache hinzufügen:** Alle Texte stehen in einer einzigen Datei, `extension/translations.js`.

1. Den kompletten Block `en: { ... },` kopieren und am Ende der Liste einfügen.
2. `en` durch das Sprachkürzel ersetzen (z.B. `fr`) und `_name` durch den Namen der Sprache („Français“).
3. Die Texte rechts übersetzen. Schlüssel links und alles in `{geschweiften Klammern}` unverändert lassen.

Fertig, die Sprache erscheint automatisch in der Auswahl. Fehlende Einträge fallen auf Englisch zurück, man kann also auch schrittweise übersetzen. Optional übersetzt `extension/_locales/<kürzel>/messages.json` die vier Texte, die Chrome selbst anzeigt (Beschreibung in der Erweiterungsliste, Symbol-Tooltip vor dem ersten Start, Namen der Tastenkürzel). Diese Texte folgen der Sprache des Browsers, nicht der Einstellung im Addon.

## Projektstruktur

```
extension/
  manifest.json      Manifest V3
  background.js      Service Worker: Menü, Kürzel, Speicher-Kette, Downloads
  content.js         Bilderkennung auf der Seite, Hover-Button, Meldungen
  offscreen.*        Lokale Dekodierung + JPG-Kodierung (inkl. HEIC)
  popup.*            Galerie „Alle Bilder der Seite“
  options.*          Einstellungen
  translations.js    Alle Texte in allen Sprachen
  lib/i18n.js        Übersetzungs-Logik
  lib/defaults.js    Standardwerte + Dateinamen-Logik
  lib/libheif/       HEIC-Decoder (WebAssembly, LGPL-3.0)
  _locales/          Texte für Chromes eigene Seiten (optional pro Sprache)
```
