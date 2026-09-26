# Veröffentlichen im Chrome Web Store – Schritt für Schritt

Dauer beim ersten Mal: etwa 30–45 Minuten plus Prüfzeit von Google.

## 1. Entwicklerkonto (einmalig)

1. <https://chrome.google.com/webstore/devconsole> öffnen und mit dem Google-Konto anmelden, unter dem das Addon erscheinen soll.
2. Einmalige Registrierungsgebühr von **5 US-Dollar** bezahlen.
3. **Bestätigung in zwei Schritten** für das Google-Konto einschalten, sonst kann man nichts veröffentlichen.
4. Im Reiter **Account**:
   - Publisher-Name eintragen (wird im Store angezeigt)
   - Kontakt-E-Mail **justjpg.support@gmail.com** eintragen und bestätigen (Google schickt einen Link)
   - Angeben, ob du als **Händler (Trader)** handelst. Für ein kostenloses Hobby-Projekt ohne Einnahmen: „Non-trader“. In der EU ist diese Angabe Pflicht.

## 2. ZIP bauen

```
npm run build          (oder: node scripts/build.mjs)
```

Das Skript prüft alles (Manifest, fehlende Dateien, Syntax, Übersetzungen) und legt
`dist/justjpg-<version>.zip` an. Alternativ baut die GitHub Action das ZIP bei jedem Push
(Reiter „Actions“ → Lauf öffnen → Artefakt „justjpg-zip“).

## 3. Datenschutzerklärung veröffentlichen

Google verlangt eine öffentlich erreichbare Adresse.

1. Kontakt-Adresse in `docs/privacy.html`: **justjpg.support@gmail.com** (bereits eingetragen).
   Dieselbe Adresse als Kontakt-E-Mail im Developer-Konto verwenden (Schritt 1).
2. Veröffentlichen, eine der Möglichkeiten:
   - **GitHub Pages:** Repository → Settings → Pages → Branch `main`, Ordner `/docs` → speichern.
     Adresse: `https://<github-name>.github.io/<repo>/privacy.html`.
     Bei privaten Repositories geht das nur mit einem bezahlten GitHub-Plan.
   - Oder die Datei auf eine beliebige eigene Webseite hochladen.

## 4. Neues Element anlegen

Dashboard → **„+ New item“** → ZIP aus `dist/` hochladen.

## 5. Reiter „Store listing“

Alles aus **`store/LISTING.md`** übernehmen:
- Beschreibung (Englisch), Kategorie **Tools**, Sprache **English**
- Store-Icon: `extension/icons/icon128.png`
- 5 Screenshots aus `store/screenshots/en/` in der Reihenfolge 1–5
- Small promo tile: `store/promo/en-small-440x280.png`
- Marquee: `store/promo/en-marquee-1400x560.png` (optional)
- Danach über die Sprachauswahl oben **Deutsch** hinzufügen und dort die deutschen Texte und `store/screenshots/de/` bzw. `store/promo/de-*` eintragen.

## 6. Reiter „Privacy practices“

Alles aus **`store/PRIVACY-PRACTICES.md`** übernehmen:
- Single purpose
- Begründung für jede Berechtigung (contextMenus, downloads, storage, scripting, offscreen, declarativeNetRequestWithHostAccess, Host-Berechtigung)
- Remote code: **No**
- Data usage: **nichts** ankreuzen, die drei Bestätigungen ankreuzen
- Privacy policy URL aus Schritt 3

## 7. Reiter „Distribution“

- **Visibility:** Public (oder erst „Unlisted“ zum Testen mit Link)
- **Regions:** All regions
- **Pricing:** Free

## 8. Reiter „Test instructions“ (optional)

Text aus `store/PRIVACY-PRACTICES.md`, Abschnitt „Test instructions“.

## 9. Einreichen

**„Submit for review“**. Optional „Publish automatically after review“ abwählen,
wenn du selbst den Zeitpunkt bestimmen willst.

**Prüfdauer:** meist einige Tage. Weil JustJPG Zugriff auf alle Webseiten braucht,
prüft Google von Hand und gründlicher. Eine bis drei Wochen sind beim ersten Mal nicht ungewöhnlich.
Rückfragen oder Ablehnungen kommen per E-Mail an die Kontakt-Adresse aus Schritt 1.

---

## Updates später

1. In `extension/manifest.json` die `version` erhöhen (z.B. `1.0.0` → `1.0.1`). Google nimmt keine gleiche oder kleinere Version an.
2. `npm run build`
3. Dashboard → Element → **Package** → „Upload new package“ → **Submit for review**.
4. Optional: Git-Tag setzen (`git tag v1.0.1 && git push --tags`), dann legt die GitHub Action automatisch ein Release mit dem ZIP an.

## Häufige Ablehnungsgründe – und warum sie hier nicht greifen sollten

| Grund | Stand bei JustJPG |
|---|---|
| Unnötige Berechtigungen | Nur 6 Berechtigungen, jede begründet. `activeTab` und `DOM_PARSER` wurden entfernt, weil nicht nötig |
| Nachgeladener Code | Keiner. Der HEIC-Decoder liegt als WebAssembly-Datei im Paket |
| Fehlende Datenschutzerklärung | `docs/privacy.html` (zweisprachig) |
| Irreführende Beschreibung | Beschreibung und Screenshots zeigen nur echte Funktionen. Die Screenshots sind Aufnahmen der echten Oberfläche; nur das Rechtsklick-Menü ist nachgezeichnet, weil sich Chromes eigenes Menü nicht abfotografieren lässt |
| Mehrere Zwecke | Ein Zweck: Bilder als JPG speichern |
| Urheberrecht | Hinweis in der Beschreibung; keine DRM-Umgehung, keine Video-Downloads |
