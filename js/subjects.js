/**
 * Emnekonfigurasjon for SSBs statistikkbank
 *
 * subjectGroups: Toppnivågruppering av emner (vises som fliser på forsiden).
 *   Hver gruppe har en id, en flerspråklig label og en liste med emne-koder
 *   (subjects). label er et objekt med én oversettelse per UI-språk
 *   (nb/en/sv ...), der nøklene matcher språkkodene i AppConfig.languages.
 *
 * subjectNames: Emne-kode til flerspråklig visningsnavn (samme {språk: tekst}-
 *   struktur som group.label).
 *
 * Alle menytekster (gruppe- og emnenavn) bor i DENNE filen — ikke i
 * translations.js. Ved oppstart registreres de i den delte
 * oversettelsesordboka under nøklene `subject.group.{id}` og
 * `subject.name.{kode}`, slik at t() løser dem på vanlig måte. Målet er at kun
 * subjects.js og config.js trenger endring for å sette opp en ny instans.
 *
 * For en annen instans (f.eks. SCB): bytt ut denne filen med tilsvarende
 * struktur for den aktuelle statistikkbanken.
 *
 * NB: scripts/generate-seo-pages.mjs leser også denne filen (via node:vm)
 * for å generere statiske SEO-sider — hold strukturen kompatibel. Der kjøres
 * filen uten translations.js, så registreringen nedenfor hoppes over (guard
 * på `typeof translations`) og labelene leses som objekter direkte.
 */
const SubjectConfig = {
  subjectGroups: {
    'arbeid': {
      id: 'arbeid',
      label: {
        nb: 'Arbeid, lønn og utdanning',
        en: 'Work, wages and education',
        sv: 'Arbete, lön och utbildning'
      },
      subjects: ['al', 'if', 'ud']
    },
    'befolkning': {
      id: 'befolkning',
      label: {
        nb: 'Befolkning og bolig',
        en: 'Population and housing',
        sv: 'Befolkning och bostad'
      },
      subjects: ['be', 'bb', 'in']
    },
    'helse': {
      id: 'helse',
      label: {
        nb: 'Helse og samfunn',
        en: 'Health and society',
        sv: 'Hälsa och samhälle'
      },
      subjects: ['he', 'kf', 'sk', 'sv', 'va']
    },
    'miljo': {
      id: 'miljo',
      label: {
        nb: 'Miljø og transport',
        en: 'Environment and transport',
        sv: 'Miljö och transport'
      },
      subjects: ['nm', 'tr']
    },
    'naring': {
      id: 'naring',
      label: {
        nb: 'Næringsliv og teknologi',
        en: 'Business and technology',
        sv: 'Näringsliv och teknologi'
      },
      subjects: ['ei', 'js', 'ti', 'vt', 'vf']
    },
    'okonomi': {
      id: 'okonomi',
      label: {
        nb: 'Økonomi',
        en: 'Economy',
        sv: 'Ekonomi'
      },
      subjects: ['bf', 'nk', 'os', 'pp', 'ut']
    }
  },

  subjectNames: {
    'al': { nb: 'Arbeid og lønn',                    en: 'Work and wages',                        sv: 'Arbete och lön' },
    'if': { nb: 'Inntekt og forbruk',                en: 'Income and consumption',                sv: 'Inkomst och konsumtion' },
    'ud': { nb: 'Utdanning',                         en: 'Education',                             sv: 'Utbildning' },
    'be': { nb: 'Befolkning',                        en: 'Population',                            sv: 'Befolkning' },
    'bb': { nb: 'Bygg, bolig og eiendom',            en: 'Building, housing and real estate',     sv: 'Bygg, bostad och fastighet' },
    'in': { nb: 'Innvandring og innvandrere',        en: 'Immigration and immigrants',            sv: 'Invandring och invandrare' },
    'he': { nb: 'Helse',                             en: 'Health',                               sv: 'Hälsa' },
    'kf': { nb: 'Kultur og fritid',                  en: 'Culture and leisure',                   sv: 'Kultur och fritid' },
    'sk': { nb: 'Sosiale forhold og kriminalitet',   en: 'Social conditions and crime',           sv: 'Sociala förhållanden och brottslighet' },
    'sv': { nb: 'Svalbard',                          en: 'Svalbard',                             sv: 'Svalbard' },
    'va': { nb: 'Valg',                              en: 'Elections',                            sv: 'Val' },
    'nm': { nb: 'Natur og miljø',                    en: 'Nature and environment',                sv: 'Natur och miljö' },
    'tr': { nb: 'Transport og reiseliv',             en: 'Transport and tourism',                 sv: 'Transport och turism' },
    'ei': { nb: 'Energi og industri',                en: 'Energy and industry',                   sv: 'Energi och industri' },
    'js': { nb: 'Jord, skog, jakt og fiskeri',       en: 'Land, forest, hunting and fishing',     sv: 'Jord, skog, jakt och fiske' },
    'ti': { nb: 'Teknologi og innovasjon',           en: 'Technology and innovation',             sv: 'Teknologi och innovation' },
    'vt': { nb: 'Varehandel og tjenesteyting',       en: 'Retail and services',                   sv: 'Varuhandel och tjänster' },
    'vf': { nb: 'Bedrifter, foretak og regnskap',    en: 'Enterprises, companies and accounting', sv: 'Företag och bokföring' },
    'bf': { nb: 'Bank og finansmarked',              en: 'Banking and financial markets',         sv: 'Bank och finansmarknad' },
    'nk': { nb: 'Nasjonalregnskap og konjunkturer',  en: 'National accounts and business cycles', sv: 'Nationalräkenskaper och konjunktur' },
    'os': { nb: 'Offentlig sektor',                  en: 'Public sector',                         sv: 'Offentlig sektor' },
    'pp': { nb: 'Priser og prisindekser',            en: 'Prices and price indices',              sv: 'Priser och prisindex' },
    'ut': { nb: 'Utenriksøkonomi',                   en: 'External economy',                       sv: 'Utrikeshandel' }
  }
};

// Registrer menytekstene i den delte oversettelsesordboka (translations.js),
// slik at t('subject.group.{id}') og t('subject.name.{kode}') fungerer.
// Hoppes over når filen kjøres uten translations (f.eks. i SEO-generatorens
// node:vm-sandkasse), der labelene leses som objekter direkte.
if (typeof translations !== 'undefined') {
  const register = (key, byLang) => {
    for (const [lang, text] of Object.entries(byLang)) {
      (translations[lang] || (translations[lang] = {}))[key] = text;
    }
  };
  for (const [id, group] of Object.entries(SubjectConfig.subjectGroups)) {
    register('subject.group.' + id, group.label);
  }
  for (const [code, names] of Object.entries(SubjectConfig.subjectNames)) {
    register('subject.name.' + code, names);
  }
}

window.SubjectConfig = SubjectConfig;
