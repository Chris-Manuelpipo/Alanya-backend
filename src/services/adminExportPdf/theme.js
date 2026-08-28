/** Palette alignée sur l'admin Alanya (indigo + or officiel). */
const BRAND = {
  primary: '#6366F1',
  primaryDark: '#4F46E5',
  primarySoft: '#818CF8',
  onPrimary: '#FFFFFF',
  onPrimaryMuted: '#C7D2FE',
  gold: '#C9A227',
  goldLight: '#F5EDD4',
  ink: '#0F172A',
  inkMuted: '#64748B',
  inkLight: '#94A3B8',
  surface: '#FFFFFF',
  surfaceAlt: '#F8FAFC',
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',
  headerText: '#FFFFFF',
  danger: '#DC2626',
  success: '#16A34A',
};

const LAYOUT = {
  margin: 48,
  pageW: 595.28,
  pageH: 841.89,
  /** Hauteur plancher du bandeau de garde ; il s'étire selon le titre. */
  coverBandMinH: 268,
  contentHeaderH: 52,
  footerH: 32,
  tableHeaderH: 24,
  tableRowH: 22,
  radius: 6,
};

LAYOUT.contentW = LAYOUT.pageW - LAYOUT.margin * 2;

const ROLE_LABELS = { 0: 'Utilisateur', 1: 'Admin', 2: 'Super Admin' };
const ACCOUNT_LABELS = { 0: 'Personnel', 1: 'Business', 2: 'Officiel' };

module.exports = {
  BRAND,
  LAYOUT,
  ROLE_LABELS,
  ACCOUNT_LABELS,
};
