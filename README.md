# Aqara FP Zones voor Homey

Homey Pro app voor de Aqara **FP300** en **FP400** aanwezigheidssensoren via **Zigbee**, zonder Aqara hub. Met afstand, live posities, zones die je zelf inkleurt en alle sensorinstellingen in Homey.

**Auteur:** Robert Hertzer
**Versie:** 0.8.0
**Vereist:** Homey Pro, firmware 12.2.0 of hoger, sensoren in Zigbee modus (omzetten in de Aqara Home app)

## Functies

### FP300 (batterij)
- Aanwezigheid (mmWave en PIR), afstand tot de dichtstbijzijnde persoon, temperatuur, luchtvochtigheid, helderheid en batterij
- **Afstandszones:** kies blokken van 25 cm (0 tot 6 m); het blok waarin je staat licht live op tijdens het inkleuren. De FP300 zelf bepaalt of er iemand is; de afstand bepaalt alleen in welke zone
- Detectiebereik instellen op een live strook: loop door de ruimte, het blok waarin je staat licht op, en kleur de blokken waar de sensor je moet zien (ook met gaten)
- Detectiebereik in meters, detectie met mmWave en/of PIR, gevoeligheid, afwezigheidsvertraging, PIR interval
- AI interferentiedetectie en adaptieve gevoeligheid
- Meten en rapporteren van temperatuur, vocht en licht: interval, drempel of beide
- Onderhoudsacties: identificeren, herstarten, AI ruimtelijk leren (met voortgang in de apparaatinstellingen), standaardinstellingen herstellen zonder opnieuw te koppelen
- Houdt rekening met slapen: instellingen gaan mee zodra de sensor wakker is, worden daarna teruggelezen, en de app voorspelt wanneer de sensor weer wakker wordt
- Afstandsmeting start direct bij binnenkomst (mmWave of PIR) en blijft lopen zolang er iemand is
- Bewegingsalarm instelbaar op mmWave, PIR of mmWave + PIR, zodat Homey zones (kamers) zo snel reageren als je wilt
- De naam van het bewegingsalarm laat zien wat de sensor op dat moment ziet: mmWave, PIR of beide
- Beantwoordt tijdvragen van de sensor, zoals Zigbee2MQTT dat doet

### FP400 (netstroom)
- Aanwezigheid, aantal personen, helderheid en bewegingsgebeurtenissen (binnenkomen, weggaan, dichterbij, weg)
- **Live posities** van meerdere personen op een kaart
- **Zones in elke vorm:** kleur blokken van 50 × 50 cm in op een raster van 8 × 10 m
- **Spookstippen aanpakken:** negeerplekken en "buiten de kamer" opgeslagen in de sensor zelf, een stip laten vergeten, en zones tellen stippen op die plekken nooit mee
- AI hoge precisie mensherkenning, adaptieve gevoeligheid, AI interferentiedetectie, gevoeligheid, afwezigheidsvertraging
- Onderhoudsacties: identificeren, AI ruimtelijk leren (met melding als het klaar is), standaardinstellingen herstellen zonder opnieuw te koppelen
- Helderheid: opvragen en bijwerken op interval, drempel of beide

### Matter
- Drivers voor de FP300 en FP400 via **Matter (Thread)**, met koppelinstructie en iconen
- Via Matter regelt Homey de sensor zelf: aanwezigheid, licht (en bij de FP300 temperatuur, vocht en batterij). Zones, posities, afstand en de uitgebreide instellingen werken alleen via **Zigbee**

### Zones
- Een zone wordt een **eigen Homey apparaat** dat je in elke ruimte kunt zetten, met bewegingsalarm, aantal personen en flowkaarten (persoon kwam binnen, persoon verliet zone)
- Aanmaken via een wizard in vier stappen; aanpassen in de app instellingen
- "Leeg na" instelbaar per zone: 0, 5, 15, 30 seconden of een eigen waarde tot 300 seconden
- Een zone verwijderen gaat door het zone apparaat te verwijderen

### Flowkaarten (selectie)
- FP300: afstand veranderd, kleiner of groter dan, binnen of buiten een bereik; conditie afstand tussen; acties afstandsmeting starten en detectiebereik instellen
- FP300 PIR: de PIR zag beweging, de PIR ziet geen beweging meer; conditie de PIR ziet beweging
- FP400: bewegingsgebeurtenis
- Beide: aantal personen veranderd, AI ruimtelijk leren is klaar (met "gelukt")

### Bediening
- Wizard en app instellingen volgen de lichte of donkere weergave van Homey, met een eigen keuze voor licht of donker
- Gemaakt voor de telefoon: kaart en strook passen op het scherm, knoppen geven direct feedback

## Installeren

```bash
npm install -g homey
homey login
npm install
homey select
homey app install
```

Testen met live logs: `homey app run --remote`

## Gebruiken

1. Koppel de sensoren via **Apparaat toevoegen, Aqara FP Zones**.
2. Maak zones via **Apparaat toevoegen, Aqara FP Zones, Zone (FP300 / FP400)**.
3. Pas zones, negeerplekken en buiten de kamer aan in de **app instellingen**.
4. Sensorinstellingen en onderhoudsacties staan bij het apparaat zelf.

Een FP300 slaapt om batterij te sparen. Een wijziging komt aan zodra hij wakker wordt; kort op de knop drukken of langs de sensor lopen maakt hem direct wakker.

## Beperkingen

- De FP300 meet alleen afstand, geen richting: zones moeten op verschillende afstanden van de sensor liggen, en hij volgt één persoon (de dichtstbijzijnde).
- De FP300 meldt niet wanneer AI ruimtelijk leren klaar is; de app gebruikt de 10 minuten die Aqara aanraadt.
- Herstarten van de FP400 is niet beschikbaar: er is geen Zigbee opdracht voor bekend.

## Voor ontwikkelaars

```bash
npm test                          # kerntests, geen Homey of sensor nodig
python3 tools/build-ui.py         # bouwt de webpagina's uit ui-src/
homey app validate --level publish
```

Lees `CLAUDE.md` voor de volledige architectuur, de Zigbee attributen, bevindingen uit tests en open punten. Pas `settings/index.html` en `drivers/fp400_zone/pair/wizard.html` niet met de hand aan; die worden gebouwd uit `ui-src/`.

## Releases

Bij elke push naar GitHub draaien automatisch de kerntests. Heeft `package.json` een nieuw versienummer, dan maakt GitHub er een release van, met de tekst uit `.homeychangelog.json`. Zie `.github/workflows/release.yml`.

## Bronnen en dank

- [Zigbee2MQTT / zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters): Zigbee attributen van de FP300
- [zigbee-herdsman](https://github.com/Koenkk/zigbee-herdsman): antwoord op tijdvragen
- [bobtekkk/aqara-fp400-zone-card](https://github.com/bobtekkk/aqara-fp400-zone-card) (MIT): FP400 posities, zones en sensorgebieden

## Licentie

MIT, Copyright (c) 2026 Robert Hertzer. Zie [LICENSE](LICENSE), inclusief de licentievermelding van overgenomen code.
