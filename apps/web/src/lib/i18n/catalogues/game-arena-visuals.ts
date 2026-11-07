import type { TranslationCatalog } from '../types';
const tr = (
  am: string,
  om: string,
  ti: string,
  so: string,
  ar: string,
  sw: string,
  fr: string
) => ({ am, om, ti, so, ar, sw, fr });
export default {
  'Graphics quality': tr(
    'የምስል ጥራት',
    'Qulqullina suuraa',
    'ጽሬት ስእሊ',
    'Tayada muuqaalka',
    'جودة الرسومات',
    'Ubora wa picha',
    'Qualité graphique'
  ),
  Balanced: tr('የተመጣጠነ', 'Madaalawaa', 'ማእከላይ', 'Dheellitiran', 'متوازنة', 'Wastani', 'Équilibrée'),
  'Group chat': tr(
    'የቡድን ውይይት',
    'Haasawa garee',
    'ዘተ ጉጅለ',
    'Wada sheekaysiga kooxda',
    'دردشة المجموعة',
    'Mazungumzo ya kikundi',
    'Discussion du groupe'
  ),
  'Ball {number}': tr(
    'ኳስ {number}',
    'Kubbaa {number}',
    'ኩዕሶ {number}',
    'Kubbad {number}',
    'الكرة {number}',
    'Mpira {number}',
    'Boule {number}'
  ),
} satisfies TranslationCatalog;
