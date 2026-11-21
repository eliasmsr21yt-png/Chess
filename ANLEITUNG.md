# Schach online + als App

## Online stellen (kostenlos, z. B. Render.com)
1. Diesen Ordner in ein GitHub-Repository hochladen.
2. Render.com → New → Web Service → Repository wählen.
3. Build Command: `npm install` · Start Command: `npm start`
4. Fertig: Der Link (https://dein-name.onrender.com) ist dein Spiel. Schick ihn deinen Freunden.
   (Im Gratis-Tarif schläft der Server ein, der erste Aufruf dauert dann ca. 1 Minute.)

Lokal testen: `npm install` und `npm start`, dann http://localhost:3000 öffnen.

## Als App installieren
- Android (Chrome): Button „Als App installieren“ im Hauptmenü oder Menü ⋮ → „App installieren“
- iPhone (Safari): Teilen → „Zum Home-Bildschirm“
- Für den App Store / Play Store: Link bei pwabuilder.com eintragen.

## So funktioniert es
- Private Party: Einer erstellt einen Code, der andere gibt ihn ein.
- Gegnersuche: Zwei Spieler, die gleichzeitig suchen, werden nach Elo gepaart (Farbe wird gelost).
  Findet sich niemand, erscheint nach 15 Sekunden die Option „Gegen Bot spielen“.
- Das Aussehen ist standardmäßig „Klassisch“. Andere Farben (auch Blau) wählst du selbst unter „Aussehen“.

## Konten dauerhaft speichern (wichtig bei Render Gratis)
Auf dem Gratis-Tarif wird der Speicher bei jedem Neustart geleert, dann sind Konten, Münzen und Käufe weg.
Dauerhaft geht es kostenlos mit Upstash:
1. upstash.com → Konto → „Create Database“ (Redis, kostenlos).
2. Dort „REST API“ öffnen und die zwei Werte kopieren.
3. In Render beim Service → Environment → zwei Variablen anlegen: `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN`.
Danach „Manual Deploy“ drücken. Ab dann bleiben alle Konten erhalten. Der Signaturschlüssel für die Bestenliste wird automatisch stabil aus der Upstash-Konfiguration abgeleitet.

## Münzen
Start 200 Münzen, täglich +50 beim Anmelden, Online-Spiele bringen 10 bis 30 (Party 5). Preise stehen in `server.js` (SHOP).

## Wenn die Anmeldung hängt
- „Server wacht gerade auf“: Der Gratis-Server schläft. Bis zu 1 Minute warten, deine Eingaben bleiben stehen.
- „Der Server kennt dein Konto nicht mehr“: Der Server wurde neu gestartet und hat die Konten vergessen. Nur mit Upstash (siehe oben) bleiben sie dauerhaft.
- Damit der Server nicht einschläft: uptimerobot.com (kostenlos) → neuer Monitor (HTTP) → `https://DEIN-LINK/health` alle 5 Minuten.

## Konto, Elo und Bestenliste
- Neue Spieler starten bei **300 Elo**. Die Wertung ändert sich nur bei Online-Spielen ab 8 Zügen und wird vom Server berechnet.
- **Bestenliste:** Top 100 nach Elo, mit Profilbild und Platz.
- **Konto sichern:** Dein Gerät behält Konto, Münzen, Käufe und Presets. Vergisst der Gratis-Server nach einem Neustart alles, stellt dein Gerät das Konto beim nächsten Start automatisch wieder her. Dauerhaft und für alle Geräte sicher ist es nur mit Upstash (siehe oben).
- Ob der Server dauerhaft speichert, siehst du unter `https://DEIN-LINK/health`.

## Konten bleiben nicht erhalten? Öffne /setup
Öffne `https://DEIN-LINK/setup`. Dort steht, ob der Server dauerhaft speichert, und die Schritte für Upstash (kostenlos) stehen gleich darunter. Nur mit dauerhaftem Speicher bleiben Konten und Namen erhalten, und niemand kann einen vergebenen Namen übernehmen.

## Gold, Freunde, Zeitmodi und Premove
- **Gold:** Du startest mit 0. Ein Sieg in einem Online-Spiel gibt +50. Gegen Bots gibt es Gold beim ersten Sieg je Stufe: 20, 60, 120, 250 und 500. Party, Freundes-Spiele und lokale Spiele geben weder Gold noch Elo.
- **Zeitmodi online:** 1, 3, 5, 10, 15 oder 30 Minuten pro Spieler. Die Suche paart nur gleiche Zeiten. Party und Herausforderungen nutzen die gewählte Zeit.
- **Freunde:** Name eingeben, hinzufügen, Online-Status sehen und herausfordern (die Anfrage gilt 60 Sekunden).
- **Premove:** Der Knopf mit Bolzen über der Figur unter dem Brett schaltet ihn ein. Du kannst mehrere Züge vorplanen, nach jedem Gegnerzug läuft nur der erste. Mit ↶ löschst du den letzten, mit ✕ alle.
- **Bestenliste nach Neustart:** Die Bestenliste und die Konten werden vom Server unterschrieben und auf den Geräten gesichert. Nach einem Neustart füllen sie sich wieder, sobald die Spieler zurückkommen. Das funktioniert automatisch bei Render (Variable RENDER_SERVICE_ID). Auf anderen Anbietern mit dauerhaftem Datenträger wird der Signaturschlüssel automatisch in `data/session.secret` gespeichert. Bei flüchtigem Dateisystem setze zusätzlich `SESSION_SECRET` als Environment Variable mit einem langen Zufallstext. Vollständig und sofort dauerhaft ist es nur mit Upstash (siehe `/setup`).


## Update 11 – Bestenliste und Shop
- Der Signaturschlüssel wird jetzt stabil gespeichert bzw. aus der Server-Konfiguration abgeleitet. Dadurch können signierte Bestenlisten-Einträge nach Neustarts wieder eingelesen werden.
- Neue Shop-Figuren: Aurora (2.500 Gold) und Celestial (12.000 Gold, besonders auffälliger Leuchteffekt).
- Die App verwendet einen neuen Service-Worker-Cache, damit das Update auf bereits installierten Geräten geladen wird.

## Update 12 – Mehrspieler-Modi

Die private Party ist jetzt eine Mehrspieler-Lobby mit vier Modi. Der Party-Leiter verwaltet Modus, Zeit und Paarungen/Teams; die Serverprüfungen verhindern, dass andere Spieler diese Einstellungen oder fremde Züge ändern.

### Normal
- Mehrere unabhängige Schachpartien können gleichzeitig gestartet werden.
- Der Leiter legt Paarungen fest; ein Spieler darf nicht in zwei Paarungen vorkommen.
- Nicht zugewiesene Spieler bleiben in der Lobby und können laufende Partien ansehen.
- Jede Partie besitzt einen eigenen Spielstand und eine eigene Uhr.

### Turnier
- K.-o.-Turnier mit zufälliger Auslosung und automatisch verteilten Freilosen bei ungerader Spielerzahl.
- Der Turnierbaum und der Sieger bleiben in der Party-Lobby sichtbar.
- Spieler können laufende Turnierpartien beobachten und parallel in einem zweiten Tab lokal gegen einen Bot trainieren.
- Bei einem Remis in einer K.-o.-Partie entscheidet derzeit ein Zufalls-Tie-Break, damit der Turnierbaum fortgesetzt werden kann.

### Alle gegen Alle
- Eigenes quadratisches Mehrspielerbrett: 16×16, 18×18 oder 20×20 Felder für 2, 3 oder 4 aktive Spieler.
- Jeder aktive Spieler startet mit zehn Figuren. Wird sein König geschlagen, scheidet der Spieler samt übrigen Figuren aus.
- Bei mehr als vier verbundenen Party-Mitgliedern spielen die ersten vier verbundenen Spieler aktiv; weitere Mitglieder können zuschauen.
- Dies ist eine angepasste Mehrspieler-Variante und nicht das vollständige orthodoxe Schach: Es gibt unter anderem keine Rochade, kein En-passant und keine Schach-/Matt-Pflicht. Der König wird tatsächlich geschlagen.

### Team
- Alle verbundenen Party-Mitglieder können frei auf zwei Teams verteilt werden; auch ungleiche Teamgrößen sind möglich.
- Die Team-Mitglieder wechseln sich nach jedem Zug ab. Nur der aktuell berechtigte Spieler darf ziehen.
- Namen und Farben der Teams sind einstellbar und werden auch im Spiel angezeigt.
- Verlässt ein Team-Mitglied die Party, kann der Leiter es durch ein anderes verbundenes Party-Mitglied ersetzen.

### Zeiten, Speicherung und Bereitstellung
- Party-Partiezeiten: 1, 3, 5, 10, 15 oder 30 Minuten sowie eine eigene Zeit von 1 bis 180 Minuten.
- Die Uhren laufen für Weiß und Schwarz getrennt. Bei Zeitablauf wird die Partie nach den verfügbaren Schachregeln gewertet.
- Online-Züge werden serverseitig mit `chess.js` geprüft. Party-Partien, Turnierpartien und Team-Partien haben getrennte Spielzustände; der FFA-Modus besitzt eine eigene Zugprüfung.
- Partys werden zusammen mit den laufenden Spielständen gespeichert. Für zuverlässige Speicherung auf Render bitte Upstash wie oben beschrieben konfigurieren oder einen persistenten Datenträger über `DATA_DIR` bereitstellen. Ohne persistenten Speicher kann kein Neustart-übergreifender Erhalt garantiert werden.
- Nach dem Update in Render müssen `npm install` und anschließend `npm start` laufen. `chess.js` wird automatisch über `package.json` installiert.

## Prüfstatus
- Erfolgreich geprüft: `node --check server.js`, Syntaxprüfung des Inline-JavaScripts aus `index.html` und JSON-Parsing von `package.json`.
- Nicht in dieser Umgebung ausgeführt: vollständige Browser-/Socket.IO-Mehrspieler-Tests mit mehreren echten Clients. Die npm-Installation der Abhängigkeiten war in der Build-Umgebung nicht verfügbar bzw. lief in einen Timeout. Bitte nach dem Deployment mit mindestens zwei Browsern testen.
