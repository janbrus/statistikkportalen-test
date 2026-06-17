/**
 * Emnekonfigurasjon for SCBs statistikkbank
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
    'befolkning': {
      id: 'befolkning',
      label: {
        sv: 'Befolkning och boende',
        en: 'Population and housing'
      },
      subjects: ['BE', 'BO']
    },
    'samfunn': {
      id: 'samfunn',
      label: {
        sv: 'Hälsa och samhälle',
        en: 'Health and society'
      },
      subjects: ['ME', 'HS', 'KU', 'LE', 'SO', 'AA']
    },
    'miljo': {
      id: 'miljo',
      label: {
        sv: 'Miljö och transport',
        en: 'Environment and transportation'
      },
      subjects: ['MI', 'TK']
    },
    'naringsliv': {
      id: 'naringsliv',
      label: {
        sv: 'Näringsliv och teknologi',
        en: 'Business and technology',
      },
      subjects: ['JO', 'HA', 'NV', 'EN', 'UF']
    },
    'ekonomi': {
      id: 'ekonomi',
      label: {
        sv: 'Ekonomi',
        en: 'Economy',
      },
      subjects: ['AM', 'FM', 'HE', 'OE', 'NR', 'PR']
    }
  },

  subjectNames: {
    'AM': { sv: 'Arbetsmarknad',                       en: 'Labour market' },
    'BE': { sv: 'Befolkning',                          en: 'Population' },
    'BO': { sv: 'Boende, byggande och bebyggelse',     en: 'Housing, construction and building' },
    'ME': { sv: 'Demokrati',                           en: 'Democracy' },
    'EN': { sv: 'Energi',                              en: 'Energy' },
    'FM': { sv: 'Finansmarknad',                       en: 'Financial markets' },
    'HA': { sv: 'Handel med varor och tjänster',       en: 'Trade in goods and services' },
    'HE': { sv: 'Hushållens ekonomi',                  en: 'Household finances' },
    'HS': { sv: 'Hälso- och sjukvård',                 en: 'Health' },
    'JO': { sv: 'Jord- och skogsbruk, fiske',          en: 'Agriculture, forestry and fishery' },
    'KU': { sv: 'Kultur och fritid',                   en: 'Culture and leisure' },
    'LE': { sv: 'Levnadsförhållanden',                 en: 'Living conditions' },
    'MI': { sv: 'Miljö',                               en: 'Environment' },
    'NR': { sv: 'Nationalräkenskaper',                 en: 'National accounts' },
    'NV': { sv: 'Näringsverksamhet',                   en: 'Business activities' },
    'OE': { sv: 'Offentlig ekonomi',                   en: 'Public finances' },
    'PR': { sv: 'Priser och konsumtion',               en: 'Prices and Consumption' },
    'SO': { sv: 'Socialtjänst',                        en: 'Social services' },
    'TK': { sv: 'Transporter och kommunikationer',     en: 'Transport and communications' },
    'UF': { sv: 'Utbildning och forskning',            en: 'Education and research' },
    'AA': { sv: 'Ämnesövergripande statistik',         en: 'General statistics' }
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
