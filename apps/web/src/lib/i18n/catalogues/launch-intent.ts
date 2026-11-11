import type { TranslationCatalog } from '../types';

// Shown when a launching page was reached without a fresh click (pasted link,
// bookmark, reload, Back or sign-in). Quoted labels match the existing
// translations of "Play". Authored for this change; native review pending.
export default {
  'The sportsbook opens only when you choose it.': {
    am: 'የስፖርት ውርርድ ገጹ የሚከፈተው እርስዎ ሲመርጡ ብቻ ነው።',
    om: 'Fuulli sharafa ispoortii kan banamu yoo ati filatte qofa.',
    ti: 'ናይ ስፖርት ውርርድ ገጽ ዝኽፈት ንስኻ ምስ እትመርጽ ጥራይ እዩ።',
    so: 'Bogga sharadka isboortiga wuxuu furmaa oo keliya marka aad doorato.',
    ar: 'لا يُفتح موقع المراهنات الرياضية إلا عندما تختار ذلك.',
    sw: 'Ukurasa wa kubashiri michezo hufunguka tu unapouchagua.',
    fr: 'Le site de paris sportifs ne s’ouvre que lorsque vous le choisissez.',
  },
  'Nothing starts until you choose Play.': {
    am: '«ተጫወት»ን እስኪመርጡ ድረስ ምንም ነገር አይጀምርም።',
    om: 'Hamma «Taphadhu» filattutti homtuu hin jalqabu.',
    ti: '«ተጻወት» ክሳብ እትመርጽ ዋላ ሓንቲ ኣይጅምርን።',
    so: 'Waxba ma bilaabmayaan ilaa aad doorato «Ciyaar».',
    ar: 'لن يبدأ أي شيء حتى تختار «العب».',
    sw: 'Hakuna kitakachoanza hadi uchague «Cheza».',
    fr: 'Rien ne démarre tant que vous ne choisissez pas « Jouer ».',
  },
} satisfies TranslationCatalog;
