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
- **Zeitmodi online:** 1, 3, 5 oder 10 Minuten pro Spieler. Die Suche paart nur gleiche Zeiten. Party und Herausforderungen nutzen die gewählte Zeit.
- **Freunde:** Name eingeben, hinzufügen, Online-Status sehen und herausfordern (die Anfrage gilt 60 Sekunden).
- **Premove:** Der Knopf mit Bolzen über der Figur unter dem Brett schaltet ihn ein. Du kannst mehrere Züge vorplanen, nach jedem Gegnerzug läuft nur der erste. Mit ↶ löschst du den letzten, mit ✕ alle.
- **Bestenliste nach Neustart:** Die Bestenliste und die Konten werden vom Server unterschrieben und auf den Geräten gesichert. Nach einem Neustart füllen sie sich wieder, sobald die Spieler zurückkommen. Das funktioniert automatisch bei Render (Variable RENDER_SERVICE_ID). Auf anderen Anbietern mit dauerhaftem Datenträger wird der Signaturschlüssel automatisch in `data/session.secret` gespeichert. Bei flüchtigem Dateisystem setze zusätzlich `SESSION_SECRET` als Environment Variable mit einem langen Zufallstext. Vollständig und sofort dauerhaft ist es nur mit Upstash (siehe `/setup`).


## Update 11 – Bestenliste und Shop
- Der Signaturschlüssel wird jetzt stabil gespeichert bzw. aus der Server-Konfiguration abgeleitet. Dadurch können signierte Bestenlisten-Einträge nach Neustarts wieder eingelesen werden.
- Neue Shop-Figuren: Aurora (2.500 Gold) und Celestial (12.000 Gold, besonders auffälliger Leuchteffekt).
- Die App verwendet einen neuen Service-Worker-Cache, damit das Update auf bereits installierten Geräten geladen wird.


## Update 12 – Online-Schachuhr korrigiert
- Die Online-Uhr wird jetzt auf dem Server berechnet und an beide Spieler synchronisiert.
- Der Server prüft Zugreihenfolge und Zeitablauf. Bei Zeitüberschreitung gewinnt verbindlich die Gegenseite.
- Bot-Spiele und lokale Spiele behalten ihre bisherige lokale Zeituhr.
- Nach dem Hochladen des Updates auf GitHub in Render einen neuen Deploy starten. Bei bereits geöffneten Spielseiten einmal vollständig neu laden.
- Der App-Cache wurde auf `schach-v4` erhöht, damit installierte Versionen das Update neu laden.


## Update 13 – Vier Party-Spielmodi

Private Partys unterstützen jetzt bis zu 16 Spieler. Der Party-Leiter wählt in der Lobby den Spielmodus und die Bedenkzeit (1, 3, 5, 10, 15 oder 30 Minuten bzw. eine eigene Zeit von 1 bis 30 Minuten). Alle Spieler sehen die Auswahl und den Party-Code.

### Normal
- Der Leiter kann Spieler paaren oder die Standard-Paarung verwenden.
- Jedes Paar erhält eine eigene, unabhängig gespeicherte Schachpartie mit eigener Uhr.
- Nicht spielende Party-Mitglieder können laufende Partien beobachten oder über „Separates Bot-Training in neuem Tab“ unabhängig trainieren.

### Turnier
- Der Leiter wählt die Teilnehmer aus.
- Beim Start werden sie zufällig in einen K.-o.-Baum gelost. Nicht volle Zweierpotenzen erhalten automatisch Freilose; bei sieben Teilnehmern gibt es drei Erstrundenpartien und ein Freilos.
- Sieger rücken automatisch weiter. Remis führen zu einem Entscheidungsspiel. Der Turnierbaum und der Sieger bleiben in der Lobby sichtbar.

### Alle gegen Alle
- Alle Teilnehmer teilen sich ein eigenes, mit der Spielerzahl wachsendes Spielfeld.
- Jeder startet mit zehn Figuren einschließlich eines Königs und hat eine eigene Farbe.
- Die Zugfolge wird serverseitig rotiert. Wird ein König geschlagen oder verlässt ein Spieler die Party dauerhaft, scheidet dieser Spieler aus und seine übrigen Figuren werden entfernt.
- Dies ist eine Mehrspieler-Variante mit angepasster Zug-/Bauernlogik: Es gibt kein klassisches Schachmatt, keine Rochade und keine 8×8-Beschränkung; Ziel ist das Überleben des Königs.

### Team
- Der Leiter teilt Spieler flexibel auf zwei Teams auf, kann Namen und Farben festlegen und Spieler per Drag-and-drop oder Auswahl zuweisen.
- Teammitglieder teilen die jeweilige Schachfarbe und wechseln sich pro Teamzug ab. Nur der aktuell eingeteilte Spieler darf ziehen.
- Verlässt ein Spieler die Party dauerhaft, bleibt ein Team-Slot als Ersatzplatz offen. Der Leiter kann einen anderen Party-Spieler zuweisen.

### Online-Speicherung und Wiederbeitritt
- Party-Lobbys, Modus-Einstellungen, Turnierbäume, Bretter, Zugverläufe und laufende Uhren werden serverseitig gespeichert und nach einem Server-Neustart wiederhergestellt.
- Für dauerhafte Speicherung auf einem Host mit flüchtigem Dateisystem ist Upstash Redis (siehe Abschnitt „Konten dauerhaft speichern“) erforderlich. Alternativ muss `DATA_DIR` auf einen dauerhaft gespeicherten Datenträger zeigen.
- Bei einem Seiten-Reload kann ein Spieler über seinen gespeicherten Party-Code und sein Konto wieder beitreten. Vorübergehend getrennte Spieler bleiben in der Party; ein dauerhaftes Verlassen entfernt sie.
- Klassische Züge werden serverseitig geprüft (einschließlich legaler Züge, Königssicherheit, Rochade, en passant und Umwandlung). Elo und Gold werden weiterhin ausschließlich für das vorhandene Ranglisten-Matchmaking vergeben, nicht für Party-Spiele.

Der App-Cache wurde im vorherigen Update auf `schach-v5` erhöht. Nach dem Hochladen des Updates muss der Server neu bereitgestellt werden; installierte Apps laden die neue Oberfläche beim nächsten Neuladen.

## Tests für die Spielmodi
- `npm test` führt die automatisierten Regel-, Turnier-, FFA-, Team-Rotations- und HTTP-Tests aus.
- Die Team-Zugfolge überspringt vorübergehend getrennte Teammitglieder; nach einem dauerhaften Austritt kann der Leiter einen neu beigetretenen Spieler dem freien Teamplatz zuweisen.
- Im Alle-gegen-Alle-Modus sind bis zu 16 Spieler mit jeweils eigener Figurenfarbe vorgesehen.


## Update 14 – Turnier-Zuschauer, Trostrunde und vierseitiges FFA-Brett

- Die Turnierauslosung wird als vollständige Vorschau angezeigt, bevor der Host das Turnier startet. Teilnehmerauswahl und Zeitwahl reagieren sofort in der Lobby.
- Nach einem beendeten Match kehrt der Spieler direkt zum Turnierbaum zurück. Dort lassen sich alle noch laufenden Haupt- und Trostrundenmatches auswählen und live ansehen. Nicht spielende Spieler können weiterhin in einem zweiten Tab gegen den Bot trainieren.
- Sind alle Matches einer Hauptrunde beendet, wechseln alle Party-Mitglieder in die Turnierübersicht. Dort läuft eine sichtbare 10-Sekunden-Pause, bevor die nächste Runde automatisch startet.
- Abgeschlossene Partien zeigen die verbrauchte Zeit beider Spieler. Der Turniersieger und der Final-Zweite werden angezeigt.
- Verlierer aus Hauptrunden spielen parallel in einer Trostrunde weiter. Die Trostrunde ist ebenfalls im Baum sichtbar und ihre laufenden Matches sind direkt anwählbar.
- Das FFA-Brett orientiert sich nun an der vierseitigen Vorlage: vier gegenüberliegende Startzonen, ein kompakteres und auf Smartphones skalierbares Brett, Zoom-Tasten und eine achteckig abgeschrägte Darstellung.
- Bei mehr als vier FFA-Spielern kann der Host vor Spielbeginn Spieler in bis zu vier Allianzen einteilen oder als Einzelspieler belassen (zum Beispiel 2 gegen 1). Verbündete können einander nicht schlagen; gewinnt die letzte Allianz, werden ihre verbliebenen Mitglieder gemeinsam als Sieger gewertet.

Der Service-Worker-Cache wurde auf `schach-v6` erhöht. Nach dem Hochladen auf GitHub bitte Render neu deployen und die App einmal neu laden.

### Tests in Update 14
`npm test` umfasst jetzt zusätzlich die Turnierbaum-Vorschau für sieben Spieler, das kompakte vierseitige FFA-Brett und gemeinsame FFA-Allianzen.


## Update 15 – Kompakteres FFA-Brett und Turnier-Ergebnisbildschirm

- Das FFA-Brett wird jetzt in einer festen, zentrierten Breite von maximal 360 px angezeigt; auf kleinen Displays maximal 340 px bzw. die verfügbare Bildschirmbreite. Es füllt nicht länger den gesamten verfügbaren Bereich. Die Zoom-Funktion bleibt erhalten, ist aber auf 160 % begrenzt.
- Nach einem Turniermatch bleibt zuerst der normale Ergebnisbildschirm mit „Du hast gewonnen“ bzw. „Du hast verloren“ geöffnet.
- Von diesem Ergebnisbildschirm kann man gezielt zum Turnierbaum, zur Auswahl laufender Spiele zum Zuschauen oder in ein separates Bot-Training wechseln.
- Ein direkt folgendes Trostrunden-Match unterbricht den Ergebnisbildschirm nicht. Das Match ist im Turnierbaum auswählbar und startet für den Spieler erst, wenn er es dort öffnet.
- Der App-Cache wurde auf `schach-v7` erhöht. Nach dem Hochladen auf GitHub bitte Render neu deployen und installierte Apps vollständig neu laden.

Prüfung: `npm test` sowie die Syntaxprüfung des eingebetteten Frontend-JavaScripts. Ein echter Test mit verbundenen Browsern/Socket.IO-Clients ist weiterhin separat nach dem Deployment durchzuführen.


## Update 16 – FFA-Brett wie auf dem Foto

- Das frühere große, quadratische Brett wurde durch ein echtes vierseitiges Brettlayout ersetzt: 10×10 grün-beige Schachfelder in der Mitte, vier helle Startstreifen und abgeschrägte Plattenecken.
- Die Startaufstellung ist jetzt eindeutig: Gelb oben, Grün rechts, Blau unten und Rot links. Jeder Spieler startet mit zehn Figuren in zwei Reihen.
- Bei mehr als vier Spielern weist der Host Spieler einer der vier Seiten/Allianzen zu. Beispiel: zwei Spieler auf Gelb gegen einen Spieler auf Grün (2 gegen 1). Mitglieder einer Allianz teilen die Farbe und können einander nicht schlagen.
- Mehrere Spieler auf derselben Seite bekommen getrennte Startblöcke. Pro Seite sind maximal vier Spieler vorgesehen; die übrigen müssen auf weitere Seiten verteilt werden.
- Das Brett passt sich Desktop und Smartphone an. Die Ecken sind keine Spielfelder, und Langstreckenzüge dürfen nicht durch diese Bereiche abkürzen.
- Die Service-Worker-Version wurde auf `schach-v8` erhöht, damit installierte Apps die neue Brettdarstellung laden.

Prüfung: `npm test` (23 automatisierte Tests) und `node --check` für Server und eingebettetes Frontend-JavaScript. Ein echter Mehrbrowser-Test mit mehreren Live-Socket-Verbindungen ist weiterhin nach dem Deployment erforderlich.


## Update 17 – FFA-Brett vollständig nach der Foto-Vorlage und bessere Zugübersicht

- Das FFA-Brett entspricht jetzt der Geometrie des Fotos: 8×8 Felder in der Mitte, vier 2×8-Startarme und abgeschrägte Plattenecken. Die Startarme verwenden dieselben grünen/elfenbeinfarbenen Schachfelder wie das Zentrum; die äußeren Ecken bleiben helle Brettplatte.
- Jeder Spieler startet mit der vollständigen 8er-Grundreihe (Turm, Springer, Läufer, Dame, König, Läufer, Springer, Turm) und acht Bauern – also 16 statt zuvor 10 Figuren.
- Bei mehreren Spielern auf derselben Seite bekommt jede Person ihren eigenen zwei Reihen breiten Startblock. Die Bretttiefe wächst entsprechend der Gruppengröße.
- Oben steht jederzeit gut sichtbar die aktuelle Spielzugnummer, der aktive Spieler, seine Brettseite und ob du selbst am Zug bist. Die Startzone des aktiven Spielers wird auf dem Brett markiert.
- Beim Auswählen einer Figur werden erlaubte Zielfelder gelb und mögliche Schlagfelder rot markiert. Der Server prüft jeden Zug weiterhin unabhängig.
- Eine kompakte Spielerübersicht zeigt lebende und ausgeschiedene Spieler, Verbindung und verbleibende Figuren. Darunter wird die Zugfolge nummeriert angezeigt.
- Die Bedienleiste klassischer Schachpartien wird im FFA-Modus ausgeblendet. Das Brett bleibt auf mobilen Bildschirmen eingepasst; bei großen Allianzbrettern kann gezielt gezoomt und gescrollt werden.
- Service-Worker-Cache auf `schach-v9` erhöht.

Prüfung: `npm test`, Server-Syntaxprüfung und eingebettete Frontend-Syntaxprüfung. Ein Test mit mehreren echten Browsern und Live-Socket-Verbindungen ist weiterhin nach dem Deployment erforderlich.


## Update 17 – FFA-Brett und Zugübersicht

- Das Alle-gegen-Alle-Brett verwendet jetzt die 8×8-Mitte mit vier 2×8-Startarmen wie auf der bereitgestellten Brettvorlage.
- Jeder Teilnehmer startet mit 16 Figuren: acht Grundfiguren (Turm, Springer, Läufer, Dame, König, Läufer, Springer, Turm) und acht Bauern.
- Die Figuren sind als eigene skalierbare SVG-Grafiken gestaltet, damit Form, Farbe und Schatten auf PC und Smartphone einheitlich dargestellt werden.
- Aktive Startreihe, ausgewähltes Feld, legale Zielfelder und Schlagfelder sind separat markiert.
- Die Oberfläche zeigt Zugnummer, Spieler am Zug, Reihenfolge, Figurenbestand und den letzten Zug.
- Der Server speichert und verteilt den letzten Zug an alle Spieler und Zuschauer.
- Der Service-Worker-Cache wurde auf `schach-v10` angehoben.

### Prüfung

`npm test` enthält jetzt 26 Tests. Zusätzlich wurden `server.js` und das eingebettete Frontend-JavaScript mit `node --check` geprüft. Ein echter Mehrbrowser-Online-Test benötigt weiterhin ein laufendes Deployment.


## Update 17 – FFA-Brett und Bedienoberfläche

- Das FFA-Brett bildet das Vorbild als 8×8-Mittelfeld mit vier 2×8-Startarmen und abgeschrägten Ecken ab.
- Jeder Spieler startet mit 16 Figuren: acht Grundfiguren und acht Bauern. Die vier Seiten sind zum Zentrum ausgerichtet.
- Figuren werden mit skalierbaren, schattierten Vektorgrafiken dargestellt; sie sind nicht von Emoji- oder Systemzeichensätzen abhängig.
- Die Zuganzeige zeigt die fortlaufende Spielzugnummer, die Position des aktiven Spielers in der Zugfolge, den aktiven Spieler, den letzten Zug sowie markierte legale Ziele.
- Spielerübersicht, Figuren-Legende, responsive Karten und einheitlichere Schaltflächen verbessern die Orientierung auf Desktop und Smartphone.
- Der Service-Worker-Cache wurde auf `schach-v11` aktualisiert.


## Update 17.1 – vollständige Figuren und klarere Zuganzeige

- Die FFA-Aufstellung wurde mit der 8×8-Mitte und vier 2×8-Armen abgeglichen. Jede der vier Seiten erhält sichtbar acht Grundfiguren und acht Bauern (16 Figuren pro Spieler). Die Eckbereiche der oktogonalen Brettplatte bleiben frei und beschneiden keine Startpositionen.
- Die Figuren-SVGs wurden mit abgestuften Sockeln, dezenteren Konturen, Glanzlichtern und plastischeren Farbverläufen überarbeitet.
- Die Zuganzeige unterscheidet nun eindeutig die fortlaufende Zugnummer von der aktuellen Spielerposition (z. B. „Spieler 2 / 4“). Nach einem Ausscheiden wird die Position anhand der noch lebenden Spieler berechnet. Name, Brettseite, eigener Zugstatus, Zugfolge und letzter Zug bleiben sichtbar.
- Brettfelder, aktive Startzone, legale Zielfelder und Schlagfelder haben klarer getrennte Farben. Spielerübersicht, Teamfarben und Zähler bleiben responsive.
- Menüs, Formulare und Schaltflächen wurden durchgängig mit ruhigeren Abständen, Fokuszuständen, Karten und mobilen Abständen vereinheitlicht.
- Service-Worker-Cache auf `schach-v12` erhöht, damit die aktualisierte Oberfläche nach dem Deployment neu geladen wird.

Prüfung: `npm test` (28 Tests), `node --check server.js` und Syntaxprüfung des eingebetteten Frontend-JavaScripts. Die FFA-Aufstellung wird zusätzlich auf die 16 Figuren je Spieler sowie auf ein 12×12-Brett mit 128 bespielbaren Feldern bei vier Spielern geprüft. Ein Live-Test mit mehreren echten Browsern bleibt nach dem Deployment erforderlich.
