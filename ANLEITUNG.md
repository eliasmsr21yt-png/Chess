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
- Private Party: Einer erstellt einen Code, der andere gibt ihn ein. Vor dem Erstellen kannst du 1, 3, 5 oder 10 Minuten wählen; die Partie ist ungewertet.
- Premoves: Im Online-Spiel unten links das Blitzsymbol aktivieren. Während der Gegner am Zug ist, eigene Züge vormerken. Die Vorschau ist blau; mehrere Züge können vorgemerkt und über „Alle Premoves löschen“ entfernt werden. Pro eigenem Zug wird höchstens ein gültiger Premove ausgeführt.
- Freunde: Im Menü „Freunde“ einen Namen hinzufügen, die Anfrage annehmen lassen und anschließend eine Herausforderung mit 1, 3, 5 oder 10 Minuten senden.
- Gegnersuche: Zwei Spieler, die gleichzeitig dieselbe Zeitkontrolle wählen, werden nach Elo gepaart (Farbe wird gelost). Online verfügbar: 1, 3, 5 und 10 Minuten pro Spieler.
  Findet sich niemand, erscheint nach 15 Sekunden die Option „Gegen Bot spielen“.
- Das Aussehen ist standardmäßig „Klassisch“. Andere Farben (auch Blau) wählst du selbst unter „Aussehen“.

## Konten dauerhaft speichern (wichtig bei Render Gratis)
Auf dem Gratis-Tarif wird der Speicher bei jedem Neustart geleert, dann sind Konten, Münzen und Käufe weg.
Dauerhaft geht es mit Upstash Redis oder mit einem persistenten Render-Datenträger. Für einen Render-Datenträger: unter **Disks** einen Persistent Disk anlegen, Mount Path `/var/data` wählen und unter **Environment** `DATA_DIR=/var/data` setzen. Ohne eines davon ist das Dateisystem eines Render-Web-Service nicht dauerhaft. Mit Upstash geht es so:
1. upstash.com → Konto → „Create Database“ (Redis, kostenlos).
2. Dort „REST API“ öffnen und die zwei Werte kopieren.
3. In Render beim Service → Environment → zwei Variablen anlegen: `UPSTASH_REDIS_REST_URL` und `UPSTASH_REDIS_REST_TOKEN`.
Danach „Manual Deploy“ drücken. Ab dann bleiben alle Konten erhalten.

## Münzen und Belohnungen
Neue Konten starten mit 0 Münzen. Es gibt keinen täglichen Goldbonus.
- Sieg in einem gewerteten Online-Spiel: +50 Münzen.
- Bot-Stufen: einmalige Belohnung pro Stufe (50 / 100 / 175 / 300 / 500 Münzen).
- Freundschaftsspiele, private Partys und lokale Spiele bringen weder Gold noch Elo.
- Der Shop enthält zusätzliche Figuren-Effekte und Brett-Themes. Das Kosmos-Figuren-Item kostet 5.000 Münzen.

## Wenn die Anmeldung hängt
- „Server wacht gerade auf“: Der Gratis-Server schläft. Bis zu 1 Minute warten, deine Eingaben bleiben stehen.
- „Der Server kennt dein Konto nicht mehr“: Der Server wurde neu gestartet und hat die Konten vergessen. Nur mit Upstash (siehe oben) bleiben sie dauerhaft.
- Damit der Server nicht einschläft: uptimerobot.com (kostenlos) → neuer Monitor (HTTP) → `https://DEIN-LINK/health` alle 5 Minuten.

## Konto, Elo und Bestenliste
- Neue Spieler starten bei **300 Elo** und **0 Münzen**. Elo wird vom Server bei abgeschlossenen gewerteten Online-Spielen berechnet.
- Der Profilname kann im Profil geändert werden. Einstellungen für beide Brettseiten werden im Profil gespeichert.
- **Bestenliste:** Top 100 nach Elo, mit Profilbild und Platz.
- **Konto sichern:** Dein Gerät behält Konto, Münzen, Käufe und Presets. Vergisst der Gratis-Server nach einem Neustart alles, stellt dein Gerät das Konto beim nächsten Start automatisch wieder her. Dauerhaft und für alle Geräte sicher ist es nur mit Upstash (siehe oben).
- Ob der Server dauerhaft speichert, siehst du unter `https://DEIN-LINK/health`.

## Konten bleiben nicht erhalten? Öffne /setup
Öffne `https://DEIN-LINK/setup`. Dort steht, ob der Server dauerhaft speichert, und die Schritte für Upstash (kostenlos) stehen gleich darunter. Nur mit dauerhaftem Speicher bleiben Konten und Namen erhalten, und niemand kann einen vergebenen Namen übernehmen.
