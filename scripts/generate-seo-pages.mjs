#!/usr/bin/env node
/**
 * SEO-sidegenerator for Statistikkportalen.
 *
 * Genererer statiske, crawlbare emnesider (pene URL-er som
 * /okonomi/nasjonalregnskap-og-konjunkturer/nasjonalregnskap/) og én side per
 * tabell, også avsluttede (/table/{id}/) i webroot, pluss sitemap.xml, robots.txt og
 * seo-map.json (rute → kanonisk URL, brukes av js/seo-head.js). Hver side er
 * et fullt app-skall basert på den deployede index.html: crawlere ser statisk
 * innhold (brodsmuler, underemner, tabelliste) og JSON-LD strukturerte data
 * (BreadcrumbList + DataCatalog/Dataset for Google Dataset Search), mens
 * appen ved lasting bytter URL til den kanoniske hash-ruten (#topic/... eller
 * #variables/{id}) via window.__SEO_TOPIC_PATH__ / window.__SEO_TABLE_ID__
 * (se bootstrap-snutten i index.html).
 *
 * Tabellsidene er Dataset-enes kanoniske landingssider: Google ignorerer
 * #-fragmenter, så Dataset.url må peke på en ekte URL med markup — aldri
 * /#variables/{id}. hreflang genereres ikke (engelsk finnes kun som
 * klientside-språkbytte, ikke som egne URL-er).
 *
 * Sidedybden speiler appen (topic-view.js): nivåer t.o.m. AppConfig.ui
 * .topicCardDepth får egne sider med lenker til undersidene, mens første nivå
 * under kortene blir én samlet oversiktsside med hele undertreet som
 * seksjoner — ingen dypere sider genereres.
 *
 * Forsiden (index.html) får også statisk innhold i #content som speiler appens
 * egen forside (søkefelt + emnegrid), pluss en SEO-tekstseksjon. Visningene i
 * appen beholder pre-rendret innhold som plassholder under første datalasting
 * (seoContentMatchesRoute i js/utils.js), så siden ikke blinker ved oppstart.
 * Originalinnholdet bevares base64-kodet i en markør-kommentar, slik at
 * scriptet kan gjenopprette en uberørt mal ved neste kjøring.
 *
 * API-endepunkt, sidestørrelse, appnavn og kildeinfo leses fra appens egne
 * js/config.js og js/subjects.js (via node:vm) — én kilde til sannhet, og
 * scriptet fungerer uendret for andre PxWebApi-instanser.
 *
 * Kjøres periodisk på serveren (cron), f.eks. ukentlig:
 *   15 4 * * 0 cd /sti/til/repo && node scripts/generate-seo-pages.mjs \
 *     --webroot /sti/til/webroot --site https://statistikkportalen.no >> seo-gen.log 2>&1
 *
 * Krever Node 18+ (global fetch). Ingen npm-avhengigheter.
 *
 * Sikkerhet: scriptet sletter kun filer/mapper det selv har skrevet, sporet i
 * {webroot}/.seo-manifest.json. Ved API-feil eller mistenkelig lite data
 * avbrytes kjøringen uten å røre webroot.
 *
 * NB: tre-byggingen i buildHierarchy() er en duplikat av
 * MenuHierarchy._addPathToHierarchy() i js/menu-hierarchy.js — endres
 * tre-strukturen der, må den oppdateres her også.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const MIN_TABLE_COUNT = 5000; // sanity-terskel: færre tabeller = trolig API-feil (overstyres med --min-tables)

// Navn som aldri kan brukes som mappe på toppnivå i webroot
const RESERVED_TOP_LEVEL = new Set([
  'js', 'css', 'scripts', 'assets', 'img', 'images', 'fonts',
  'index.html', 'test.html', 'api-explorer.html',
  'robots.txt', 'sitemap.xml', 'favicon.ico',
  'table', 'seo-map.json',
]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { webroot: null, site: null, dryRun: false, minTables: MIN_TABLE_COUNT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--webroot') args.webroot = argv[++i];
    else if (a === '--site') args.site = argv[++i];
    else if (a === '--min-tables') args.minTables = parseInt(argv[++i], 10);
    else if (a === '--dry-run') args.dryRun = true;
    else {
      console.error(`Ukjent argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.webroot || !args.site || !Number.isFinite(args.minTables)) {
    console.error('Bruk: node scripts/generate-seo-pages.mjs --webroot <sti> --site <https://...> [--min-tables <antall>] [--dry-run]');
    process.exit(2);
  }
  args.webroot = path.resolve(args.webroot);
  args.site = args.site.replace(/\/+$/, '');
  return args;
}

// ---------------------------------------------------------------------------
// Datainnhenting
// ---------------------------------------------------------------------------

async function fetchTablesPage(appConfig, pageNumber) {
  const params = new URLSearchParams({
    lang: apiLang(appConfig),
    pageSize: String(appConfig.limits?.tablePageBatchSize || 10000),
    includeDiscontinued: 'true',
  });
  if (pageNumber > 1) params.set('pageNumber', String(pageNumber));
  const url = `${appConfig.apiBaseUrl}/tables?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API-feil ${res.status} for ${url}`);
  return res.json();
}

async function fetchAllTables(appConfig, minTables) {
  const first = await fetchTablesPage(appConfig, 1);
  const tables = first.tables ? [...first.tables] : [];
  const totalPages = first.page ? first.page.totalPages : 1;
  console.log(`[SEO] Hentet side 1/${totalPages} (${tables.length} tabeller)`);
  for (let p = 2; p <= totalPages; p++) {
    const page = await fetchTablesPage(appConfig, p);
    tables.push(...(page.tables || []));
    console.log(`[SEO] Hentet side ${p}/${totalPages} (totalt ${tables.length} tabeller)`);
  }
  if (tables.length < minTables) {
    throw new Error(`Bare ${tables.length} tabeller fra API-et (forventet minst ${minTables}) — avbryter uten å røre webroot.`);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// App-konfigurasjon (gjenbrukt fra appens egne filer via node:vm)
// ---------------------------------------------------------------------------

/** Kjør en browser-global appfil i en sandkasse og les ut window.{key}. */
function loadBrowserGlobal(file, key) {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'js', file), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const value = sandbox.window[key];
  if (!value) throw new Error(`Klarte ikke å lese ${key} fra js/${file}`);
  return value;
}

function loadAppConfig() {
  const cfg = loadBrowserGlobal('config.js', 'AppConfig');
  if (!cfg.apiBaseUrl || !cfg.app?.name || !cfg.source) {
    throw new Error('AppConfig fra js/config.js mangler apiBaseUrl, app.name eller source');
  }
  return cfg;
}

/** Velg riktig språk fra en flerspråklig {språk: tekst}-label (js/subjects.js).
 *  Tåler også en ren streng for bakoverkompatibilitet. */
function pickLabel(value, uiLang) {
  if (value && typeof value === 'object') {
    return value[uiLang] || value.nb || Object.values(value)[0] || '';
  }
  return value;
}

/** UI-språkkoden for standardspråket (SSB: 'nb'). */
function uiLang(appConfig) {
  return appConfig.defaultLanguage || appConfig.languages?.[0]?.code || 'nb';
}

/**
 * Leser SubjectConfig fra js/subjects.js og løser de flerspråklige
 * meny-labelene (group.label / subjectNames) ned til standardspråkets streng,
 * slik at resten av scriptet kan behandle dem som rene strenger.
 */
function loadSubjectConfig(appConfig) {
  const cfg = loadBrowserGlobal('subjects.js', 'SubjectConfig');
  if (!cfg.subjectGroups || !cfg.subjectNames) {
    throw new Error('SubjectConfig fra js/subjects.js mangler subjectGroups/subjectNames');
  }
  const lang = uiLang(appConfig);
  const subjectGroups = {};
  for (const [id, group] of Object.entries(cfg.subjectGroups)) {
    subjectGroups[id] = { ...group, label: pickLabel(group.label, lang) };
  }
  const subjectNames = {};
  for (const [code, name] of Object.entries(cfg.subjectNames)) {
    subjectNames[code] = pickLabel(name, lang);
  }
  return { ...cfg, subjectGroups, subjectNames };
}

/** API-språkkoden for standardspråket (SSB: 'no'). */
function apiLang(appConfig) {
  const langs = appConfig.languages || [];
  return (langs.find(l => l.code === appConfig.defaultLanguage) || langs[0])?.apiLang || 'no';
}

// ---------------------------------------------------------------------------
// Hierarki (duplikat av MenuHierarchy._addPathToHierarchy i js/menu-hierarchy.js)
// ---------------------------------------------------------------------------

function buildHierarchy(tables) {
  const hierarchy = {};
  for (const table of tables) {
    if (!table.paths || table.paths.length === 0) continue;
    for (const tablePath of table.paths) {
      if (tablePath.length === 0) continue;
      const subjectCode = tablePath[0].id;
      if (!hierarchy[subjectCode]) {
        hierarchy[subjectCode] = {
          id: subjectCode,
          label: tablePath[0].label,
          sortCode: tablePath[0].sortCode,
          children: {},
          tables: [],
        };
      }
      let node = hierarchy[subjectCode];
      for (let i = 1; i < tablePath.length; i++) {
        const seg = tablePath[i];
        if (!node.children[seg.id]) {
          node.children[seg.id] = {
            id: seg.id,
            label: seg.label,
            sortCode: seg.sortCode,
            children: {},
            tables: [],
          };
        }
        node = node.children[seg.id];
      }
      node.tables.push(table);
    }
  }
  return hierarchy;
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

function slugify(label) {
  return label
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // fjern diakritiske tegn (é→e, ü→u)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Unik slug innenfor én foreldermappe; kollisjoner får -{id}-suffiks. */
function uniqueSlug(label, nodeId, usedSlugs) {
  let slug = slugify(label) || nodeId.toLowerCase();
  if (usedSlugs.has(slug)) slug = `${slug}-${slugify(nodeId)}`;
  let candidate = slug;
  let n = 2;
  while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
  usedSlugs.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Sidetre: gruppe → emne → underemner (alle dybder)
// ---------------------------------------------------------------------------

function dedupeActiveTables(tables) {
  const seen = new Set();
  const out = [];
  for (const t of tables) {
    if (t.discontinued) continue;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

function subtreeStats(node, stats = { ids: new Set(), discontinued: new Set(), lastUpdated: null }) {
  for (const t of node.tables) {
    (t.discontinued ? stats.discontinued : stats.ids).add(t.id);
    if (!t.discontinued && t.updated && (!stats.lastUpdated || t.updated > stats.lastUpdated)) {
      stats.lastUpdated = t.updated;
    }
  }
  for (const child of Object.values(node.children)) subtreeStats(child, stats);
  return stats;
}

/**
 * Bygger flat liste av sider som skal genereres. Hver side:
 * { dir, url, hashPath, label, breadcrumbs, children, tables,
 *   sections, discontinuedCount, activeCount, totalCount, lastUpdated }
 *
 * Som i appen (topic-view.js): nivåer t.o.m. cardDepth får egne sider med
 * lenker til undersidene (kort), mens første nivå under kortene blir én samlet
 * oversiktsside med hele undertreet som seksjoner — ingen dypere sider.
 */
function buildPages(subjectConfig, hierarchy, cardDepth) {
  const pages = [];

  const bySortCode = (a, b) => String(a.sortCode).localeCompare(String(b.sortCode));
  const byUpdatedDesc = (a, b) => String(b.updated || '').localeCompare(String(a.updated || ''));

  // Hele undertreet som nestede seksjoner (for oversiktssidene under kort-nivåene)
  function buildSections(childNodes) {
    const sections = [];
    for (const child of [...childNodes].sort(bySortCode)) {
      const childStats = subtreeStats(child);
      if (childStats.ids.size === 0) continue;
      sections.push({
        label: child.label,
        tableCount: childStats.ids.size,
        tables: dedupeActiveTables(child.tables).sort(byUpdatedDesc),
        children: buildSections(Object.values(child.children)),
      });
    }
    return sections;
  }

  function addNode(node, label, dir, hashPath, breadcrumbs) {
    const stats = subtreeStats(node);
    const activeCount = stats.ids.size;
    const totalCount = stats.ids.size + stats.discontinued.size;
    const childNodes = Object.values(node.children).sort(bySortCode);

    if (activeCount === 0 && childNodes.length === 0) return null; // tom node — hopp over

    // Under kort-nivåene: samlet oversiktsside med hele undertreet, ingen undersider
    const isOverview = hashPath.length > cardDepth;

    const children = [];
    let sections = [];
    if (isOverview) {
      sections = buildSections(childNodes);
    } else {
      const usedSlugs = new Set();
      for (const child of childNodes) {
        const childStats = subtreeStats(child);
        if (childStats.ids.size === 0 && Object.keys(child.children).length === 0) continue;
        const slug = uniqueSlug(child.label, child.id, usedSlugs);
        const childPage = addNode(
          child, child.label, `${dir}/${slug}`, [...hashPath, child.id],
          [...breadcrumbs, { label, dir }]
        );
        if (childPage) children.push({ label: child.label, dir: childPage.dir, tableCount: childPage.totalCount });
      }
    }

    const page = {
      dir,
      hashPath,
      label,
      breadcrumbs,
      children,
      sections,
      tables: dedupeActiveTables(node.tables).sort(byUpdatedDesc),
      discontinuedCount: isOverview
        ? stats.discontinued.size
        : node.tables.filter(t => t.discontinued).length,
      activeCount,
      totalCount,
      lastUpdated: stats.lastUpdated,
    };
    pages.push(page);
    return page;
  }

  const usedTopSlugs = new Set(RESERVED_TOP_LEVEL);
  for (const group of Object.values(subjectConfig.subjectGroups)) {
    // Gruppe-id-ene (arbeid, befolkning, ...) er allerede stabile ascii-slugs
    const groupSlug = uniqueSlug(group.id, group.id, usedTopSlugs);
    const usedSubjectSlugs = new Set();
    const groupChildren = [];
    let groupLastUpdated = null;
    let groupActive = 0;
    let groupTotal = 0;

    for (const subjectCode of group.subjects) {
      const node = hierarchy[subjectCode];
      if (!node) continue;
      const label = subjectConfig.subjectNames[subjectCode] || node.label;
      const slug = uniqueSlug(label, subjectCode, usedSubjectSlugs);
      const subjectPage = addNode(
        node, label, `${groupSlug}/${slug}`, [subjectCode],
        [{ label: group.label, dir: groupSlug }]
      );
      if (!subjectPage) continue;
      groupChildren.push({ label, dir: subjectPage.dir, tableCount: subjectPage.totalCount });
      groupActive += subjectPage.activeCount;
      groupTotal += subjectPage.totalCount;
      if (subjectPage.lastUpdated && (!groupLastUpdated || subjectPage.lastUpdated > groupLastUpdated)) {
        groupLastUpdated = subjectPage.lastUpdated;
      }
    }

    if (groupChildren.length === 0) continue;
    pages.push({
      dir: groupSlug,
      hashPath: [group.id],
      label: group.label,
      breadcrumbs: [],
      children: groupChildren,
      sections: [],
      tables: [],
      discontinuedCount: 0,
      activeCount: groupActive,
      totalCount: groupTotal,
      lastUpdated: groupLastUpdated,
      isGroup: true,
    });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Canonical: samme node (delsubtre) kan nås via flere stier → identiske sider
// på ulike URL-er. Vi beholder alle sidene, men lar duplikatene canonicalisere
// mot den første (primære) URL-en med samme innhold, så Google forstår originalen.
// ---------------------------------------------------------------------------

/** Innholdssignatur for en side — utelater brødsmuler og URL/dir (kun synlig
 *  hovedinnhold teller), slik at to sider med samme innhold på ulike stier matcher. */
function pageSignature(page) {
  const ser = (secs) => (secs || []).map(s => ({
    label: s.label,
    tableCount: s.tableCount,
    tables: s.tables.map(t => t.id).sort(),
    children: ser(s.children),
  }));
  return JSON.stringify({
    label: page.label,
    tables: page.tables.map(t => t.id).sort(),
    children: page.children.map(c => [c.label, c.tableCount]),
    sections: ser(page.sections),
    discontinuedCount: page.discontinuedCount,
  });
}

/** Setter page.canonicalDir på hver side: første side med en gitt signatur er
 *  primær (selv-refererende canonical), senere duplikater peker til den. */
function assignCanonicals(pages) {
  const firstBySig = new Map();
  for (const page of pages) {            // pages er i deterministisk genereringsrekkefølge
    const sig = pageSignature(page);     // (subjectGroups-rekkefølge + sortCode) = "første sti"
    if (!firstBySig.has(sig)) firstBySig.set(sig, page.dir);
    page.canonicalDir = firstBySig.get(sig);
  }
  const dupes = pages.filter(p => p.canonicalDir !== p.dir).length;
  if (dupes) console.log(`[SEO] ${dupes} duplikatsider får canonical mot primær sti.`);
  return pages;
}

// ---------------------------------------------------------------------------
// HTML-generering
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

// Forside-injeksjonen rammes inn av markører med originalinnholdet
// base64-kodet, slik at malen kan gjenopprettes uberørt ved neste kjøring
// (index.html er både deployet forside og mal for undersidene).
const ROOT_CONTENT_RE = /(<div id="content">)[\s\S]*?<!-- seo-root:start orig="([A-Za-z0-9+/=]*)" -->[\s\S]*?<!-- seo-root:end -->[\s\S]*?(<\/div>)/;
const ROOT_JSONLD_RE = /\n?[ \t]*<script type="application\/ld\+json" id="seo-root-jsonld">[\s\S]*?<\/script>/;
const ROOT_SEO_PATH_RE = /\n?[ \t]*<script>window\.__SEO_TOPIC_PATH__=\[\];<\/script>/;

function stripRootInjection(html) {
  const m = html.match(ROOT_CONTENT_RE);
  if (m) html = html.replace(ROOT_CONTENT_RE, () => `${m[1]}${Buffer.from(m[2], 'base64').toString('utf8')}${m[3]}`);
  return html.replace(ROOT_JSONLD_RE, '').replace(ROOT_SEO_PATH_RE, '');
}

function loadTemplate(webroot) {
  const templatePath = path.join(webroot, 'index.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Fant ikke ${templatePath} — webroot må inneholde den deployede appen.`);
  }
  const template = stripRootInjection(fs.readFileSync(templatePath, 'utf8'));
  if (!template.includes('__SEO_TOPIC_PATH__')) {
    throw new Error('Deployet index.html mangler __SEO_TOPIC_PATH__-bootstrapen — deploy appversjonen med SEO-støtte (v1.4.1+) først.');
  }
  if (!template.includes('__SEO_TABLE_ID__')) {
    throw new Error('Deployet index.html mangler __SEO_TABLE_ID__-bootstrapen — deploy appversjonen med tabellside-støtte (v1.5.0+) først.');
  }
  return template;
}

/** Erstatt med regex og feil høylytt hvis ankeret ikke finnes i malen. */
function mustReplace(html, regex, replacement, what) {
  if (!regex.test(html)) {
    throw new Error(`Fant ikke anker for ${what} i index.html-malen — malen har endret seg, oppdater scriptet.`);
  }
  return html.replace(regex, replacement);
}

// Google trunkerer snippets rundt 155–160 tegn — hele beskrivelsen må holde seg innenfor
const MAX_DESCRIPTION_LENGTH = 155;

/** Fjern id-prefiks fra tabelletiketter («13760: Befolkning…» → «Befolkning…»),
 *  samme regel som extractTableTitle() i js/utils.js. */
function cleanLabel(label) {
  return String(label || '').replace(/^\d+:\s*/, '');
}

/** Kommaseparert liste med så mange hele elementer som får plass i budsjettet;
 *  tom streng hvis ikke engang det første elementet får plass. */
function fitList(items, budget) {
  let out = '';
  for (const item of items) {
    const next = out ? `${out}, ${item}` : item;
    if (next.length > budget) {
      if (out) out += '…';
      break;
    }
    out = next;
  }
  return out;
}

function buildDescription(page, appConfig) {
  const n = page.activeCount;
  const sourceName = appConfig.source.nameFull || appConfig.source.name;
  let desc = `Statistikk om ${page.label.toLowerCase()}: ${n} ${n === 1 ? 'tabell' : 'tabeller'} fra ${sourceName}.`;
  const childLabels = page.children.length > 0
    ? page.children.map(c => c.label)
    : (page.sections || []).map(s => s.label);
  // «Omfatter A, B, …» — droppes helt hvis ikke engang det første navnet får plass
  const childPart = fitList(childLabels, MAX_DESCRIPTION_LENGTH - desc.length - ' Omfatter .'.length);
  if (childPart) desc += ` Omfatter ${childPart}.`;
  return desc;
}

function buildTableDescription(t, appConfig) {
  const sourceName = appConfig.source.nameFull || appConfig.source.name;
  const periodPart = t.firstPeriod && t.lastPeriod
    ? ` med tall for perioden ${t.firstPeriod}–${t.lastPeriod}` : '';
  let desc = `${t.discontinued ? 'Avsluttet statistikktabell' : 'Statistikktabell'} ${t.id} fra ${sourceName}${periodPart}.`;
  const names = Array.isArray(t.variableNames) ? t.variableNames : [];
  const varPart = fitList(names, MAX_DESCRIPTION_LENGTH - desc.length - ' Variabler: .'.length);
  if (varPart) desc += ` Variabler: ${varPart}.`;
  return desc;
}

function formatDateNo(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function tableListHtml(tables) {
  const items = tables.map(t => {
    const updated = t.updated ? ` <small>(oppdatert ${escapeHtml(formatDateNo(t.updated))})</small>` : '';
    // Pen URL (ikke /#variables/) så crawlere oppdager tabellsidene
    return `<li><a href="/table/${escapeAttr(t.id)}/">${escapeHtml(t.label)}</a>${updated}</li>`;
  });
  return `<ul>${items.join('\n')}</ul>`;
}

/** Nestede undertre-seksjoner på oversiktssider: overskrift + tabelliste per nivå. */
function sectionsHtml(sections, level) {
  const h = Math.min(level, 4);
  const parts = [];
  for (const s of sections) {
    parts.push(`<h${h}>${escapeHtml(s.label)} <small>(${s.tableCount} ${s.tableCount === 1 ? 'tabell' : 'tabeller'})</small></h${h}>`);
    if (s.tables.length > 0) parts.push(tableListHtml(s.tables));
    if (s.children.length > 0) parts.push(sectionsHtml(s.children, level + 1));
  }
  return parts.join('\n      ');
}

function buildContentHtml(page, appConfig) {
  const parts = [];

  // Brodsmuler (pene URL-er oppover, gjeldende side som tekst) — samme
  // klasser/separator som appens egne brodsmuler (js/topic-view.js)
  const crumbs = [`<a class="breadcrumb-link" href="/">${escapeHtml(appConfig.app.name)}</a>`];
  for (const crumb of page.breadcrumbs) {
    crumbs.push(`<a class="breadcrumb-link" href="/${escapeAttr(crumb.dir)}/">${escapeHtml(crumb.label)}</a>`);
  }
  crumbs.push(`<span class="breadcrumb-current" aria-current="page">${escapeHtml(page.label)}</span>`);
  parts.push(`<nav class="breadcrumbs" aria-label="Brodsmulesti">${crumbs.join('<span class="breadcrumb-sep">/</span>')}</nav>`);

  parts.push(`<h1>${escapeHtml(page.label)}</h1>`);
  parts.push(`<p>${escapeHtml(buildDescription(page, appConfig))}</p>`);
  if (page.lastUpdated) {
    parts.push(`<p><small>Nyeste tabelloppdatering: ${escapeHtml(formatDateNo(page.lastUpdated))}.</small></p>`);
  }

  if (page.children.length > 0) {
    parts.push('<h2>Underemner</h2>');
    const items = page.children.map(c =>
      `<li><a href="/${escapeAttr(c.dir)}/">${escapeHtml(c.label)}</a> (${formatCount(c.tableCount)} ${c.tableCount === 1 ? 'tabell' : 'tabeller'})</li>`
    );
    parts.push(`<ul>${items.join('\n')}</ul>`);
  }

  if (page.tables.length > 0) {
    parts.push('<h2>Tabeller</h2>');
    parts.push(tableListHtml(page.tables));
  }

  if ((page.sections || []).length > 0) {
    parts.push(sectionsHtml(page.sections, 2));
  }

  if (page.discontinuedCount > 0) {
    parts.push(`<p><small>${page.discontinuedCount} avsluttede tabeller vises ikke her, men er tilgjengelige i portalen.</small></p>`);
  }

  return parts.join('\n      ');
}

/** Alle tabeller en side viser (direkte + i undertre-seksjoner), dedupet på id. */
function collectPageTables(page) {
  const out = new Map();
  for (const t of page.tables) out.set(t.id, t);
  (function walk(sections) {
    for (const s of sections || []) {
      for (const t of s.tables) if (!out.has(t.id)) out.set(t.id, t);
      walk(s.children);
    }
  })(page.sections);
  return [...out.values()];
}

/** SSB-periode → ISO 8601 for temporalCoverage: "2006" → "2006", "2006M01" → "2006-01",
 *  kvartal/uke/halvår ("2006K1" osv.) → året. */
function isoPeriod(period) {
  const m = String(period || '').match(/^(\d{4})(?:M(\d{2}))?/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

/**
 * Ett Dataset-objekt (schema.org) for en tabell. url peker alltid på tabellens
 * egen statiske side /table/{id}/ — Dataset-ets kanoniske landingsside.
 */
function datasetJsonLd(t, site, appConfig) {
  const source = appConfig.source;
  const creator = {
    '@type': 'Organization',
    name: source.nameFull || source.name,
    url: source.url,
  };
  const periodPart = t.firstPeriod && t.lastPeriod
    ? ` med tall for perioden ${t.firstPeriod}–${t.lastPeriod}` : '';
  const coverage = isoPeriod(t.firstPeriod) && isoPeriod(t.lastPeriod)
    ? `${isoPeriod(t.firstPeriod)}/${isoPeriod(t.lastPeriod)}` : null;
  return {
    '@type': 'Dataset',
    name: t.label,
    description: `${t.label}. ${t.discontinued ? 'Avsluttet statistikktabell' : 'Statistikktabell'} ${t.id} fra ${creator.name}${periodPart}.`,
    identifier: t.id,
    url: `${site}/table/${t.id}/`,
    isAccessibleForFree: true,
    ...(coverage ? { temporalCoverage: coverage } : {}),
    ...(Array.isArray(t.variableNames) && t.variableNames.length ? { keywords: t.variableNames } : {}),
    ...(t.updated ? { dateModified: String(t.updated).slice(0, 10) } : {}),
    ...(source.licenseUrl ? { license: source.licenseUrl } : {}),
    creator,
  };
}

/**
 * Strukturerte data (schema.org JSON-LD): CollectionPage + BreadcrumbList for
 * alle sider, pluss DataCatalog med Dataset per tabell (trigget av Google
 * Dataset Search) på sider som lister tabeller.
 */
function buildJsonLd(page, site, appConfig) {
  const url = `${site}/${page.dir}/`;
  const source = appConfig.source;
  const graph = [];

  graph.push({
    '@type': 'CollectionPage',
    name: `${page.label} – ${appConfig.app.name}`,
    url,
    description: buildDescription(page, appConfig),
    inLanguage: 'no',
    ...(page.lastUpdated ? { dateModified: String(page.lastUpdated).slice(0, 10) } : {}),
    isPartOf: { '@type': 'WebSite', name: appConfig.app.name, url: `${site}/` },
  });

  const crumbItems = [
    { name: appConfig.app.name, item: `${site}/` },
    ...page.breadcrumbs.map(c => ({ name: c.label, item: `${site}/${c.dir}/` })),
    { name: page.label, item: url },
  ];
  graph.push({
    '@type': 'BreadcrumbList',
    itemListElement: crumbItems.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.item,
    })),
  });

  const allTables = collectPageTables(page);
  if (allTables.length > 0) {
    graph.push({
      '@type': 'DataCatalog',
      name: `${page.label} – ${appConfig.app.name}`,
      url,
      ...(source.licenseUrl ? { license: source.licenseUrl } : {}),
      dataset: allTables.map(t => datasetJsonLd(t, site, appConfig)),
    });
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

function renderPage(template, page, site, appConfig) {
  // Duplikatsider canonicaliserer mot den primære URL-en med samme innhold
  const canonicalUrl = `${site}/${page.canonicalDir || page.dir}/`;
  const title = `${page.label} – ${appConfig.app.name}`;
  const description = buildDescription(page, appConfig);

  let html = template;

  html = mustReplace(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`, '<title>');
  html = mustReplace(
    html,
    /<meta name="description" content="[^"]*" id="meta-description">/,
    `<meta name="description" content="${escapeAttr(description)}" id="meta-description">`,
    'meta description'
  );
  html = mustReplace(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeAttr(canonicalUrl)}">`, 'canonical');
  html = mustReplace(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeAttr(title)}">`, 'og:title');
  html = mustReplace(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(description)}">`, 'og:description');
  html = mustReplace(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeAttr(canonicalUrl)}">`, 'og:url');

  // Relative asset-stier → absolutte (sidene ligger 1–4 mapper dypt)
  html = html.replace(/href="css\//g, 'href="/css/').replace(/src="js\//g, 'src="/js/');

  // JSON-LD strukturerte data ("<" escapes så "</script>" i labels ikke kan bryte ut).
  // id="seo-jsonld" lar appen (js/seo-head.js) fjerne den ved navigering bort.
  const jsonLd = JSON.stringify(buildJsonLd(page, site, appConfig)).replace(/</g, '\\u003c');
  html = mustReplace(
    html,
    /<\/head>/,
    `  <script type="application/ld+json" id="seo-jsonld">${jsonLd}</script>\n</head>`,
    '</head> (JSON-LD)'
  );

  // Embed topic-path før første app-script
  html = mustReplace(
    html,
    /(<script src="\/js\/version\.js")/,
    `<script>window.__SEO_TOPIC_PATH__=${JSON.stringify(page.hashPath)};</script>\n  $1`,
    'script-injeksjon (js/version.js)'
  );

  // Statisk crawlbart innhold i #content
  matchContentDiv(html);
  html = html.replace(CONTENT_DIV_RE, `$1\n      ${buildContentHtml(page, appConfig)}\n    $3`);

  return html;
}

const CONTENT_DIV_RE = /(<div id="content">)([\s\S]*?)(<\/div>)/;

function matchContentDiv(html) {
  const match = html.match(CONTENT_DIV_RE);
  if (!match) throw new Error('Fant ikke <div id="content"> i malen.');
  if (match[2].length > 500) {
    throw new Error('<div id="content"> i malen har uventet mye innhold — strukturen kan ha endret seg, oppdater scriptet.');
  }
  return match;
}

// ---------------------------------------------------------------------------
// Tabellsider (/table/{id}/): Dataset-enes kanoniske landingssider
// ---------------------------------------------------------------------------

/**
 * Én side per tabell — også avsluttede (historiske tall er søkbare og
 * tilgjengelige i portalen). Brødsmule-forelderen er den dypeste emnesiden
 * langs tabellens første sti (paths[0], konsistent med appens
 * buildNavigationBreadcrumb) — emnesider finnes bare t.o.m. cardDepth+1,
 * mens tabellstiene kan gå dypere.
 */
function buildTableEntries(tables, pages) {
  const pageByHashPath = new Map(pages.map(p => [p.hashPath.join('/'), p]));
  const entries = new Map();
  for (const t of tables) {
    if (entries.has(t.id)) continue;
    if (!/^[\w-]+$/.test(t.id)) {
      console.warn(`[SEO] Hopper over tabell med uventet id: ${JSON.stringify(t.id)}`);
      continue;
    }
    let crumbPage = null;
    const firstPath = (t.paths && t.paths[0]) || [];
    for (let len = firstPath.length; len > 0 && !crumbPage; len--) {
      crumbPage = pageByHashPath.get(firstPath.slice(0, len).map(seg => seg.id).join('/')) || null;
    }
    entries.set(t.id, { id: t.id, dir: `table/${t.id}`, table: t, crumbPage });
  }
  return [...entries.values()];
}

function buildTableContentHtml(entry, appConfig) {
  const t = entry.table;
  const label = cleanLabel(t.label);
  const src = appConfig.source;
  const parts = [];

  const crumbs = [`<a class="breadcrumb-link" href="/">${escapeHtml(appConfig.app.name)}</a>`];
  if (entry.crumbPage) {
    for (const crumb of entry.crumbPage.breadcrumbs) {
      crumbs.push(`<a class="breadcrumb-link" href="/${escapeAttr(crumb.dir)}/">${escapeHtml(crumb.label)}</a>`);
    }
    const crumbDir = entry.crumbPage.canonicalDir || entry.crumbPage.dir;
    crumbs.push(`<a class="breadcrumb-link" href="/${escapeAttr(crumbDir)}/">${escapeHtml(entry.crumbPage.label)}</a>`);
  }
  crumbs.push(`<span class="breadcrumb-current" aria-current="page">${escapeHtml(label)}</span>`);
  parts.push(`<nav class="breadcrumbs" aria-label="Brodsmulesti">${crumbs.join('<span class="breadcrumb-sep">/</span>')}</nav>`);

  parts.push(`<h1>${escapeHtml(label)}</h1>`);
  parts.push(`<p>${escapeHtml(buildTableDescription(t, appConfig))}</p>`);

  const meta = [`Tabell-ID: ${escapeHtml(t.id)}`];
  if (t.discontinued) meta.push('Status: Avsluttet — tabellen oppdateres ikke lenger, men tallene er fortsatt tilgjengelige');
  if (t.firstPeriod && t.lastPeriod) meta.push(`Tidsperiode: ${escapeHtml(t.firstPeriod)}–${escapeHtml(t.lastPeriod)}`);
  if (t.updated) meta.push(`Sist oppdatert: ${escapeHtml(formatDateNo(t.updated))}`);
  const license = src.licenseUrl
    ? ` (<a href="${escapeAttr(src.licenseUrl)}" rel="noopener noreferrer">${escapeHtml(src.licenseName || 'lisens')}</a>)` : '';
  meta.push(`Kilde: <a href="${escapeAttr(src.url)}" rel="noopener noreferrer">${escapeHtml(src.nameFull || src.name)}</a>${license}`);
  parts.push(`<ul>${meta.map(m => `<li>${m}</li>`).join('\n')}</ul>`);

  if (Array.isArray(t.variableNames) && t.variableNames.length > 0) {
    parts.push('<h2>Variabler i tabellen</h2>');
    parts.push(`<ul>${t.variableNames.map(v => `<li>${escapeHtml(v)}</li>`).join('\n')}</ul>`);
  }

  parts.push(`<p><a href="/#variables/${escapeAttr(t.id)}">Åpne tabellen i ${escapeHtml(appConfig.app.name)}</a> — velg variabler, se og last ned tallene.</p>`);
  if (entry.crumbPage) {
    const crumbDir = entry.crumbPage.canonicalDir || entry.crumbPage.dir;
    parts.push(`<p><a href="/${escapeAttr(crumbDir)}/">Flere tabeller om ${escapeHtml(entry.crumbPage.label.toLowerCase())}</a></p>`);
  }

  return parts.join('\n      ');
}

/** Dataset (med katalog-kobling) + BreadcrumbList for en tabellside. */
function buildTableJsonLd(entry, site, appConfig) {
  const url = `${site}/table/${entry.id}/`;
  const graph = [];

  graph.push({
    ...datasetJsonLd(entry.table, site, appConfig),
    includedInDataCatalog: { '@type': 'DataCatalog', name: appConfig.app.name, url: `${site}/` },
  });

  const crumbItems = [{ name: appConfig.app.name, item: `${site}/` }];
  if (entry.crumbPage) {
    for (const c of entry.crumbPage.breadcrumbs) {
      crumbItems.push({ name: c.label, item: `${site}/${c.dir}/` });
    }
    const crumbDir = entry.crumbPage.canonicalDir || entry.crumbPage.dir;
    crumbItems.push({ name: entry.crumbPage.label, item: `${site}/${crumbDir}/` });
  }
  crumbItems.push({ name: cleanLabel(entry.table.label), item: url });
  graph.push({
    '@type': 'BreadcrumbList',
    itemListElement: crumbItems.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.item,
    })),
  });

  return { '@context': 'https://schema.org', '@graph': graph };
}

/** Som renderPage(), men for en tabellside (samme mal, samme ankere). */
function renderTablePage(template, entry, site, appConfig) {
  const t = entry.table;
  const url = `${site}/table/${entry.id}/`;
  const title = `${cleanLabel(t.label)} – ${appConfig.app.name}`;
  const description = buildTableDescription(t, appConfig);

  let html = template;

  html = mustReplace(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`, '<title>');
  html = mustReplace(
    html,
    /<meta name="description" content="[^"]*" id="meta-description">/,
    `<meta name="description" content="${escapeAttr(description)}" id="meta-description">`,
    'meta description'
  );
  html = mustReplace(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeAttr(url)}">`, 'canonical');
  html = mustReplace(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeAttr(title)}">`, 'og:title');
  html = mustReplace(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(description)}">`, 'og:description');
  html = mustReplace(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeAttr(url)}">`, 'og:url');

  // Relative asset-stier → absolutte (sidene ligger under /table/{id}/)
  html = html.replace(/href="css\//g, 'href="/css/').replace(/src="js\//g, 'src="/js/');

  const jsonLd = JSON.stringify(buildTableJsonLd(entry, site, appConfig)).replace(/</g, '\\u003c');
  html = mustReplace(
    html,
    /<\/head>/,
    `  <script type="application/ld+json" id="seo-jsonld">${jsonLd}</script>\n</head>`,
    '</head> (JSON-LD)'
  );

  html = mustReplace(
    html,
    /(<script src="\/js\/version\.js")/,
    `<script>window.__SEO_TABLE_ID__=${JSON.stringify(entry.id)};</script>\n  $1`,
    'script-injeksjon (js/version.js)'
  );

  matchContentDiv(html);
  html = html.replace(CONTENT_DIV_RE, `$1\n      ${buildTableContentHtml(entry, appConfig)}\n    $3`);

  return html;
}

// ---------------------------------------------------------------------------
// Forsiden (index.html): statisk crawlbart innhold + WebSite JSON-LD
// ---------------------------------------------------------------------------

function formatCount(n) {
  return n.toLocaleString('nb-NO');
}

/** Søkefeltets placeholder fra js/translations.js (standardspråket), med fallback. */
function loadSearchPlaceholder(appConfig) {
  const FALLBACK = 'Søk etter tabell (ID, tittel, variabler...)';
  try {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'js', 'translations.js'), 'utf8');
    const sandbox = {
      window: {},
      localStorage: { getItem: () => null, setItem: () => {} },
      navigator: { language: 'nb' },
    };
    vm.runInNewContext(`${src}\n;window.__translations = translations;`, sandbox);
    return sandbox.window.__translations?.[appConfig.defaultLanguage || 'nb']?.['search.placeholder'] || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

/**
 * Statisk forside-innhold som speiler appens egen forside (js/front-page.js):
 * søkefelt + emnegrid med samme CSS-klasser og tekster, slik at overgangen til
 * den dynamiske visningen knapt synes (visningen beholder dette som
 * plassholder under lastingen — se seoContentMatchesRoute i js/utils.js).
 * SEO-teksten (totaltall, emnefordeling med lenker til gruppesidene) ligger i
 * en egen seksjon under gridet, der appens «Nylig oppdaterte» senere vises.
 */
function buildRootContentHtml(pages, totalTables, appConfig) {
  const sourceName = appConfig.source.nameFull || appConfig.source.name;
  const groups = pages.filter(p => p.isGroup);
  const parts = [];
  parts.push('<div class="front-page">');
  parts.push(`<div class="front-search-container"><input type="text" id="front-search" placeholder="${escapeAttr(loadSearchPlaceholder(appConfig))}" class="search-input front-search-input" /></div>`);
  parts.push('<div class="subject-grid">');
  for (const group of groups) {
    const items = group.children.map(c =>
      `<li><a href="/${escapeAttr(c.dir)}/" class="front-subject-link">${escapeHtml(c.label)}</a></li>`
    );
    parts.push(`<div class="subject-group-column">
        <h3 class="subject-group-column-header">${escapeHtml(group.label)}</h3>
        <ul class="subject-list">${items.join('\n')}</ul>
      </div>`);
  }
  parts.push('</div>');
  const distribution = groups.map(g =>
    `<a href="/${escapeAttr(g.dir)}/">${escapeHtml(g.label)}</a> (${formatCount(g.totalCount)} tabeller)`
  ).join(', ');
  parts.push(`<section class="front-seo-intro">
        <p>Utforsk ${formatCount(totalTables)} statistikktabeller fra ${escapeHtml(sourceName)} — søk, filtrer og last ned tall, gratis og uten innlogging.</p>
        <p>Tabellene fordeler seg på ${distribution}. Mange tabeller hører til flere emner.</p>
      </section>`);
  parts.push('</div>');
  return parts.join('\n      ');
}

/**
 * Forsiden beholder appens relative asset-stier, men får emnerik tittel og
 * beskrivelse, statisk emneoversikt i #content (med base64-bevart original,
 * se stripRootInjection), WebSite JSON-LD og canonical/og:url satt til --site.
 * window.__SEO_TOPIC_PATH__=[] markerer siden som pre-rendret, slik at
 * init-koden i index.html lar tittel og meta-description stå.
 */
function renderRootPage(template, site, appConfig, pages, totalTables) {
  const match = matchContentDiv(template);
  const orig = Buffer.from(match[2], 'utf8').toString('base64');
  const inner = `<!-- seo-root:start orig="${orig}" -->\n      ${buildRootContentHtml(pages, totalTables, appConfig)}\n      <!-- seo-root:end -->`;
  let html = template.replace(CONTENT_DIV_RE, () => `${match[1]}\n      ${inner}\n    ${match[3]}`);

  const sourceName = appConfig.source.nameFull || appConfig.source.name;
  const title = `${appConfig.app.name} – utforsk statistikk fra ${appConfig.source.name}`;
  const description = `Søk i ${formatCount(totalTables)} statistikktabeller fra ${sourceName}. Statistikkportalen gir deg bedre tilgang til dataene i SSBs statistikkbank. Utforsk, filtrer og last ned tall.`;

  html = mustReplace(html, /<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`, '<title> (forside)');
  html = mustReplace(
    html,
    /<meta name="description" content="[^"]*" id="meta-description">/,
    `<meta name="description" content="${escapeAttr(description)}" id="meta-description">`,
    'meta description (forside)'
  );
  html = mustReplace(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeAttr(site)}/">`, 'canonical (forside)');
  html = mustReplace(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeAttr(title)}">`, 'og:title (forside)');
  html = mustReplace(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(description)}">`, 'og:description (forside)');
  html = mustReplace(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeAttr(site)}/">`, 'og:url (forside)');
  html = mustReplace(
    html,
    /(<script src="js\/version\.js")/,
    `<script>window.__SEO_TOPIC_PATH__=[];</script>\n  $1`,
    'script-injeksjon (forside, js/version.js)'
  );

  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: appConfig.app.name,
    url: `${site}/`,
    description,
    publisher: { '@type': 'Organization', name: appConfig.app.name, url: `${site}/` },
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${site}/#search?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  }).replace(/</g, '\\u003c');
  html = mustReplace(
    html,
    /<\/head>/,
    `  <script type="application/ld+json" id="seo-root-jsonld">${jsonLd}</script>\n</head>`,
    '</head> (JSON-LD forside)'
  );

  return html;
}

// ---------------------------------------------------------------------------
// sitemap.xml / robots.txt
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildSitemap(pages, tableEntries, site) {
  const newest = pages.reduce((max, p) =>
    (p.lastUpdated && (!max || p.lastUpdated > max)) ? p.lastUpdated : max, null);
  const entries = [{ loc: `${site}/`, lastmod: newest ? String(newest).slice(0, 10) : null }];
  // Kun kanoniske URL-er i sitemap — duplikater canonicaliserer mot en annen URL
  for (const page of pages.filter(p => p.dir === (p.canonicalDir || p.dir))) {
    entries.push({
      loc: `${site}/${page.dir}/`,
      lastmod: page.lastUpdated ? String(page.lastUpdated).slice(0, 10) : null,
    });
  }
  for (const entry of tableEntries) {
    entries.push({
      loc: `${site}/${entry.dir}/`,
      lastmod: entry.table.updated ? String(entry.table.updated).slice(0, 10) : null,
    });
  }
  if (entries.length >= 50000) {
    throw new Error(`sitemap.xml ville fått ${entries.length} URL-er (grensen er 50 000) — del opp i sitemap-indeks.`);
  }
  const urls = entries.map(e => {
    const lastmod = e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : '';
    return `  <url>\n    <loc>${escapeXml(e.loc)}</loc>${lastmod}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function buildRobots(site) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`;
}

/**
 * seo-map.json: rute → kanonisk URL-oppslag for appens head-sync
 * (js/seo-head.js). topics: hash-sti → pen mappe (duplikater løses til den
 * primære). tables: id-ene som faktisk har /table/{id}/-sider, så appen
 * aldri setter canonical mot en side som ikke finnes.
 */
function buildSeoMap(pages, tableEntries, site) {
  const topics = {};
  for (const page of pages) {
    topics[page.hashPath.join('/')] = page.canonicalDir || page.dir;
  }
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    site,
    topics,
    tables: tableEntries.map(e => e.id).sort(),
  });
}

// ---------------------------------------------------------------------------
// Skriving og opprydding (kun manifest-eide slettinger)
// ---------------------------------------------------------------------------

const MANIFEST_NAME = '.seo-manifest.json';

function loadManifest(webroot) {
  const p = path.join(webroot, MANIFEST_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.warn('[SEO] Klarte ikke å lese eksisterende manifest — hopper over opprydding.');
    return null;
  }
}

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function main_write(webroot, site, appConfig, pages, tableEntries, totalTables, oldManifest, dryRun) {
  const newDirs = [...pages.map(p => p.dir), ...tableEntries.map(e => e.dir)].sort();
  const sitemap = buildSitemap(pages, tableEntries, site);
  const seoMap = buildSeoMap(pages, tableEntries, site);

  // robots.txt: skriv kun hvis fraværende eller eid av dette scriptet
  const robotsPath = path.join(webroot, 'robots.txt');
  const robotsOwned = !fs.existsSync(robotsPath) || (oldManifest?.files || []).includes('robots.txt');
  const newFiles = ['sitemap.xml', 'seo-map.json'];
  if (robotsOwned) newFiles.push('robots.txt');
  else console.warn(`[SEO] robots.txt finnes fra før og eies ikke av scriptet — legg til "Sitemap: ${site}/sitemap.xml" manuelt.`);

  // Slettekandidater: mapper fra forrige kjøring som ikke lenger genereres
  const oldDirs = oldManifest?.dirs || [];
  const newDirSet = new Set(newDirs);
  const staleDirs = oldDirs.filter(d => !newDirSet.has(d));

  if (dryRun) {
    const listCap = 20;
    console.log(`\n[SEO] DRY RUN — ingen filer skrives.`);
    console.log(`[SEO] Ville skrevet forside-innhold i index.html + ${pages.length} emnesider + ${tableEntries.length} tabellsider + sitemap.xml + seo-map.json${robotsOwned ? ' + robots.txt' : ''}.`);
    for (const d of newDirs.slice(0, listCap)) console.log(`  /${d}/`);
    if (newDirs.length > listCap) console.log(`  … og ${newDirs.length - listCap} til`);
    if (staleDirs.length) {
      console.log(`[SEO] Ville slettet ${staleDirs.length} utdaterte mapper:`);
      for (const d of staleDirs.slice(0, listCap)) console.log(`  /${d}/`);
      if (staleDirs.length > listCap) console.log(`  … og ${staleDirs.length - listCap} til`);
    }
    const template = loadTemplate(webroot);
    const sample = pages.find(p => (p.sections || []).length > 0) || pages[pages.length - 1];
    console.log(`\n[SEO] Eksempel-emneside (/${sample.dir}/):\n`);
    console.log(renderPage(template, sample, site, appConfig));
    const tableSample = tableEntries.find(e => e.crumbPage && (e.table.variableNames || []).length > 0) || tableEntries[0];
    if (tableSample) {
      console.log(`\n[SEO] Eksempel-tabellside (/${tableSample.dir}/):\n`);
      console.log(renderTablePage(template, tableSample, site, appConfig));
    }
    return;
  }

  // 1) Skriv alle nye sider + statisk forside-innhold i index.html
  const template = loadTemplate(webroot);
  for (const page of pages) {
    const dirPath = path.join(webroot, page.dir);
    fs.mkdirSync(dirPath, { recursive: true });
    atomicWrite(path.join(dirPath, 'index.html'), renderPage(template, page, site, appConfig));
  }
  for (const entry of tableEntries) {
    const dirPath = path.join(webroot, entry.dir);
    fs.mkdirSync(dirPath, { recursive: true });
    atomicWrite(path.join(dirPath, 'index.html'), renderTablePage(template, entry, site, appConfig));
  }
  atomicWrite(path.join(webroot, 'index.html'), renderRootPage(template, site, appConfig, pages, totalTables));
  console.log(`[SEO] Skrev ${pages.length} emnesider + ${tableEntries.length} tabellsider + forside-innhold i index.html.`);

  // 2) sitemap + seo-map + robots
  atomicWrite(path.join(webroot, 'sitemap.xml'), sitemap);
  atomicWrite(path.join(webroot, 'seo-map.json'), seoMap);
  if (robotsOwned) atomicWrite(robotsPath, buildRobots(site));

  // 3) Rydd opp utdaterte mapper (kun index.html + tomme mapper, aldri rekursivt)
  for (const dir of staleDirs.sort((a, b) => b.split('/').length - a.split('/').length)) {
    const indexPath = path.join(webroot, dir, 'index.html');
    try { fs.unlinkSync(indexPath); } catch { /* allerede borte */ }
    try { fs.rmdirSync(path.join(webroot, dir)); } catch { /* ikke tom — rører den ikke */ }
  }
  if (staleDirs.length) console.log(`[SEO] Ryddet ${staleDirs.length} utdaterte mapper.`);

  // 4) Manifest sist
  atomicWrite(path.join(webroot, MANIFEST_NAME), JSON.stringify({
    generatedAt: new Date().toISOString(),
    site,
    dirs: newDirs,
    files: newFiles,
  }, null, 2));
  console.log(`[SEO] Ferdig: ${pages.length} emnesider, ${tableEntries.length} tabellsider, sitemap.xml, seo-map.json${robotsOwned ? ', robots.txt' : ''}.`);
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  // Verifiser malen tidlig så vi feiler før API-kallene
  loadTemplate(args.webroot);

  const appConfig = loadAppConfig();
  const subjectConfig = loadSubjectConfig(appConfig);
  console.log(`[SEO] API: ${appConfig.apiBaseUrl} (${appConfig.app.name})`);

  const tables = await fetchAllTables(appConfig, args.minTables);
  const hierarchy = buildHierarchy(tables);
  const cardDepth = appConfig.ui?.topicCardDepth ?? 2; // samme terskel som topic-view.js
  const pages = assignCanonicals(buildPages(subjectConfig, hierarchy, cardDepth));
  const tableEntries = buildTableEntries(tables, pages);
  const totalTables = new Set(tables.map(t => t.id)).size;
  console.log(`[SEO] Bygde ${pages.length} emnesider + ${tableEntries.length} tabellsider fra ${tables.length} tabeller (kort-dybde ${cardDepth}).`);

  const oldManifest = loadManifest(args.webroot);
  main_write(args.webroot, args.site, appConfig, pages, tableEntries, totalTables, oldManifest, args.dryRun);
}

main().catch(err => {
  console.error(`[SEO] FEIL: ${err.message}`);
  process.exit(1);
});
