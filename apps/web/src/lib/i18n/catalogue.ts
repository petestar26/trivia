import type { TranslationCatalog } from './types';
import { mergeCatalogues } from './validation';
export { mergeCatalogues, validateCatalogue } from './validation';
const modules = import.meta.glob<{ default: TranslationCatalog }>('./catalogues/*.ts', {
  eager: true,
});
export const catalogue = mergeCatalogues(
  Object.fromEntries(Object.entries(modules).map(([path, value]) => [path, value.default]))
);
