#!/usr/bin/env node
/**
 * Nedlastingsscript for lokale SSB-tabellmetadata.
 *
 * Laster ned den eksakte responskroppen fra
 *   GET {apiBaseUrl}/tables/{id}/metadata?lang=no
 * for alle (eller endrede) tabeller til data/table-metadata/{id}.json — se
 * data/table-metadata/README.md for kontrakten filene må følge. Filene leses
 * av scripts/generate-seo-pages.mjs for å berike de statiske /table/{id}/-sidene
 * (notater, verdilabels, enheter, Klass-/VarDok-lenker). Dette scriptet
 * skriver ALDRI HTML/sider — det eier kun data/table-metadata/.
 *
 * Rate-limit: 20 kall/minutt som standard (SSBs grense er 30) — gjelder
 * samtlige kall, også den innledende /tables-listen. Full kald kjøring
 * (~10 000 tabeller) tar dermed rundt 8,5 time.
 *
 * Pausbart/gjenopptakbart: Ctrl+C når som helst avslutter ryddig mellom to
 * nedlastinger (aldri midt i en pågående fetch). Fremdrift spores i
 * data/table-metadata/.manifest.json — kjør scriptet på nytt for å fortsette
 * der det slapp.
 *
 * Inkrementell oppdatering: senere kjøringer sammenligner `updated`-feltet fra
 * en fersk /tables-liste mot manifestet og laster kun endrede/manglende/
 * mislykkede tabeller på nytt (se buildQueue()).
 *
 * Kjøres manuelt eller periodisk på serveren (cron), f.eks. månedlig:
 *   0 3 1 * * cd /sti/til/repo && node scripts/update-table-metadata.mjs >> table-metadata.log 2>&1
 *
 * Krever Node 18+ (global fetch). Ingen npm-avhengigheter.
 *
 * Bruk:
 *   node scripts/update-table-metadata.mjs [--metadata-dir <sti>] [--rate <kall/min>]
 *     [--limit <antall>] [--force] [--dry-run] [--min-tables <antall>]
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const MIN_TABLE_COUNT = 5000; // sanity-terskel: færre tabeller = trolig API-feil (overstyres med --min-tables)
const DEFAULT_RATE = 20; // kall/minutt (SSBs grense er 30)
const MANIFEST_SAVE_INTERVAL_MS = 5000; // maks hvor ofte manifestet skrives underveis
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5000, 15000]; // backoff mellom forsøk 1→2 og 2→3 (med mindre Retry-After er satt)
const PROGRESS_EVERY_N = 25;
const PROGRESS_EVERY_MS = 60000;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    metadataDir: path.join(REPO_ROOT, 'data', 'table-metadata'),
    rate: DEFAULT_RATE,
    limit: null,
    force: false,
    dryRun: false,
    minTables: MIN_TABLE_COUNT,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--metadata-dir') args.metadataDir = argv[++i];
    else if (a === '--rate') args.rate = parseInt(argv[++i], 10);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--min-tables') args.minTables = parseInt(argv[++i], 10);
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Ukjent argument: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    console.error('--rate må være et positivt tall');
    process.exit(2);
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit < 0)) {
    console.error('--limit må være et ikke-negativt tall');
    process.exit(2);
  }
  if (!Number.isFinite(args.minTables)) {
    console.error(
      'Bruk: node scripts/update-table-metadata.mjs [--metadata-dir <sti>] [--rate <kall/min>]\n' +
      '  [--limit <antall>] [--force] [--dry-run] [--min-tables <antall>]'
    );
    process.exit(2);
  }
  args.metadataDir = path.resolve(args.metadataDir);
  return args;
}

// ---------------------------------------------------------------------------
// App-konfigurasjon (duplisert fra generate-seo-pages.mjs)
// ---------------------------------------------------------------------------

/** Kjør en browser-global appfil i en sandkasse og les ut window.{key}.
 *  Duplisert fra generate-seo-pages.mjs. */
function loadBrowserGlobal(file, key) {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'js', file), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const value = sandbox.window[key];
  if (!value) throw new Error(`Klarte ikke å lese ${key} fra js/${file}`);
  return value;
}

/** Duplisert fra generate-seo-pages.mjs. */
function loadAppConfig() {
  const cfg = loadBrowserGlobal('config.js', 'AppConfig');
  if (!cfg.apiBaseUrl || !cfg.app?.name || !cfg.source) {
    throw new Error('AppConfig fra js/config.js mangler apiBaseUrl, app.name eller source');
  }
  return cfg;
}

/** API-språkkoden for standardspråket (SSB: 'no'). Duplisert fra generate-seo-pages.mjs. */
function apiLang(appConfig) {
  const langs = appConfig.languages || [];
  return (langs.find(l => l.code === appConfig.defaultLanguage) || langs[0])?.apiLang || 'no';
}

// ---------------------------------------------------------------------------
// Datainnhenting: /tables-listen (duplisert fra generate-seo-pages.mjs)
// ---------------------------------------------------------------------------

async function fetchTablesPage(appConfig, pageNumber, throttle) {
  const params = new URLSearchParams({
    lang: apiLang(appConfig),
    pageSize: String(appConfig.limits?.tablePageBatchSize || 10000),
    includeDiscontinued: 'true',
  });
  if (pageNumber > 1) params.set('pageNumber', String(pageNumber));
  const url = `${appConfig.apiBaseUrl}/tables?${params}`;
  await throttle();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API-feil ${res.status} for ${url}`);
  return res.json();
}

async function fetchAllTables(appConfig, minTables, throttle) {
  const first = await fetchTablesPage(appConfig, 1, throttle);
  const tables = first.tables ? [...first.tables] : [];
  const totalPages = first.page ? first.page.totalPages : 1;
  console.log(`[metadata] Hentet side 1/${totalPages} (${tables.length} tabeller)`);
  for (let p = 2; p <= totalPages; p++) {
    const page = await fetchTablesPage(appConfig, p, throttle);
    tables.push(...(page.tables || []));
    console.log(`[metadata] Hentet side ${p}/${totalPages} (totalt ${tables.length} tabeller)`);
  }
  if (tables.length < minTables) {
    throw new Error(`Bare ${tables.length} tabeller fra API-et (forventet minst ${minTables}) — avbryter uten å røre metadatakatalogen.`);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Rate-limiter — samme mønster som SSBApi._throttledFetch i js/api.js, men med
// et konfigurerbart intervall (her: 60000/rate ms) i stedet for fast 100ms.
// Kalles før HVERT kall mot API-et, inkludert /tables-listen.
// ---------------------------------------------------------------------------

function createThrottle(ratePerMinute) {
  const minIntervalMs = 60000 / ratePerMinute;
  let lastRequestTime = 0;
  return async function throttle() {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastRequestTime = Date.now();
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Manifest: data/table-metadata/.manifest.json
// ---------------------------------------------------------------------------

const MANIFEST_NAME = '.manifest.json';
const MANIFEST_VERSION = 1;

/** Korrupt manifest: warn høyt, omdøp til .manifest.json.corrupt-<ts>, start tomt.
 *  Mister kun fremdriftsinfo — ingen nedlastede filer går tapt. */
function loadManifest(metadataDir) {
  const p = path.join(metadataDir, MANIFEST_NAME);
  if (!fs.existsSync(p)) return { version: MANIFEST_VERSION, tables: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tables !== 'object' || !parsed.tables) {
      throw new Error('mangler tables-felt');
    }
    return parsed;
  } catch (err) {
    console.warn(`[metadata] ADVARSEL: korrupt manifest (${err.message}) — omdøper og starter med tomt manifest.`);
    try {
      fs.renameSync(p, path.join(metadataDir, `${MANIFEST_NAME}.corrupt-${Date.now()}`));
    } catch (renameErr) {
      console.warn(`[metadata] Klarte ikke å omdøpe korrupt manifest: ${renameErr.message}`);
    }
    return { version: MANIFEST_VERSION, tables: {} };
  }
}

/** Atomisk skriving — tmp-fil + rename (duplisert fra generate-seo-pages.mjs). */
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Throttler manifest-lagring til maks ~hvert 5. sekund; alltid skrivbar med force=true
 *  (siste lagring + SIGINT). */
function createManifestSaver(metadataDir, manifest) {
  let lastSaveTime = 0;
  return function saveManifest(force = false) {
    const now = Date.now();
    if (!force && now - lastSaveTime < MANIFEST_SAVE_INTERVAL_MS) return;
    lastSaveTime = now;
    atomicWrite(path.join(metadataDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  };
}

// ---------------------------------------------------------------------------
// Kø-logikk
// ---------------------------------------------------------------------------

/**
 * Bygger nedlastingskøen fra en fersk /tables-liste + eksisterende manifest.
 * En tabell settes i kø hvis:
 *  1. den mangler manifest-oppføring, eller
 *  2. status === 'failed' (feilede prøves alltid på nytt), eller
 *  3. status === 'ok' men {id}.json mangler på disk (selvreparerende), eller
 *  4. manifest[id].updated !== tabellens updated (dekker inkrementell oppdatering,
 *     gjelder også not_found-oppføringer — kanskje tabellen finnes igjen)
 *
 * Dedupliserer på id (Map, første vinner) og hopper over id-er som ikke
 * matcher ^[\w-]+$ (path-traversal-vern, samme regex som generatoren).
 */
function buildQueue(tables, manifest, metadataDir, force) {
  const byId = new Map();
  for (const t of tables) {
    if (byId.has(t.id)) continue;
    if (!/^[\w-]+$/.test(String(t.id))) {
      console.warn(`[metadata] Hopper over tabell med uventet id: ${JSON.stringify(t.id)}`);
      continue;
    }
    byId.set(t.id, t);
  }

  const queue = [];
  for (const t of byId.values()) {
    if (force) { queue.push(t); continue; }
    const entry = manifest.tables[t.id];
    if (!entry) { queue.push(t); continue; }
    if (entry.status === 'failed') { queue.push(t); continue; }
    if (entry.status === 'ok' && !fs.existsSync(path.join(metadataDir, `${t.id}.json`))) {
      queue.push(t);
      continue;
    }
    if (entry.updated !== t.updated) { queue.push(t); continue; }
  }
  return queue;
}

/** Foreldreløse filer: {id}.json på disk der id ikke lenger finnes i listen.
 *  Rapporteres kun — slettes aldri automatisk (ufarlige, generatoren leser dem
 *  bare ikke). */
function findOrphans(metadataDir, tables) {
  const knownIds = new Set(tables.map(t => String(t.id)));
  let entries;
  try {
    entries = fs.readdirSync(metadataDir);
  } catch {
    return [];
  }
  const orphans = [];
  for (const name of entries) {
    const m = name.match(/^([\w-]+)\.json$/);
    if (!m) continue; // hopper over .manifest.json, .tmp-filer osv.
    if (!knownIds.has(m[1])) orphans.push(m[1]);
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Nedlasting av én tabells metadata
// ---------------------------------------------------------------------------

/**
 * Henter Retry-After-headeren i millisekunder (sekunder eller HTTP-dato),
 * eller null hvis fraværende/ugyldig.
 */
function retryAfterMs(res) {
  const header = res.headers?.get?.('retry-after');
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Laster ned metadata for én tabell med inntil MAX_ATTEMPTS forsøk.
 * Returnerer { status: 'ok'|'not_found'|'failed', lastError? }.
 *
 * - 404 → terminal 'not_found', ingen fil skrives.
 * - Nettverksfeil/429/5xx → retry med backoff (respekterer Retry-After hvis
 *   satt, ellers 5s/15s).
 * - Annen non-2xx → 'failed' (ikke retry — antatt vedvarende, f.eks. 400).
 * - 2xx: leser kroppen som TEKST (res.text()) og skriver den eksakt uendret —
 *   kontrakten i data/table-metadata/README.md krever byte-for-byte identisk
 *   kropp. En defensiv JSON.parse() brukes kun til å VALIDERE gyldigheten
 *   (mot 200-med-HTML-feilside), aldri til å reserialisere filen.
 */
async function downloadOne(appConfig, tableId, metadataDir, throttle) {
  const url = `${appConfig.apiBaseUrl}/tables/${tableId}/metadata?lang=${apiLang(appConfig)}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      return { status: 'failed', lastError: `Nettverksfeil: ${err.message}` };
    }

    if (res.status === 404) {
      return { status: 'not_found' };
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const wait = retryAfterMs(res) ?? RETRY_DELAYS_MS[attempt - 1];
        await sleep(wait);
        continue;
      }
      return { status: 'failed', lastError: `HTTP ${res.status}` };
    }

    const body = await res.text();
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || !parsed.dimension || !parsed.label) {
        throw new Error('mangler dimension/label — trolig ikke et JSON-Stat2-datasett');
      }
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      return { status: 'failed', lastError: `Ugyldig respons: ${err.message}` };
    }

    atomicWrite(path.join(metadataDir, `${tableId}.json`), body);
    return { status: 'ok' };
  }

  return { status: 'failed', lastError: 'Ukjent feil (alle forsøk brukt)' };
}

// ---------------------------------------------------------------------------
// Fremdrift
// ---------------------------------------------------------------------------

function formatEta(msRemaining) {
  if (!Number.isFinite(msRemaining) || msRemaining < 0) return 'ukjent';
  const totalMinutes = Math.round(msRemaining / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}t ${minutes}min`;
}

// ---------------------------------------------------------------------------
// Pause/gjenopptak: SIGINT settes som flagg og sjekkes MELLOM iterasjoner,
// avbryter aldri en pågående fetch. Maks ett element går tapt (var uansett
// ikke merket ferdig, tas neste kjøring).
// ---------------------------------------------------------------------------

function main_registerSigint() {
  const state = { shuttingDown: false };
  process.on('SIGINT', () => {
    if (state.shuttingDown) {
      // Andre Ctrl+C: bruker vil ut nå, uansett
      process.exit(130);
    }
    state.shuttingDown = true;
    console.log('\n[metadata] Avbrutt (Ctrl+C) — fullfører pågående nedlasting, lagrer manifest og avslutter...');
  });
  return state;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const appConfig = loadAppConfig();
  const throttle = createThrottle(args.rate);

  console.log(`[metadata] API: ${appConfig.apiBaseUrl} (${appConfig.app.name})`);
  console.log(`[metadata] Metadatakatalog: ${args.metadataDir}`);
  console.log(`[metadata] Rate: ${args.rate} kall/min (${Math.round(60000 / args.rate)} ms mellom kall)`);

  if (!args.dryRun) {
    fs.mkdirSync(args.metadataDir, { recursive: true });
  }

  const tables = await fetchAllTables(appConfig, args.minTables, throttle);
  console.log(`[metadata] Hentet ${tables.length} tabeller fra /tables-listen.`);

  const manifest = loadManifest(args.metadataDir);
  const queue = buildQueue(tables, manifest, args.metadataDir, args.force);
  const orphans = findOrphans(args.metadataDir, tables);

  if (args.dryRun) {
    console.log(`\n[metadata] DRY RUN — ingenting lastes ned eller skrives.`);
    console.log(`[metadata] ${tables.length} tabeller totalt, ${queue.length} i kø for nedlasting${args.force ? ' (--force: hele listen)' : ''}.`);
    const sampleCap = 20;
    for (const t of queue.slice(0, sampleCap)) console.log(`  ${t.id}: ${t.label || ''}`);
    if (queue.length > sampleCap) console.log(`  … og ${queue.length - sampleCap} til`);
    if (orphans.length > 0) {
      console.log(`[metadata] ${orphans.length} foreldreløse filer (id ikke lenger i listen) — slettes aldri automatisk.`);
    }
    const estimatedMs = (queue.length * 60000) / args.rate;
    console.log(`[metadata] Estimert tid ved full kø: ${formatEta(estimatedMs)}.`);
    return;
  }

  if (orphans.length > 0) {
    console.log(`[metadata] ${orphans.length} foreldreløse filer funnet (id ikke lenger i /tables-listen) — rapporteres kun, slettes aldri automatisk.`);
    for (const id of orphans.slice(0, 20)) console.log(`  ${id}.json`);
    if (orphans.length > 20) console.log(`  … og ${orphans.length - 20} til`);
  }

  const toProcess = args.limit !== null ? queue.slice(0, args.limit) : queue;
  console.log(`[metadata] ${queue.length} tabeller i kø${args.limit !== null ? `, behandler maks ${args.limit} denne kjøringen` : ''}.`);

  const saveManifest = createManifestSaver(args.metadataDir, manifest);
  const sigint = main_registerSigint();

  const counters = { ok: 0, failed: 0, notFound: 0, unchanged: tables.length - queue.length };
  const startTime = Date.now();
  let lastProgressTime = startTime;
  let interrupted = false;

  for (let i = 0; i < toProcess.length; i++) {
    if (sigint.shuttingDown) { interrupted = true; break; }

    const table = toProcess[i];
    const result = await downloadOne(appConfig, table.id, args.metadataDir, throttle);

    const nowIso = new Date().toISOString();
    if (result.status === 'ok') {
      manifest.tables[table.id] = { updated: table.updated, fetchedAt: nowIso, status: 'ok' };
      counters.ok++;
    } else if (result.status === 'not_found') {
      manifest.tables[table.id] = { updated: table.updated, fetchedAt: nowIso, status: 'not_found' };
      counters.notFound++;
    } else {
      manifest.tables[table.id] = { updated: table.updated, fetchedAt: nowIso, status: 'failed', lastError: result.lastError };
      counters.failed++;
      console.warn(`[metadata] Feilet: ${table.id} (${result.lastError})`);
    }

    saveManifest();

    const n = i + 1;
    const now = Date.now();
    if (n % PROGRESS_EVERY_N === 0 || now - lastProgressTime >= PROGRESS_EVERY_MS || n === toProcess.length) {
      lastProgressTime = now;
      const pct = ((n / toProcess.length) * 100).toFixed(1);
      const avgMsPerItem = (now - startTime) / n;
      const eta = formatEta(avgMsPerItem * (toProcess.length - n));
      console.log(
        `[metadata] ${n}/${toProcess.length} (${pct}%) — nye/feilet/404/uendret: ` +
        `${counters.ok}/${counters.failed}/${counters.notFound}/${counters.unchanged} — ETA ${eta}`
      );
    }
  }

  saveManifest(true);

  console.log(`\n[metadata] ${interrupted ? 'Avbrutt' : 'Ferdig'}: ${counters.ok} nye/oppdaterte, ${counters.failed} feilet, ${counters.notFound} ikke funnet, ${counters.unchanged} uendret.`);
  if (interrupted) {
    console.log('[metadata] Kjør scriptet på nytt for å fortsette der det slapp.');
  }
}

main().catch(err => {
  console.error(`[metadata] FEIL: ${err.message}`);
  process.exit(1);
});
