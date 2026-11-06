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
  '3D view': tr(
    'የ3D እይታ',
    'Mulʼata 3D',
    'ናይ 3D ትርኢት',
    'Muuqaalka 3D',
    'عرض ثلاثي الأبعاد',
    'Mwonekano wa 3D',
    'Vue 3D'
  ),
  'Simple view': tr(
    'ቀላል እይታ',
    'Mulʼata salphaa',
    'ቀሊል ትርኢት',
    'Muuqaal fudud',
    'عرض مبسط',
    'Mwonekano rahisi',
    'Vue simplifiée'
  ),
  'Drawn balls': tr(
    'የወጡ ኳሶች',
    'Kubbaawwan baʼan',
    'ዝወጹ ኩዕሶታት',
    'Kubadaha la soo saaray',
    'الكرات المسحوبة',
    'Mipira iliyotolewa',
    'Boules tirées'
  ),
  'Flight in progress · targets are locked': tr(
    'በረራው ቀጥሏል · ግቦች ተቆልፈዋል',
    'Balaliin itti fufeera · galmoonni cufamaniiru',
    'በረራ ይቕጽል ኣሎ · ዕላማታት ተዓጽዮም',
    'Duulimaadku wuu socdaa · bartilmaameedyadu way xiran yihiin',
    'الطيران جارٍ · الأهداف مقفلة',
    'Ndege inaendelea · malengo yamefungwa',
    'Vol en cours · objectifs verrouillés'
  ),
  'Game finished—confirming payout': tr(
    'ጨዋታው ተጠናቋል—ክፍያው እየተረጋገጠ ነው',
    'Taphni xumurameera—kaffaltiin mirkanaaʼaa jira',
    'ጸወታ ተወዲኡ—ክፍሊት ይረጋገጽ ኣሎ',
    'Ciyaartu way dhammaatay—lacag bixinta ayaa la xaqiijinayaa',
    'انتهت اللعبة—جارٍ تأكيد الصرف',
    'Mchezo umekwisha—malipo yanathibitishwa',
    'Partie terminée—versement en cours de confirmation'
  ),
  'Hide game': tr(
    'ጨዋታውን ደብቅ',
    'Tapha dhoksi',
    'ጸወታ ሕባእ',
    'Qari ciyaarta',
    'إخفاء اللعبة',
    'Ficha mchezo',
    'Masquer le jeu'
  ),
  'Live game': tr(
    'ቀጥታ ጨዋታ',
    'Tapha kallattii',
    'ቀጥታ ጸወታ',
    'Ciyaar toos ah',
    'اللعبة المباشرة',
    'Mchezo wa moja kwa moja',
    'Partie en direct'
  ),
  'Official result': tr(
    'ይፋዊ ውጤት',
    'Buʼaa mirkanaaʼe',
    'ወግዓዊ ውጽኢት',
    'Natiijada rasmiga ah',
    'النتيجة الرسمية',
    'Matokeo rasmi',
    'Résultat officiel'
  ),
  'Open full round': tr(
    'ሙሉ ዙሩን ክፈት',
    'Marsaa guutuu bani',
    'ምሉእ ዙር ክፈት',
    'Fur wareegga oo dhan',
    'فتح الجولة كاملة',
    'Fungua raundi kamili',
    'Ouvrir la partie complète'
  ),
  'Preparing the round': tr(
    'ዙሩ እየተዘጋጀ ነው',
    'Marsaan qophaaʼaa jira',
    'ዙር ይዳሎ ኣሎ',
    'Wareegga ayaa la diyaarinayaa',
    'جارٍ تجهيز الجولة',
    'Raundi inaandaliwa',
    'Préparation de la partie'
  ),
  'Race progress': tr(
    'የውድድሩ ሂደት',
    'Adeemsa fiigichaa',
    'መስርሕ ቅድድም',
    'Horumarka tartanka',
    'تقدم السباق',
    'Maendeleo ya mbio',
    'Progression de la course'
  ),
  'Reconnecting to the shared game…': tr(
    'ከጋራ ጨዋታው ጋር እንደገና እየተገናኘ ነው…',
    'Tapha waliinitti irra deebiʼee walqunnamaa jira…',
    'ምስ ናይ ሓባር ጸወታ እንደገና ይራኸብ ኣሎ…',
    'Ciyaarta wadajirka ah dib ayaa loogu xirmayaa…',
    'جارٍ إعادة الاتصال باللعبة المشتركة…',
    'Inaunganisha tena kwenye mchezo wa pamoja…',
    'Reconnexion à la partie commune…'
  ),
  'Shared game progress': tr(
    'የጋራ ጨዋታ ሂደት',
    'Adeemsa tapha waliin',
    'መስርሕ ናይ ሓባር ጸወታ',
    'Horumarka ciyaarta wadajirka ah',
    'تقدم اللعبة المشتركة',
    'Maendeleo ya mchezo wa pamoja',
    'Progression de la partie commune'
  ),
  'Starting in {count}': tr(
    'በ{count} ይጀምራል',
    '{count} keessatti jalqaba',
    'ድሕሪ {count} ይጅምር',
    'Waxay bilaabanaysaa {count}',
    'تبدأ خلال {count}',
    'Inaanza baada ya {count}',
    'Début dans {count}'
  ),
  'Verify outcome': tr(
    'ውጤቱን አረጋግጥ',
    'Buʼaa mirkaneessi',
    'ውጽኢት ኣረጋግጽ',
    'Xaqiiji natiijada',
    'التحقق من النتيجة',
    'Thibitisha matokeo',
    'Vérifier le résultat'
  ),
  'Watch live': tr(
    'በቀጥታ ይመልከቱ',
    'Kallattiin ilaali',
    'ብቐጥታ ተዓዘብ',
    'Toos u daawo',
    'مشاهدة مباشرة',
    'Tazama moja kwa moja',
    'Regarder en direct'
  ),
  Watching: tr(
    'በመመልከት ላይ',
    'Ilaalaa jira',
    'ይዕዘብ ኣሎ',
    'Daawanaya',
    'مشاهدة',
    'Unatazama',
    'Spectateur'
  ),
  Confirming: tr(
    'እየተረጋገጠ ነው',
    'Mirkanaaʼaa jira',
    'ይረጋገጽ ኣሎ',
    'La xaqiijinayo',
    'جارٍ التأكيد',
    'Inathibitishwa',
    'Confirmation en cours'
  ),
  'Watching is free': tr(
    'መመልከት ነፃ ነው',
    'Ilaaluun bilisa',
    'ምዕዛብ ነጻ እዩ',
    'Daawashadu waa bilaash',
    'المشاهدة مجانية',
    'Kutazama ni bure',
    'Regarder est gratuit'
  ),
  seconds: tr('ሰከንዶች', 'sekondii', 'ካልኢታት', 'ilbiriqsi', 'ثوانٍ', 'sekunde', 'secondes'),
  '{count} confirmed': tr(
    '{count} ተረጋግጠዋል',
    '{count} mirkanaaʼan',
    '{count} ተረጋጊጾም',
    '{count} la xaqiijiyay',
    'تم تأكيد {count}',
    '{count} wamethibitishwa',
    '{count} confirmations'
  ),
  'Game duration: {seconds} seconds': tr(
    'የጨዋታ ጊዜ፦ {seconds} ሰከንዶች',
    'Yeroo taphaa: sekondii {seconds}',
    'ግዜ ጸወታ፦ {seconds} ካልኢታት',
    'Muddada ciyaarta: {seconds} ilbiriqsi',
    'مدة اللعبة: {seconds} ثانية',
    'Muda wa mchezo: sekunde {seconds}',
    'Durée de la partie : {seconds} secondes'
  ),
  'Watching is free. Only confirmed entries participate financially.': tr(
    'መመልከት ነፃ ነው። በገንዘብ የሚሳተፉት የተረጋገጡ ግቤቶች ብቻ ናቸው።',
    'Ilaaluun bilisa. Maallaqaan kan hirmaatan galmeewwan mirkanaaʼan qofa.',
    'ምዕዛብ ነጻ እዩ። ብገንዘብ ዝሳተፉ ዝተረጋገጹ መእተዊታት ጥራይ እዮም።',
    'Daawashadu waa bilaash. Gelitaannada la xaqiijiyay oo keliya ayaa lacag ku tartamaya.',
    'المشاهدة مجانية. المشاركات المؤكدة وحدها تدخل في التسوية المالية.',
    'Kutazama ni bure. Ni maingizo yaliyothibitishwa pekee yanayoshiriki kifedha.',
    'Regarder est gratuit. Seules les participations confirmées engagent des fonds.'
  ),
  'Choose and confirm your own entry, or watch for free. After betting closes, everyone follows one countdown and game. Payment follows the finish.':
    tr(
      'የራስዎን ግቤት ይምረጡና ያረጋግጡ፣ ወይም በነፃ ይመልከቱ። ውርርድ ሲዘጋ ሁሉም አንድ ቆጠራና ጨዋታ ይከተላሉ። ክፍያ ከመጨረሻው በኋላ ይፈጸማል።',
      'Galmee kee filadhuutii mirkaneessi, yookaan bilisaan ilaali. Erga galmeen cufamee booda hunduu lakkoofsa duubatti fi tapha tokko hordofa. Kaffaltiin xumura booda raawwatama.',
      'ናይ ርእስኹም መእተዊ ምረጹን ኣረጋግጹን፣ ወይ ብነጻ ተዓዘቡ። ውርርድ ምስ ተዓጽወ ኩሉ ሓደ ቆጸራን ጸወታን ይከታተል። ክፍሊት ድሕሪ መወዳእታ ይፍጸም።',
      'Dooro oo xaqiiji gelitaankaaga, ama bilaash u daawo. Markay sharaduhu xirmaan, dhammaan waxay raacaan hal tirin iyo hal ciyaar. Lacagta waxaa la bixiyaa dhammaadka ka dib.',
      'اختر مشاركتك وأكدها، أو شاهد مجانًا. بعد إغلاق الرهانات يتابع الجميع عدًا تنازليًا ولعبة واحدة. يتم الصرف بعد النهاية.',
      'Chagua na uthibitishe ingizo lako, au tazama bure. Baada ya kufungwa kwa dau, wote wanafuata hesabu na mchezo mmoja. Malipo hufuata mwisho.',
      'Choisissez et confirmez votre participation, ou regardez gratuitement. À la clôture des mises, tous suivent le même compte à rebours et la même partie. Le versement intervient après la fin.'
    ),
  'Entries are closed. Preparing one verified game for everyone. You can return at any time.': tr(
    'ግቤቶች ተዘግተዋል። ለሁሉም አንድ የተረጋገጠ ጨዋታ እየተዘጋጀ ነው። በማንኛውም ጊዜ መመለስ ይችላሉ።',
    'Galmeewwan cufamaniiru. Tapha mirkanaaʼe tokko hundaaf qopheessaa jirra. Yeroo barbaaddetti deebiʼuu dandeessa.',
    'መእተዊታት ተዓጽዮም። ንኹሉ ሓደ ዝተረጋገጸ ጸወታ ይዳሎ ኣሎ። ኣብ ዝደለኹምዎ ግዜ ክትምለሱ ትኽእሉ።',
    'Gelitaannadu way xirmeen. Hal ciyaar oo la xaqiijiyay ayaa loo diyaarinayaa dhammaan. Waad soo noqon kartaa wakhti kasta.',
    'أُغلقت المشاركات. جارٍ تجهيز لعبة واحدة موثقة للجميع. يمكنك العودة في أي وقت.',
    'Maingizo yamefungwa. Mchezo mmoja uliothibitishwa unaandaliwa kwa wote. Unaweza kurudi wakati wowote.',
    'Les participations sont closes. Une partie vérifiée est en préparation pour tous. Vous pouvez revenir à tout moment.'
  ),
  'The automatic target result is revealed at the finish. There is no live cash-out.': tr(
    'የራስ ሰር ግብ ውጤት በመጨረሻ ይታያል። በጨዋታ ላይ እያሉ ገንዘብ ማውጣት የለም።',
    'Buʼaan galma ofumaanii xumura irratti mulʼata. Tapha keessa maallaqa baafachuun hin jiru.',
    'ውጽኢት ኣውቶማቲክ ዕላማ ኣብ መወዳእታ ይግለጽ። ኣብ ግዜ ጸወታ ገንዘብ ምውጻእ የለን።',
    'Natiijada bartilmaameedka otomaatiga ah waxaa la muujiyaa dhammaadka. Lacag lama bixi karo inta ciyaartu socoto.',
    'تُكشف نتيجة الهدف التلقائي عند النهاية. لا يوجد سحب أثناء اللعب.',
    'Matokeo ya lengo la kiotomatiki yanaonyeshwa mwishoni. Hakuna kutoa fedha wakati wa mchezo.',
    'Le résultat de l’objectif automatique est révélé à la fin. Aucun encaissement en direct n’est proposé.'
  ),
  'Outcome verified. Payment is still being confirmed.': tr(
    'ውጤቱ ተረጋግጧል። ክፍያው ገና እየተረጋገጠ ነው።',
    'Buʼaan mirkanaaʼeera. Kaffaltiin ammas mirkanaaʼaa jira.',
    'ውጽኢት ተረጋጊጹ። ክፍሊት ገና ይረጋገጽ ኣሎ።',
    'Natiijada waa la xaqiijiyay. Lacag bixinta weli waa la xaqiijinayaa.',
    'تم التحقق من النتيجة. لا يزال تأكيد الصرف جاريًا.',
    'Matokeo yamethibitishwa. Malipo bado yanathibitishwa.',
    'Résultat vérifié. Le versement est encore en cours de confirmation.'
  ),
} satisfies TranslationCatalog;
