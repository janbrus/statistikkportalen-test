# Lokale tabellmetadata

Én fil per tabell: `{id}.json` (id matcher `^[\w-]+$`), med den **eksakte,
umodifiserte responskroppen** fra

    GET {apiBaseUrl}/tables/{id}/metadata?lang=no

(JSON-Stat2-dataset, UTF-8 uten BOM, ingen innpakking/konvolutt). Filene
lastes ned av `scripts/update-table-metadata.mjs` og leses av
`scripts/generate-seo-pages.mjs`, som beriker de statiske `/table/{id}/`-sidene
med notater, verdilabels, enheter og Klass-/VarDok-lenker. Tabeller uten
gyldig fil får sider bygget fra `/tables`-listen alene (fallback) — en
manglende eller korrupt fil stopper aldri genereringen.

Regler for scriptet som skriver hit:

- Skriv atomisk (midlertidig fil + rename) — generatoren kan lese samtidig.
- Lagre kun 2xx-responser; behold eksisterende fil ved API-feil.
- Filene kan være gamle: generatoren henter alltid tidsperiode og
  oppdatert-dato fra den ferske `/tables`-listen, aldri herfra.

JSON-filene er gitignored (`data/table-metadata/*.json`); katalogen
overstyres i generatoren med `--metadata-dir`.
