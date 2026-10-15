# Overdracht: Aqara FP Zones (Homey app)

Dit bestand is bedoeld voor een volgende Claude sessie (of een andere ontwikkelaar). Lees het helemaal voordat je iets verandert.

Stand: versie **0.7.1**, gebouwd in één lange samenwerking met de gebruiker, oktober 2026.

**Eigenaar en auteur:** Robert Hertzer. Repository: https://github.com/robiebab/aqara-fp-zones. Licentie: MIT (zie `LICENSE`, inclusief de MIT vermelding van het FP400 project waarvan code is overgenomen). Houd die vermelding altijd intact.

---

## 00. FP300: statussen, geen timers (0.7.0, uitdrukkelijk verzoek van de gebruiker)

De presence logica van de FP300 is een toestandsmachine. **Voeg hier geen tijdsregels aan toe** (geen debounce, geen "binnen X seconden", geen hold, geen timeout als beslissing); de gebruiker heeft dat expliciet afgewezen omdat je dan altijd te vroeg of te laat bent.

- Toestand: `_mmwave` en `_pir` (true/false/null = nog onbekend), `_session`.
- `_handleLumiAttributes`: een melding telt alleen als hij de toestand **verandert**; dezelfde toestand opnieuw (dubbele meldingen, de herhaalde "PIR on") doet niets en wordt niet gelogd.
- `_onStateChange`: iets aan en geen sessie → `_startSession` (afstandsmeting starten als die gewenst is) en `_applyMotionAlarm`. Beide uit → `_verifyAbsence`: direct `presence` en `pirDetection` teruglezen (het uit bericht is een wakker moment; geen eigen timeout); het antwoord loopt door dezelfde code. Pas als beide echt uit zijn: alarm uit, `_endSession`. `_verifyAbsence` nooit awaiten vanuit de handler (deadlock).
- Bewegingsalarm (`_motionValue`, "Bewegingsalarm bij"): aan zodra de bron aan is; uit zodra de bron uit is, behalve als dat "niemand" betekent: dan pas na de controle.
- Naam van het alarm (`_motionTitleKey`, `_applyMotionTitle`): direct bij elke verandering, geen debounce.
- PIR kaarten (`_pirCard`) en conditie (`pirActive()`): alleen op verandering van de PIR status.
- Afstandsmeting: start bij het begin van een sessie. De enige tijdsregel is `TRACK_RESTART_MS` (5 min): de FP300 stopt zijn meting zelf na 20 tot 30 minuten zonder dat te melden; daarom wordt hij bij een bericht van de sensor opnieuw gestart als de laatste start ouder is (`_keepMeasurementRunning`). Er wordt nooit iets gestopt op tijd en nooit iets buiten een wakker moment verstuurd. Geen afstand meer opvragen (gaf oude waarden).
- Onderhoud (configuratie, firmware, batterij, rapportage) alleen als er geen sessie is (`_housekeepingAllowed`), zonder tijdsuitzondering.
- Weggehaald in 0.7.0: minuuttimer, PIR hold (2 min), duplicaatvenster (2 s), debounce van de naam, "PIR zonder afstand na 10 s", "aanwezig zonder afstand 2 min", afstand opvragen, herhaald starten, polling, distance push job.
- Temperatuur, vocht en licht (0.7.1): niet meer via `registerCapability` (die logt en zet elke melding), maar via `_listenMeasurement`: `attr.measuredValue` van het cluster, omrekenen, en alleen zetten en loggen als de waarde veranderd is. Lichtomrekening zoals homey-zigbeedriver: `10^((raw - 1) / 10000)`, afgerond.
- Tests: `test/fp300-state.js` speelt echte logs na via `_onFrame` (onderdeel van `npm test`).

## 0. Belangrijk: versies 0.6.4 tot en met 0.6.6 zijn teruggedraaid

De gebruiker is teruggegaan naar 0.6.3 (git commit `f8bc1c3`) en daarvandaan verder gegaan met 0.6.7. De wijzigingen van 0.6.4 (zone volgt alleen de eigen aanwezigheid, PIR max 30 s), 0.6.5 ("leeg na" ook na "niemand meer") en 0.6.6 (alleen aan met live afstand) zitten er **niet** in. Ze staan nog in de git geschiedenis (commits `e28741c`, `45fe109`). Breng ze niet terug zonder overleg met de gebruiker; na 0.6.5 ging de gangzone "random" aan.

**0.6.9, op verzoek van de gebruiker:** zones volgen de hoofdsensor. `_zonePresence()` = het bewegingsalarm van het FP300 apparaat (zoals ingesteld met "Bewegingsalarm bij"). De hoofdsensor bepaalt óf er iemand is, de afstand alleen in wélke zone. Ziet de hoofdsensor niemand, dan gaan alle zones direct uit (geen "leeg na" na het uitgaan van de hoofdsensor, zoals in 0.6.3). "Leeg na" geldt alleen voor weglopen uit een zone terwijl de hoofdsensor nog iemand ziet. De PIR telt dus alleen voor zones als "Bewegingsalarm bij" op PIR of mmWave + PIR staat.

## 1. Wat de app doet

Een Homey Pro app (SDK 3, Homey Compose) voor twee Aqara aanwezigheidssensoren via **Zigbee**, zonder Aqara hub:

| Sensor | Zigbee model | Voeding | Wat de app biedt |
|---|---|---|---|
| **FP300** (PS-S04D) | `lumi.sensor_occupy.agl8` | batterij, slaapt | aanwezigheid, afstand tot persoon, temperatuur, vocht, licht, batterij, detectiebereik, AI instellingen, meet en rapportage instellingen, afstandszones (24 blokken van 25 cm), AI ruimtelijk leren met voortgang |
| **FP400** | `lumi.models.4447_8295` | netstroom | aanwezigheid, aantal personen, licht, bewegingsgebeurtenissen, live posities (x/y), getekende zones op een raster van 16 × 20 blokken van 50 cm, negeerplekken en "buiten de kamer" in de sensor, stip vergeten, AI instellingen |

Zones worden in een **wizard** gemaakt (Apparaat toevoegen, Aqara FP Zones, "Zone (FP300 / FP400)") en worden losse Homey apparaten die je in een eigen ruimte kunt zetten. Bestaande zones, negeerplekken en buiten kamer pas je aan in de **app instellingen**.

---

## 2. Werkafspraken met de gebruiker (belangrijk)

De gebruiker heeft vaste voorkeuren. Houd je hier altijd aan:

1. **Antwoord in het Nederlands.**
2. **Geen gedachtestreep** (— of –) in teksten die je schrijft. Gebruik dubbele punten, komma's of nieuwe zinnen.
3. **Teksten in een kopieervenster** (codeblok) als het tekst is die hij gaat gebruiken.
4. **Code:** leg uit wat je hebt gewijzigd en waarom, en lever altijd een volledige functie of het volledige bestand. In de praktijk lever je de hele app als zip.
5. **Niets verzinnen.** Zoek op, gebruik bestaande bronnen (Zigbee2MQTT broncode, Homey documentatie), of stel een vraag. Benoem eerlijk wat onzeker is.
6. Hij test op een echte Homey Pro met echte sensoren en stuurt logs. **Baseer conclusies op die logs**, en controleer aannames voordat je erop bouwt (zie de les in hoofdstuk 8).

Hij werkt op een Mac. Installeren gaat zo (in de projectmap):

```bash
npm install
homey app install            # blijvend installeren
homey app run --remote       # testen met live logs (stopt bij Ctrl+C)
```

Let op bij het uitpakken van een nieuwe zip naast een oude map: macOS maakt dan `aqara-fp-zones 2`. Controleer met `cat package.json | grep version`.

---

## 3. Ontwikkelen in deze map

```bash
npm install                     # afhankelijkheden (homey-zigbeedriver, zigbee-clusters)
npm test                        # kerntests, geen Homey of sensor nodig
python3 tools/build-ui.py       # bouwt de twee webpagina's uit ui-src/
homey app validate --level publish
```

**Regels:**
- Pas **nooit** `settings/index.html` of `drivers/fp400_zone/pair/wizard.html` met de hand aan. Die worden gebouwd uit `ui-src/`. Het bouwscript controleert ook dat elk element dat de code opzoekt met `$('id')` echt in de pagina staat (in 0.5.2 ging dat mis: de zonelijst was per ongeluk weggehaald).
- `app.json` wordt gegenereerd uit `.homeycompose/` en de `driver.*.compose.json` bestanden. Pas die aan, niet `app.json`.
- Verhoog bij elke levering het versienummer in **`.homeycompose/app.json` én `package.json`**, en voeg een regel toe aan `.homeychangelog.json` (en en nl).
- Valideer altijd op `publish` niveau voordat je levert.
- **Releases gaan automatisch** (`.github/workflows/release.yml`): bij elke push naar `main` draaien de kerntests, en als er nog geen release `vX.Y.Z` bestaat, maakt GitHub die aan met de tekst uit `.homeychangelog.json` (via `tools/release-notes.js`).
- Test de webpagina's in een browser met een nagebootste `Homey` (zie hoofdstuk 7), en controleer bij elke wijziging ook of de **hele pagina nog opent**, niet alleen het onderdeel dat je veranderde.

---

## 4. Projectstructuur

```
.homeycompose/app.json            id, versie, rechten (homey:wireless:zigbee), Web API routes
.homeycompose/capabilities/       target_distance, people_count, learning_progress
.homeycompose/flow/triggers/      people_changed (app niveau, voor FP400 en zones)
app.js                            event bus, getSensor(), getSensors(), getFp400()
api.js                            Web API voor de app instellingen pagina
lib/zclRaw.js                     ruwe ZCL frames: header, waarden, Lumi TLV structs, endpoint hook, default response
lib/AqaraClusters.js              eigen clusters (0xFCC0, 0xFC0A/B/C, 0x0080, occupancy uitbreiding)
lib/fp300Zones.js                 afstandsblokken (24 × 0,25 m) en BlockTracker
lib/fp300Reporting.js             meet en rapportage instellingen van de FP300 (omrekening)
lib/fp300Settings.js              ÉÉN tabel FP300 instelling <-> sensorattribuut (schrijven, lezen, meldingen, terugleescontrole)
lib/fp400Tracking.js              positieframes ontleden, raster 16 × 20, ZoneTracker
lib/fp400Areas.js                 negeerplekken en buiten kamer masks (40 bytes)
lib/wakePattern.js                leert wanneer een slapende sensor wakker wordt
lib/zigbeeTime.js                 antwoord op tijdvragen (Time cluster 0x000A)
lib/deviceUtil.js                 ensureCapabilities(), notify()
drivers/fp300/                    FP300 driver, device, instellingen, flowkaarten
drivers/fp400/                    FP400 driver, device, instellingen, flowkaarten
drivers/fp400_zone/               zone apparaat (FP300 én FP400), wizard in pair/wizard.html
drivers/fp300_matter/             FP300 via Matter: alleen manifest (koppelinstructie, iconen), vendor 4447, product 8197
drivers/fp400_matter/             FP400 via Matter: alleen manifest, vendor 4447, product 8295 (afgeleid uit het Zigbee model `lumi.models.4447_8295`, nog niet bevestigd)
settings/index.html               app instellingen (GEBOUWD uit ui-src)
ui-src/                           bron van de webpagina's: theme.css, map.js, wizard.body.html, settings.body.html
tools/build-ui.py                 bouwt de webpagina's
test/run.js                       kerntests (npm test)
locales/nl.json, en.json          alle teksten
```

De driver id van zones is om historische redenen `fp400_zone`, maar het werkt voor beide sensoren. Hernoem die id niet: dan raken gebruikers hun apparaten kwijt.

---

## 5. Architectuur per onderdeel

### 5.1 Berichten van sensoren (lib/zclRaw.js)

`hookEndpoint()` wikkelt `Endpoint.handleFrame` van zigbee-clusters, zodat de app elk ruw frame eerst ziet. Geeft de handler `true` terug, dan is het frame afgehandeld en stuurt de app zelf een default response (als de sensor erom vraagt). Reden: zigbee-clusters loopt vast op onbekende Aqara datatypes en kent het Aqara gebeurtenis commando `0x8B` niet.

### 5.2 FP300 (drivers/fp300/device.js)

**Slapen.** De FP300 luistert alleen kort nadat hij zelf iets stuurt. Daarom:
- instellingen gaan in een wachtrij `_pending` en worden verstuurd bij het volgende bericht van de sensor (`_scheduleFlush(true)`), één voor één;
- na schrijven leest de app de waarde terug (`_confirmWrite`); wijkt die af, dan volgt een tijdlijnmelding;
- na elke app start leest hij de echte instellingen uit de sensor (`_readConfiguration`), zodra die bereikbaar is;
- eenmalige acties (identificeren, AI ruimtelijk leren, herstarten) staan in `_oneShots` en gaan **alleen** mee op een wakker moment, nooit automatisch herhaald (een herstart zou anders blijven herhalen);
- `wakePattern` leert hoe vaak de sensor wakker wordt; na opslaan van instellingen toont Homey een melding met de verwachte tijd (onSettings mag een tekst teruggeven), en er staat een **waarschuwing op het apparaat** zolang iets wacht.

**Afstandsinstellingen (0.6.12).** Eén keuze `distance_mode` (`_distanceMode()`): `auto` (alleen met zones, standaard), `present` (altijd bij aanwezigheid), `always` (ook in een lege ruimte), `off`. Sinds 0.6.13 is `track_restart_minutes` geen instelling meer (gebruikers zien niet wanneer een meting begint of eindigt); de app verlengt elke 5 minuten (`TRACK_RESTART_MS`), plus eerder na 2 minuten zonder afstand en bij PIR beweging zonder afstand. De losse schakelaars `track_without_zones`, `track_on_presence`, `track_always` zijn eenmalig omgezet (store `distanceModeMigrated`). De experimentele opties `repeat_start`, `repeat_start_seconds` en `distance_push` staan niet meer in de instellingen; de code staat er nog maar is alleen actief als de oude instelling expliciet `true` is (niet meer te zetten).

**Afstand alleen als hij gebruikt wordt (0.5.28).** `_distanceWanted()`: de live strook staat open (`markViewer` zet `_viewerUntil`), of `distance_mode` vraagt erom (`auto` met zones, `present`, `always`). Anders gebruikt de FP300 alleen aanwezigheid en PIR. Conclusie met de gebruiker: de FP300 is niet geschikt voor meerdere betrouwbare zones (één dimensie, één persoon, afstand is geen doorlopende meting); voor één gebied per sensor gebruik je het **detectiebereik**. Dat stel je in in de app instellingen, tab "Detectiebereik" (alleen FP300): de live strook toont waar je staat, je kleurt blokken (gaten toegestaan, 24 blokken), en `setRangeBlocks` schrijft het masker `0x019A` (store `rangeBlocks`, settings `range_min`/`range_max` tonen de buitengrenzen). API: `PUT /fp400/:token/range`.

**Meetsessie (0.5.18, logica van de gebruiker).** PIR (of mmWave) ziet iemand en er loopt geen sessie: start de meting, sessie aan. Tijdens de sessie wordt de meting in leven gehouden (herstart elke `track_restart_minutes`, eerder na 2 minuten zonder afstand, en direct als de PIR beweging ziet terwijl er 10 s geen afstand was). mmWave aanwezigheid **en** PIR allebei uit: sessie uit, geen herstarts meer. PIR ziet weer iemand: nieuwe sessie. Zie `_onActivity`, `_checkSessionEnd`, `_sendTrackStart` (nooit twee starts binnen 5 s).

**Afstandsmeting.** De FP300 stuurt alleen een afstand (`0x015F`, cm) nadat `0x0198 = 1` is geschreven, en stopt daarna vanzelf (ongeveer 20 tot 30 minuten volgens een gebruiker). De app:
- herstart elke `track_restart_minutes` (standaard 5) zolang er iemand is, met een timer die het direct probeert; na een mislukte poging wacht hij 5 minuten (0.5.9);
- herstart eerder als er iemand is (mmWave of PIR) maar 2 minuten geen afstand binnenkwam (`STALE_DISTANCE_MS`, 0.5.14); de afstandsmeldingen zelf zijn wakkere momenten, dus zolang de meting loopt komt een herstart direct aan;
- er is geen bekende opdracht om de meting te stoppen; als er niemand meer is, herstart de app gewoon niet meer en stopt de meting vanzelf;
- start direct bij binnenkomst (aanwezigheid of PIR van uit naar aan) als er geen afstand is van de laatste 30 s (`_onArrival`);
- optie `track_always`: ook in een lege ruimte doorlopen (alleen met zones);
- start **niet** tijdens AI ruimtelijk leren of als het leren klaarstaat (`_learningBusy`);
- in `_flush` gaat `trackDistance` altijd vóór instellingen; komt er een start binnen terwijl een flush bezig is, dan draait de flush direct daarna opnieuw (`_flushAgain`), zonder op het volgende bericht te wachten (0.5.13).

**Batterij (0.6.3).** Uit de status struct `0x00F7`: tag `0x18` (percentage, zoals Zigbee2MQTT), anders tag `0x17` (mV) met een lineaire curve van 2850 mV (0 %) tot 3000 mV (100 %). Firmware 0.0.0_6542 stuurt `0x00F7` niet meer uit zichzelf (Z2M issue #32153); de app leest hem op een wakker moment als hij ouder is dan 4 uur of sinds de start nog niet binnenkwam (tot 0.6.2 werd "nog niet binnengekomen" overgeslagen, waardoor de batterij op die firmware nooit bijwerkte).

**Bewegingsalarm en Homey zones (0.6.7).** Homey's eigen zones (kamers) worden actief via `alarm_motion` (en contact, trilling, bezetting, aanwezigheid), niet via flowkaarten. Instelling `motion_source` (0.6.8, keuze; verving het ja/nee vinkje `motion_includes_pir` van 0.6.7, dat wordt omgezet naar `both`): `mmwave` (standaard, aanwezigheid van de sensor), `pir` (alleen de PIR; uit als de PIR uit meldt of na 2 minuten) of `both` (aan bij de eerste van de twee, uit als beide uit zijn). Zo wordt de Homey zone net zo snel actief als de PIR kaart. De mmWave aanwezigheid staat apart in `this._mmwave` (`_mmwavePresence()`); interne logica (sessie, zones) gebruikt die, niet het alarm. Zie `_updateMotionAlarm`.

**Naam van het bewegingsalarm (0.6.16).** Op verzoek van de gebruiker, zonder nieuwe capability: `setCapabilityOptions('alarm_motion', { title })` met "Beweging", "Beweging: mmWave", "Beweging: PIR" of "Beweging: mmWave + PIR" (`_motionTitleKey`, `MOTION_TITLES`). Homey noemt setCapabilityOptions duur; daarom alleen bij een echte wissel van bron, met 1,5 s samenvoegen (`MOTION_TITLE_DEBOUNCE_MS`), en de laatst getoonde staat in de store (`motionTitleShown`) zodat een herstart niet onnodig schrijft. De naam toont wat de sensor ziet, los van "Bewegingsalarm bij". Sinds 0.6.18, op uitdrukkelijk verzoek van de gebruiker, letterlijk de status van de sensor: PIR zolang `_pirActive` (tot "PIR off"), mmWave zolang `0x0142` aan is, beide als beide aan zijn; wisselt zodra een van beide uit meldt. (0.6.17 liet de PIR maar 10 s meetellen; dat wilde de gebruiker niet.) Samenvoegen alleen binnen 0,3 s.

**PIR flowkaarten (0.6.2).** Triggers `fp300_pir_on` en `fp300_pir_off`, conditie `fp300_pir_active` (`pirActive()`, zelfde limiet van 2 minuten). Een dubbele PIR melding binnen 5 s telt als één (`_pirFlow`). Let op: in mmWave + PIR modus zet de sensor de PIR uit zolang de mmWave al iemand ziet.

**Aanwezigheid voor zones.** `_effectivePresence()` = mmWave aanwezigheid (`0x0142`) **of** recente PIR beweging (`0x014D` = 1, telt tot PIR = 0, maximaal 2 minuten). Reden: de mmWave loopt soms achter op de PIR (0.5.11). Het aanwezigheidsalarm van het apparaat zelf volgt alleen `0x0142`.

**Zones.** 24 blokken van 0,25 m (`lib/fp300Zones.js`). Een zone is aan als er iemand is én het gemeten blok in de zone valt. Eén afstand, dus één persoon tegelijk (de dichtstbijzijnde).

**AI ruimtelijk leren.** Zie hoofdstuk 8 voor de bevindingen. De voortgang is **op tijd gebaseerd** (10 minuten, advies van Aqara op zijn forum). Getoond als capability `learning_progress` (tijdelijk toegevoegd), waarschuwing op het apparaat, tijdlijnmeldingen, flowkaart `fp300_learning_done`, en een **label in de apparaatinstellingen** (`learning_status`) met een tekstbalk, start bevestiging (`0x0157 = 1`), "kamer leeg sinds" en het laatste bericht met soort. Leest de sensor ooit `0x0157 = 0` (na eerst 1), dan stopt het leren eerder. 30 minuten na de start leest de app `0x0157` nog eens (proef, zie hoofdstuk 9).

**Tijdvragen.** De FP300 vraagt Homey om de tijd (cluster `0x000A`, attributen Time, TimeZone, DstShift). De app antwoordt zoals zigbee-herdsman (`lib/zigbeeTime.js`).

### 5.3 FP400 (drivers/fp400/device.js)

- **Posities:** elke 10 s `subscribeLocationData(timeout 120)` op cluster `0xFC0C` (interval uit het community project, niet aanpassen zonder test), alleen als er zones zijn of de kaart open staat. Frames: Aqara gebeurtenis `0x8B`, event 0.
- **Zones:** raster 16 kolommen × 20 rijen van 50 cm, x van -400 tot 400 cm, y van 0 tot 1000 cm, cel = rij × 16 + kolom. Een zone is een lijst cellen.
- **Negeerplekken en buiten kamer:** masks van 40 bytes in attributen 19 en 20 op `0xFC0A`. **Let op:** de sensor nummert kolommen van rechts naar links; `lib/fp400Areas.js` spiegelt dat. Na schrijven leest de app terug. Stippen op die cellen tellen ook in de app nooit mee voor zones (vangnet).
- **Stip vergeten:** commando 1 op `0xFC0C` met targetId.
- **AI instellingen:** attributen 41, 42, 44 (bool) op `0xFC0A`, met terugleescontrole.
- **AI ruimtelijk leren:** commando 3 op `0xFC0A`; het resultaat komt als event 3 (code in byte 7; 0 lijkt geslaagd, nog niet bevestigd). Vangnet na 15 minuten.
- **Licht:** endpoint 2 wordt niet gerapporteerd; Homey vraagt het op (instelbaar) en filtert met interval/drempel. In logs gaf de FP400 ruw `0` (= te donker om te meten volgens ZCL); onduidelijk of dat klopte.
- **Aantal personen:** attribuut 2 op `0xFC0B`, elke 30 s, maar niet als de kamer leeg is.

### 5.4 Zone apparaat (drivers/fp400_zone)

- Gekoppeld aan zijn zone via een **unieke zone id** (`uid` in de store), niet via het nummer (nummers worden hergebruikt).
- Apparaat verwijderen in Homey verwijdert ook de zone. Een zone met apparaat kan in de app instellingen **niet** verwijderd worden (de knop is verborgen); dat gaat via het apparaat. Losse zones (zonder apparaat) kunnen daar wel weg.
- De wizard (`pair/wizard.html`, gebouwd uit `ui-src/wizard.body.html`) heeft 4 stappen: sensor, inkleuren (raster of afstandsstrook), naam en "leeg na" (0, 5, 15, 30 s of eigen waarde 0 tot 300), controleren.

### 5.5 Webpagina's (ui-src)

- `map.js` bevat `FpMap` (FP400 raster), `FpRow` (FP300 strook, past zich aan de schermhoogte aan), `FpTimeoutPicker` en `fpTheme()`.
- **Kleuren:** `fpTheme()` volgt Homey, niet de telefoon. Volgorde: eigen keuze (app instelling `theme`: auto, light, dark), Homey dark class, Homey CSS variabelen, echte paginakleur, telefoon. Past de pagina niet bij de keuze, dan kleurt de app de achtergrond zelf.
- **Homey's eigen stijlblad** maakt ook gewone knoppen op en won van onze stijl (gekozen knoppen waren onzichtbaar). Daarom staan de knopstijlen met `!important`. Test altijd met een "vijandig" stijlblad dat alle knoppen grijs maakt.
- Polling (1 s) pauzeert als de pagina niet zichtbaar is.

---

## 6. Zigbee referentie (geverifieerd)

Bronnen: zigbee-herdsman-converters `src/devices/lumi.ts` en `src/lib/lumi.ts` (FP300, model PS-S04D), het MIT project `github.com/bobtekkk/aqara-fp400-zone-card` (FP400), zigbee-herdsman `src/utils/timeService.ts` (tijd). Fabrikantcode Aqara: `0x115F`.

### FP300, cluster 0xFCC0

| Attribuut | Type | Betekenis |
|---|---|---|
| `0x00E8` | bool | herstarten (schrijf false) |
| `0x00F7` | octstr | status struct (TLV): tag `0x17` spanning mV, `0x18` batterij % |
| `0x00DF` | octstr | tweede status struct (radiogegevens, betekenis grotendeels onbekend) |
| `0x010C` | uint8 | gevoeligheid 1 laag, 2 midden, 3 hoog |
| `0x0142` | uint8 | mmWave aanwezigheid |
| `0x014D` | uint8 | PIR beweging |
| `0x014F` | uint16 | PIR interval, 2 tot 300 s (setting `pir_interval`) |
| `0x0157` | uint8 | AI ruimtelijk leren starten (schrijf 1); blijft 1 staan |
| `0x015D` | uint8 | adaptieve gevoeligheid |
| `0x015E` | uint8 | AI interferentiedetectie |
| `0x015F` | uint32 | afstand in cm |
| `0x0197` | uint32 | afwezigheidsvertraging s |
| `0x0198` | uint8 | afstandsmeting starten (schrijf 1) |
| `0x0199` | uint8 | detectie met: 0 beide, 1 mmWave, 2 PIR |
| `0x019A` | octstr | detectiebereik: 2 bytes prefix + 24 bit mask (blok i = i × 0,25 m) |
| `0x0170` / `0x0192` | uint8 | meten temp en vocht / licht: 0 uit, 1 laag, 2 midden, 3 hoog, 4 eigen |
| `0x0162` / `0x0193` | uint32 | meettijd in ms |
| `0x0165`, `0x016C`, `0x0196` | uint8 | rapporteren bij: 1 drempel, 2 interval, 3 beide (temp, vocht, licht) |
| `0x0163`, `0x016A`, `0x0194` | uint32 | interval in ms (temp en vocht 600 tot 3600 s per 600; licht 20 tot 3600 s per 20) |
| `0x0164`, `0x016B`, `0x0195` | uint16 | drempel × 100 (temp 0,2 tot 3 °C; vocht 2 tot 15 %; licht 3 tot 20 %) |

Standaard clusters: temperatuur `0x0402`, vocht `0x0405`, licht `0x0400`, identify `0x0003`.

### FP400

| Cluster | Wat |
|---|---|
| `0x0406` occupancy, endpoint 1 | aanwezigheid; attribuut 3 = afwezigheidsvertraging |
| `0x0400`, endpoint 2 | licht (niet gerapporteerd) |
| `0x0080` | gevoeligheid (attr 0: 0 laag, 1 midden, 2 hoog) |
| `0xFC0A` | AI attributen 41/42/44, masks 19 (negeren) en 20 (buiten kamer), commando 3 leren, event 3 leerresultaat |
| `0xFC0B` | attr 2 aantal personen, event 0 bewegingsgebeurtenis |
| `0xFC0C` | commando 0 posities abonneren, commando 1 stip vergeten, event 0 posities |

---

## 7. Testen zonder sensor

- `npm test`: kerntests met echte frames uit de logs.
- Voor device logica is een mock gebruikt: `Module._load` onderscheppen voor `homey` en `homey-zigbeedriver`, een nep `homey` object (`__`, `setTimeout`, `setInterval`, `notifications`, `i18n`, `clock`, `app.bus`), en dan methodes aanroepen zoals `_handleLumiAttributes`, `_onFrame`, `_flush`. Zo zijn o.a. getest: zones verwijderen en hergebruiken, PIR als aanwezigheid, leervoortgang met de tijden uit echte logs, backoff bij slapende sensor.
- Webpagina's: de gebouwde HTML laden in Playwright (Chromium) met een nagebootst `Homey` object (`__`, `api`, `emit`, `get`, `set`, ...), plus een stijlblad dat Homey's knopstijl nabootst. Controleer: geen fouten in de console, en alle onderdelen werken.

---

## 8. Bevindingen uit de logs van de gebruiker

1. **Tijdvragen waren geen leerberichten.** In de eerste logs (app gaf toen geen antwoord) vroeg de FP300 elke 80 tot 120 s om de tijd, ook tijdens het leren (6 keer per 10 minuten). Sinds de app antwoordt (0.4.9), komen ze niet meer, ook niet tijdens het leren. **Les:** de voortgang was eerst op die berichten gebouwd (0.5.1) en bleef daarna op 0 % staan. Controleer altijd wat er gebeurt als je eigen wijziging het gedrag van de sensor verandert.
2. **`0x0157` blijft 1.** Het is de startknop van het leren; de waarde bleef 1, ook bijna 10 minuten na de start. Geen betrouwbaar "bezig" of "klaar" signaal.
3. **Bij elke leerstart** stuurt de FP300 binnen 0,2 s zelf `0x0157 = 1`: betrouwbare bevestiging van de start.
4. **Er komt geen "klaar" bericht.** Daarom de 10 minuten van Aqara. De Aqara hub toont "klaar" binnen seconden; vermoedelijk zodra de opdracht bevestigd is.
5. **Wakker maken:** langs de sensor lopen of kort op de knop drukken. Opdrachten buiten wakkere momenten mislukken meestal ("Het apparaat reageert niet").
6. **`0x00DF` tag `2c` = -92** bij één sensor: mogelijk signaalsterkte (onbevestigd).

---

## 8b. Wat er online over de FP300 afstand bekend is (oktober 2026)

- Zigbee2MQTT discussie #31203: na "track target distance" meldt de FP300 ongeveer 20 tot 30 minuten echte afstanden en blijft daarna op de laatste waarde staan. Er is geen echte oplossing; als workaround wordt de start periodiek opnieuw gestuurd.
- Home Assistant community: de afstand is niet bedoeld als continue realtime meting, maar om het detectiebereik in te stellen. Workaround: start bij beweging en daarna met een interval zolang er beweging is (dat doet onze meetsessie).
- Firmware: start 5234, daarna 0.0.0_5841 (januari 2026) en 0.0.0_6542 (mei 2026). Bijwerken gaat via de Aqara Home app (overschakelen naar Thread/Matter en terug naar Zigbee); Zigbee2MQTT heeft beide bestanden in zigbee-OTA. Volgens de Z2M code stuurt 6542 de `0x00F7` struct niet uit zichzelf.
- Op het Homey forum werd bij de FP300 uitval na 24 uur gemeld; de oplossing is binding en rapportage voor `0x0142` en `0x014D` (zoals Z2M #12383). Onze app doet dat bij het koppelen en na elke start.
- Volgens de Z2M documentatie zet de FP300 in mmWave + PIR modus de PIR uit zodra de mmWave aanwezigheid ziet; PIR kan dus uit gaan terwijl er iemand is. De meetsessie loopt dan door op de mmWave.

## 8c. Rapportage en netwerk (0.5.27)

- **Geen standaardrapportage voor temperatuur, vocht en licht.** De FP300 stuurt die waarden via zijn eigen Aqara meetinstellingen; de app luistert alleen (`attr.measuredValue`). Vroegere versies configureerden ze wel (via `registerCapability` met `reportOpts`), wat de rapportagetabel van de sensor vulde (`INSUFFICIENT_SPACE`). Bij bestaande sensoren worden die drie meldingen eenmalig verwijderd (`_refreshReporting`, store `stdReportsRemovedV1`).
- **Rapportage voor `0x0142` en `0x014D` na elke start opnieuw ingesteld**, op het eerste wakkere moment, en na opnieuw aanmelden op het netwerk.
- **Prevent leave (`0x00FC`)**: meldt de sensor false, dan zet de app hem terug op true, zodat de sensor niet van het netwerk valt.

## 8e. Standaardinstellingen herstellen (0.6.1)

Onderhoudsactie `button.reset_defaults` (FP300 en FP400), zie `lib/resetDefaults.js`:
1. app instellingen (alleen in Homey) terug naar de waarden uit het driver manifest;
2. ZCL Basic commando 0x00 "Reset to Factory Defaults": volgens de ZCL specificatie worden attributen teruggezet zonder het netwerk, bindingen of groepen te raken, dus de sensor blijft gekoppeld;
3. daarna worden de echte waarden uit de sensor gelezen.
Kent een FP300 het commando niet (ZCL status), dan schrijft de app standaardwaarden voor de detectie (mmWave + PIR, gevoeligheid 2, 10 s, AI aan, volledig bereik, meten midden). Voor de FP400 zijn geen gedocumenteerde standaardwaarden; daar blijft het dan bij de app instellingen. Zones in de app blijven altijd bewaard. Of de sensoren het commando ondersteunen, is nog niet getest.

## 8d. Matter (0.6.0)

- Homey regelt Matter apparaten zelf: een app kan alleen een driver manifest leveren met koppelinstructie en iconen (Homey documentatie "Creating a Matter Driver"). De capabilities in het manifest dienen alleen voor de App Store; Homey bepaalt ze zelf. Er is geen apparaatcode mogelijk, dus geen zones, afstand, instellingen of onderhoudsacties via Matter.
- Over Matter geeft de FP400 volgens Aqara alleen één aanwezigheid en één lichtsensor.
- Klopt de vendor/product id niet, dan kiest Homey deze driver niet en koppelt hij de sensor als algemeen Matter apparaat. De echte id's staan na het koppelen in de geavanceerde instellingen van het apparaat.

## 8f. Log 14 oktober: bewegingsalarm gang lang aan (0.6.10)

- Het bewegingsalarm volgde de sensor exact: uit binnen 3 ms na `mmWave presence off` + `PIR off`. In mmWave + PIR modus blijft `0x014D` (PIR) op 1 staan tot de sensor afwezigheid meldt; de PIR gaat dus tegelijk met de aanwezigheid uit.
- Wel gevonden: "herhaald starten" schreef elke 10 s naar de slapende gang ("Repeated start not reached"). Die opdrachten gaan niet verloren: Homey houdt ze vast en levert ze af bij het volgende wakkere moment. 1,4 s na "niemand" kwam zo een reeks `trackDistance` schrijfacties aan, en direct daarna meldde de sensor weer `PIR on`. Vermoedelijk start een meting de sensor weer op. Daarom: herhaald starten alleen binnen 2 s na een bericht van de sensor (`REPEAT_AWAKE_MS`), en standaard uit (eenmalig uitgezet op bestaande apparaten, store `repeatStartOffV1`). Herhaald starten gaf in alle logs 0 nieuwe afstanden.
- Of een lopende afstandsmeting de aanwezigheid van de sensor zelf langer aanhoudt, is niet bewezen.
- Tweede log 14 oktober: de gang stuurt na opnieuw koppelen zelf afstanden (ongeveer elke seconde bij lopen). De sensor herhaalt "PIR on" precies 60,0 s na de eerste melding als de PIR nog aan staat (in mmWave + PIR blijft de PIR aan tot afwezigheid). Sinds 0.6.11 telt alleen een overgang uit naar aan als nieuwe beweging (`pirActive()` vooraf); een herhaling ververst alleen de status: geen PIR kaart, geen herstart van de meting.

## 8g. Voortgangsregel AI leren (0.6.14)

Label `learning_status` heet "Voortgang: AI Ruimtelijk inleren". Homey kan een instelling niet inklappen of verbergen; "daarom toont de regel buiten het leren alleen "Niet bezig" (de uitleg hoe je start staat in de hint, achter de i) (`_setLearningIdle`, ook bij elke start van de app), tijdens het leren de voortgang, en na afloop 10 minuten de uitkomst (`LEARNING_RESULT_MS`).

## 8h. Geen aantal personen bij FP300 zones (0.6.20)

De FP300 meet alleen de dichtstbijzijnde persoon, dus een aantal kan alleen 0 of 1 zijn. Nieuwe FP300 zone apparaten krijgen bij het koppelen alleen `alarm_motion` (`capabilities` in `save_zone`); bestaande verliezen `people_count` bij de start (`_fitCapabilities`). De kaart "Aantal personen is veranderd" gaat bij FP300 zones niet meer af. In de zonelijst van de app instellingen staat bij een FP300 alleen "Bezet". FP400 zones houden het aantal.

## 8i. Iconen (0.6.21, 0.6.22)

FP300 iconen (Zigbee en Matter) zijn aangeleverd door de gebruiker. De FP400 iconen worden gemaakt met `tools/fp400-icon.py` (shapely): net als bij het FP300 icoon een ronde basis (muurplaat) achter het apparaat, met de FP400 schijf eroverheen; het sensorvenster is, in de stijl van het FP300 icoon, een afgeronde 'tong' die aan de dikke buitenlijn hangt, met uitlopende bochten aan de bovenkant en lijndikte 26; de dunne randlijn van de voorkant stopt bij het venster. Een tweede sleuf op de zijkant (zoals bij de FP300) past niet: de schijf is te dun. De clip zit verborgen achter de schijf. 960 × 960, kleur #231f20, buitenlijnen 40, binnenlijnen 18, ronde uiteinden; verborgen lijnen worden geometrisch weggehaald (geen SVG masks). De Matter versie neemt het Matter logo uit het FP300 Matter icoon en houdt 50 px afstand.

## 8j. Onderhoud pas als er niemand is (0.6.28)

Op verzoek van de gebruiker (log 15 oktober): uitlezen van configuratie, firmware, batterijstatus (`0x00F7`) en het verversen van de rapportage (`_pendingConfigRead`, `_pendingStructRead`, `_pendingReportingRefresh`, push job) gebeurt niet meer tijdens een meetsessie, maar op het wakkere moment dat de sensor "niemand" meldt (`_housekeepingAllowed`). Blijft er langer dan 30 minuten iemand (`HOUSEKEEPING_MAX_DEFER_MS`), dan toch. Instellingen van de gebruiker, de afstandsstart en onderhoudsacties wachten nooit. `_askDistanceIfSilent` draait pas ná het verwerken van een bericht, zodat een "niemand" bericht eerst de sessie beëindigt en er daarna geen afstand meer wordt gevraagd. Sinds 0.6.29 wordt `_housekeepingAllowed()` vóór elke stap opnieuw gecontroleerd: de eerste uitlezing (aanwezigheid) kan zelf laten zien dat er iemand is (log 15 oktober, keuken), en dan wacht de rest. Een stopcommando voor de afstandsmeting bestaat niet; na "niemand" stuurt de sensor in de logs ook geen afstanden meer.

## 8k. Dubbele meldingen (0.6.30)

De FP300 stuurt dezelfde aanwezigheids- of PIR melding soms 2 tot 3 keer binnen een seconde (log 15 oktober; waarschijnlijk herhalingen op Zigbee niveau, niet bevestigd). `_dropDuplicates` laat een melding met dezelfde waarde binnen 2 s (`DUPLICATE_MS`) vallen voordat hij verwerkt of gelogd wordt. Een "PIR on" later terwijl de PIR nog aan is (de herhaling na 20 tot 60 s) valt daar niet onder en blijft "repeated state".

## 8l. Afstand opvragen alleen met radar (0.6.31)

Log 15 oktober 13:21: na "niemand" zag alleen de PIR nog iets (de PIR kijkt verder dan de radar; de keuken zag op hetzelfde moment ook PIR). De app vroeg twee keer de afstand op en kreeg de oude 0,87 m, terwijl de radar niemand zag. `_askDistanceIfSilent` vraagt nu alleen op als `_mmwavePresence()` true is. Zelf gestuurde afstanden blijven altijd welkom.

## 8m. Afwezigheid eerst controleren (0.6.32)

Regel van de gebruiker: de PIR is de trigger, daarna tellen mmWave en PIR samen, en bij "uit" eerst de sensor uitlezen. `_requestAbsenceCheck(reason)`: na een "uit" melding (mmWave off, PIR off, of het bewegingsalarm dat uit zou gaan) leest de app `presence` en `pirDetection` terug (timeout 4 s, `ABSENCE_CHECK_TIMEOUT_MS`; het uit bericht is zelf een wakker moment). Pas daarna gaat het bewegingsalarm uit (`_updateMotionAlarm(source, true)`) en wordt `_checkSessionEnd` gedaan. Blijkt er toch iemand te zijn, dan wordt dat antwoord verwerkt als een melding en blijft alles aan. Geen antwoord: de meldingen worden vertrouwd. Let op: de controle mag nooit ge-await worden binnen `_handleLumiAttributes` (het antwoord loopt door dezelfde code; dat gaf een deadlock in de test). Een stopopdracht voor de afstandsmeting bestaat niet (zie 8j). Sinds 0.6.33 geen controle als het alarm al uit is en er geen sessie loopt (de sensor herhaalt "uit" soms 10 tot 15 s later).

**Open vermoeden (log 15 oktober 13:21:21 en 13:37:44):** twee keer kwam er direct na uitlezingen door de app (firmware, controle) een "PIR on" zonder dat de radar iemand zag, en 20 s later "PIR off". Mogelijk is dat echte beweging (de PIR kijkt verder dan de radar), maar het kan ook zijn dat radioverkeer de PIR laat afgaan. Niet bevestigd; zie het antwoord aan de gebruiker.

## 8n. Hoe vaak onderhoud (0.6.34)

Tijden staan in de store, zodat een herstart van de app niets extra uitleest (`_due(key, every)`): configuratie `configReadAt` (24 uur), rapportage verversen `reportingRefreshedAt` (24 uur), firmware `firmwareReadAt` (7 dagen, of als het veld nog "-" is), batterijstatus `structAt` (4 uur, `STRUCT_MAX_AGE_MS`). Na opnieuw aanmelden op het netwerk (`onEndDeviceAnnounce`) gebeurt alles direct, firmware ook. Standaardinstellingen herstellen leest de configuratie ook direct.

## 9. Open punten en onzekerheden

- Komt `0x0157` ooit terug op 0? De app logt dit 30 minuten na een leerstart (`Spatial learning state ... min after the start`). Ook de statusstructs worden gelogd als `tag=waarde` met "during learning" of "not learning": zoek een tag die alleen tijdens het leren verandert (kandidaten in `0x00F7`: `64`, `65`, `67`).
- De gang (FP300 `729d9202`) kreeg de start (`Written trackDistance 1`) en zag de gebruiker (`mmWave presence on`), maar stuurde geen afstand; de keuken wel. Log van 10 oktober: opvragen werkt (de gang gaf 87, 212 en 287 cm op verzoek), maar alleen op wakkere momenten, en zonder eigen afstandsmeldingen zijn die er weinig (52 s gat). `configureReporting` voor `0x015F` weigeren alle drie de FP300's met `INSUFFICIENT_SPACE` (rapportagetabel vol); de app probeert dat maar één keer per sensor. Sinds 0.5.22 vraagt de app tijdens een sessie elke 3 s zelf de afstand (`_pollDistance`), alleen bij sensoren die niet zelf sturen (`_distancePushAt`), met pauze na 3 mislukte pogingen. Uitkomst (log 10 oktober 15:18): de vragen werden beantwoord, maar de gang gaf steeds **1,37 m** terwijl de gebruiker 30 s op en neer liep over 4 m. Opvragen geeft dus de laatst bewaarde waarde, geen live meting. Polling staat daarom uit (`DISTANCE_POLLING = false`, 0.5.23). De gang meet kennelijk niet doorlopend na een start; oorzaak onbekend (firmware, of de volle rapportagetabel).
- Sinds 0.5.26: herhaald starten (`repeat_start`, standaard aan, `repeat_start_seconds` standaard 10): tijdens een sessie, als er 8 s geen zelf gestuurde afstand kwam, stuurt `_repeatStart` de start opnieuw en vraagt 1,5 s later `0x015F` op. Bij sessie einde logt de app hoeveel starts een nieuwe afstand gaven. Workaround die ook op het Home Assistant forum wordt aangeraden.
- Sinds 0.5.24: instelling `distance_push` ("Afstand automatisch laten melden"). `_runDistancePushJob` leest eerst de rapportagetabel (gelogd als `Report table ...`), probeert `0x015F` toe te voegen, en haalt bij `INSUFFICIENT_SPACE` één voor één de standaardmelding van licht, vocht, temperatuur weg (maxInterval 0xFFFF volgens ZCL) tot het past. Weggehaalde meldingen staan in de store (`freedReporting`); uitzetten zet alles terug. Stappen die op een slapende sensor stranden, gaan verder bij het volgende wakkere moment. Uitkomst bij de gebruiker nog onbekend.
- Hoe vaak de FP300 een afstand stuurt tijdens de meting (elke seconde, of alleen bij verandering, en vanaf welke stap): onbekend. De app logt elke afstand als `Distance x m (previous y s ago)`.
- FP400 leerresultaat code 0 = geslaagd: nog niet bevestigd.
- FP400 Matter product id 8295 is afgeleid, niet bevestigd.
- FP400 licht: ruw `0`; klopt de schaal?
- FP400 herstarten: geen Zigbee opdracht bekend, daarom niet aanwezig. Niet verzinnen.
- Fabrikantnaam in de driver manifesten: `Aqara` en `LUMI`; werkt bij de gebruiker.
- Of Homey het instellingenscherm live ververst terwijl het open is: onbekend; de uitleg zegt "sluit en open opnieuw".

---

## 9b. Instellingen en sensor gelijk houden (0.5.29)

- **FP300:** alle instellingen die in de sensor staan, lopen via `lib/fp300Settings.js` (`PLAIN` plus het detectiebereik). `onSettings` schrijft via die tabel, `_readConfiguration` leest alles via dezelfde tabel, en `_applySensorValues` verwerkt elke melding of leesantwoord met configuratiewaarden in de instellingen. Attributen met een wachtende schrijfactie worden overgeslagen, zodat een oude waarde een net gemaakte wijziging niet terugdraait. Na schrijven leest `_confirmWrite` terug; wijkt de sensor af, dan wordt de Homey instelling teruggezet naar de echte waarde. Het detectiebereik wordt vergeleken op de blokken, niet op het voorvoegsel.
- **FP400:** `_settingsTable()` met dezelfde opzet; schrijven met terugleescontrole voor alle instellingen (zoals het community project), uitlezen bij de start, en meldingen van die attributen werken de instellingen bij.
- Nieuwe instelling toevoegen? Zet hem in de tabel, niet los in `onSettings`, anders ontstaat er weer verschil.
- `npm test` controleert dat `driver.settings.compose.json` (FP300 en FP400) dezelfde bereiken, stappen en keuzes heeft als de tabellen. Pas je een bereik aan, doe het dan op beide plekken; de test vangt verschillen.
- Interval of drempel van temperatuur, vocht of licht aangepast terwijl "meten" niet op eigen instelling (4) staat: de app schrijft dan ook `thSampling` / `lightSampling` = 4 en zet de instelling op 4 (0.5.30).

## 10. Valkuilen die al eens misgingen

- **Homey stijlblad** overschrijft knoppen: gebruik `!important` en test met een vijandig stijlblad.
- **`prefers-color-scheme`** zegt niets over Homey's weergave: gebruik `fpTheme()`.
- **`setSettings()` roept `onSettings` niet aan.** Na `setSettings` vanuit code moet je zelf toepassen (bijvoorbeeld `applyRange`).
- **Labels** in apparaatinstellingen kun je met `setSettings` bijwerken (staat in de Homey documentatie).
- **Nieuwe capabilities** komen niet vanzelf op bestaande apparaten: `ensureCapabilities()` in `onNodeInit`.
- **Driver flowkaart ids** zijn app breed uniek: gebruik verschillende ids per driver (bijvoorbeeld `fp300_learning_done`, `fp400_learning_done`).
- **Bij het weghalen van UI blokken** niet te ruim knippen: het bouwscript controleert nu ontbrekende elementen.
- **Batterij:** elke extra opdracht naar de FP300 kost batterij. Geen periodieke opdrachten toevoegen zonder reden en zonder backoff.

---

## 11. Waar de geschiedenis staat

`.homeychangelog.json` bevat per versie wat er veranderde, van 0.1.0 tot nu.
