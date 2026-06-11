# Statistikkportalen
Statistikkportalen er et uoffisielt grensesnitt som forbedrer tilgangen til SSBs data. Applikasjonen gir rask navigering gjennom lokal caching, et kompakt grensesnitt for å minimere scrolling, og enklere oppdagelse av tabeller gjennom menynavigering.

Applikasjonen kan tilpasses andre systemer som bruker PxWebApi v2, eksempelvis SCBs statistikkbank. Det krever kun at tre filer byttes ut: `config.js` (API-URL, kilde, språk), `subjects.js` (emnehierarki) og `synonyms.js` (søkesynonymer).

## Funksjonalitet
1. **Oppdag tabeller raskt og enkelt**
   - Søk gjennom alle SSBs tilgjengelige tabeller
   - Filtrer etter emne og frekvens
   - Oversiktlige kort med metadata (periode, oppdateringsdato, antall variabler)

2. **Variabelvelger**
   - Interaktivt grensesnitt for å velge verdier for hver dimensjon
   - Semantiske merker (Tid, Geografi, Statistikkvariabel) basert på JSON-stat2 `role`
   - Tidsdimensjon viser forventet periodeformat (f.eks. `2024M06`)
   - Støtte for kodelister, inkludert riktig håndtering av aggregeringer (`agg_*`) — sender automatisk `outputValues=aggregated` for korrekte summerte tall
   - Støtte for spesielle operatorer
     - `*` — Alle verdier
     - `top(n)` — De n siste verdiene (f.eks. `top(12)` for siste 12 måneder)
     - `from(periode)` — Alle verdier fra og med en gitt periode (f.eks. `from(2020M01)`)
   - Visuelle indikatorer for valideringsstatus

3. **API-bygger**
   - Generer GET- og POST-URL direkte fra variabelvalget
   - Støtte for alle responsformater (JSON-stat2, CSV, Excel, PX, HTML) — formatlisten leses dynamisk fra `/config` slik at den alltid speiler hva API-et faktisk støtter
   - Tidsdimensjonen optimeres automatisk: eksplisitte perioder erstattes med `from(startdato)` eller `top(n)` for en dynamisk URL som alltid henter ferske data
   - URL vises i klartekst som standard
   - Kopier URL eller POST-body med ett klikk

4. **Datavisning**
   - Intelligent standard layout
   - Sticky headers for enkel navigering i store tabeller
   - Norske tallformater (mellomrom som tusenskilletegn, komma som desimalskilletegn)
   - Korrekt visning av statuskoder (`.`, `..`, `:`) per SSBs konvensjon
   - Tabellinfo med direktelenke til "Om statistikken" på ssb.no

5. **Tabellrotasjon**
   - Drag-and-drop-grensesnitt for å endre tabellayout
   - Flytt dimensjoner mellom rader og kolonner
   - Hurtigvalg: Standard, Transponér, Alle som rader/kolonner

6. **Dataeksport**
   - Eksporter til Excel, CSV og PX-format
   - Valg for eksportformat, eksempelvis pivotvennlig CSV

7. **Caching**
   - Intelligent caching av API-kall i localStorage
   - Automatisk opprydding av utdaterte data

8. **Lagrede spørringer**
   - Lagre spørringer som kan gjenfinnes med lenke
   - Åpne en SSB-spørring ved å lime lenken inn i søkefeltet

9. **Smart søk (beta)**
   - Finn flere tabeller enn ved den vanlige søkemodusen

## Kom i gang
1. Åpne `index.html` i en moderne nettleser
2. Vent til tabellisten lastes (caches automatisk)
3. Søk eller bla til ønsket tabell
4. Velg verdier for variablene
5. Klikk «Hent data»
6. Utforsk, roter og eksporter data

## SEO-sider (pre-rendering)
Appen er hash-rutet (`#topic/...`), som er usynlig for søkemotorer. `scripts/generate-seo-pages.mjs`
genererer derfor statiske, crawlbare emnesider med pene URL-er
(f.eks. `/okonomi/nasjonalregnskap-og-konjunkturer/nasjonalregnskap/`) direkte i webroot,
pluss `sitemap.xml` og `robots.txt`. Sidene er fulle app-skall: brukere som lander der
overføres umiddelbart til den tilsvarende `#topic/...`-URL-en uten omlasting
(via `window.__SEO_TOPIC_PATH__`-bootstrapen i `index.html`).

Kjøres periodisk på serveren med cron (krever Node 18+):
```
15 4 * * 0 cd /sti/til/repo && node scripts/generate-seo-pages.mjs --webroot /sti/til/webroot --site https://statistikkportalen.no >> seo-gen.log 2>&1
```
Bruk `--dry-run` for å se hva som ville blitt skrevet. Scriptet sletter kun filer det selv
har generert (sporet i `{webroot}/.seo-manifest.json`), og avbryter uten å røre webroot
ved API-feil. De genererte filene skal ikke sjekkes inn i git.

## Systemkrav
- Moderne nettleser (Chrome, Firefox, Safari, Edge, Vivaldi)
- JavaScript aktivert
- Internettforbindelse (for API-kall)
- localStorage aktivert (for caching)

## Lisens
Denne koden er lisensiert under [MIT-lisens](LICENCE.md).
Data fra Statistisk sentralbyrå er lisensiert under [CC BY 4.0](https://www.ssb.no/diverse/lisens).
Data fra Statistiska centralbyrån er lisensiert under [CC0](https://www.scb.se/en/services/open-data-api/).
