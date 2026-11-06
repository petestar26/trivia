import type { TranslationCatalog, TranslationEntry } from '../types';
const tr = (
  am: string,
  om: string,
  ti: string,
  so: string,
  ar: string,
  sw: string,
  fr: string
): TranslationEntry => ({ am, om, ti, so, ar, sw, fr });
const catalogue: TranslationCatalog = {
  '{payout} ETB returned': tr(
    '{payout} ETB ተመልሷል',
    '{payout} ETB deebiʼe',
    '{payout} ETB ተመሊሱ',
    '{payout} ETB ayaa la soo celiyay',
    'أعيد {payout} ETB',
    '{payout} ETB imerudishwa',
    '{payout} ETB reversés'
  ),
  '{payout} practice ETB returned': tr(
    '{payout} የልምምድ ETB ተመልሷል',
    '{payout} ETB shaakalaa deebiʼe',
    '{payout} ETB ልምምድ ተመሊሱ',
    '{payout} ETB tababar ah ayaa la soo celiyay',
    'أعيد {payout} ETB تدريبي',
    '{payout} ETB ya mazoezi imerudishwa',
    '{payout} ETB d’entraînement reversés'
  ),
  '{score} practice score': tr(
    '{score} የልምምድ ነጥብ',
    'Qabxii shaakalaa {score}',
    '{score} ነጥቢ ልምምድ',
    '{score} dhibcood oo tababar ah',
    'نتيجة تدريب {score}',
    'Alama {score} za mazoezi',
    'Score d’entraînement de {score}'
  ),
  '{seconds}s': tr(
    '{seconds}ሰ',
    '{seconds}s',
    '{seconds}ሰ',
    '{seconds}ilb',
    '{seconds}ث',
    '{seconds}sek',
    '{seconds}s'
  ),
  '{stake} ETB': tr(
    '{stake} ETB',
    '{stake} ETB',
    '{stake} ETB',
    '{stake} ETB',
    '{stake} ETB',
    '{stake} ETB',
    '{stake} ETB'
  ),
  '{stake} ETB in play': tr(
    '{stake} ETB በጨዋታ ላይ',
    '{stake} ETB tapha keessa',
    '{stake} ETB ኣብ ጸወታ',
    '{stake} ETB ciyaarta ku jira',
    '{stake} ETB قيد اللعب',
    '{stake} ETB kwenye mchezo',
    '{stake} ETB en jeu'
  ),
  '{stake} ETB locked': tr(
    '{stake} ETB ተይዟል',
    '{stake} ETB qabame',
    '{stake} ETB ተታሒዙ',
    '{stake} ETB waa la xayiray',
    '{stake} ETB محجوز',
    '{stake} ETB imehifadhiwa kwa dau',
    '{stake} ETB bloqués'
  ),
  '{stake} ETB staked': tr(
    '{stake} ETB ተወራርዷል',
    '{stake} ETB buufame',
    '{stake} ETB ተወሪዱ',
    '{stake} ETB ayaa la sharaday',
    '{stake} ETB مراهن بها',
    '{stake} ETB imewekwa kama dau',
    '{stake} ETB misés'
  ),
  '{stake} ETB · {value}×': tr(
    '{stake} ETB · {value}×',
    '{stake} ETB · {value}×',
    '{stake} ETB · {value}×',
    '{stake} ETB · {value}×',
    '{stake} ETB · {value}×',
    '{stake} ETB · {value}×',
    '{stake} ETB · {value}×'
  ),
  '{stake} staked · {value} returned': tr(
    '{stake} ተወራርዷል · {value} ተመልሷል',
    '{stake} buufame · {value} deebiʼe',
    '{stake} ተወሪዱ · {value} ተመሊሱ',
    '{stake} la sharaday · {value} la soo celiyay',
    '{stake} مراهن بها · {value} أعيد',
    '{stake} imewekwa · {value} imerudishwa',
    '{stake} misés · {value} reversés'
  ),
  '{total} Coins': tr(
    '{total} ሳንቲሞች',
    'Saantima {total}',
    '{total} ሳንቲም',
    '{total} qadaadiic',
    '{total} عملة',
    'Sarafu {total}',
    '{total} pièces'
  ),
  '{value} ETB': tr(
    '{value} ETB',
    '{value} ETB',
    '{value} ETB',
    '{value} ETB',
    '{value} ETB',
    '{value} ETB',
    '{value} ETB'
  ),
  '{value} ETB returned': tr(
    '{value} ETB ተመልሷል',
    '{value} ETB deebiʼe',
    '{value} ETB ተመሊሱ',
    '{value} ETB ayaa la soo celiyay',
    'أعيد {value} ETB',
    '{value} ETB imerudishwa',
    '{value} ETB reversés'
  ),
  '{value} ETB returned {value2}. Includes stake.': tr(
    '{value} ETB ተመልሷል {value2}። ውርርዱን ያካትታል።',
    '{value} ETB deebiʼe {value2}. Buusii ni dabalata.',
    '{value} ETB ተመሊሱ {value2}። ውርርድ ይሓውስ።',
    '{value} ETB ayaa la soo celiyay {value2}. Sharadku wuu ku jiraa.',
    'أعيد {value} ETB {value2}. يشمل مبلغ الرهان.',
    '{value} ETB imerudishwa {value2}. Inajumuisha dau.',
    '{value} ETB reversés {value2}. Mise incluse.'
  ),
  '{value} ETB returned · Bet {slot}': tr(
    '{value} ETB ተመልሷል · ውርርድ {slot}',
    '{value} ETB deebiʼe · Buusii {slot}',
    '{value} ETB ተመሊሱ · ውርርድ {slot}',
    '{value} ETB la soo celiyay · Sharad {slot}',
    'أعيد {value} ETB · رهان {slot}',
    '{value} ETB imerudishwa · Dau {slot}',
    '{value} ETB reversés · Mise {slot}'
  ),
  '{value} ETB total': tr(
    'ጠቅላላ {value} ETB',
    'Waliigala {value} ETB',
    'ጠቕላላ {value} ETB',
    'Wadar {value} ETB',
    'الإجمالي {value} ETB',
    'Jumla {value} ETB',
    '{value} ETB au total'
  ),
  '{value} credits': tr(
    '{value} የጨዋታ ክሬዲቶች',
    'Qabxii taphaa {value}',
    '{value} ክሬዲት ጸወታ',
    '{value} dhibcood oo ciyaarta ah',
    '{value} من رصيد اللعب',
    'Vitengo {value} vya mchezo',
    '{value} crédits'
  ),
  '{value} options': tr(
    '{value} አማራጮች',
    'Filannoowwan {value}',
    '{value} ኣማራጺታት',
    '{value} ikhtiyaar',
    '{value} خيار',
    'Machaguo {value}',
    '{value} options'
  ),
  '{value} practice ETB': tr(
    '{value} የልምምድ ETB',
    '{value} ETB shaakalaa',
    '{value} ETB ልምምድ',
    '{value} ETB tababar ah',
    '{value} ETB تدريبي',
    '{value} ETB ya mazoezi',
    '{value} ETB d’entraînement'
  ),
  '{value} seconds': tr(
    '{value} ሰከንዶች',
    'Sekondii {value}',
    '{value} ካልኢታት',
    '{value} ilbiriqsi',
    '{value} ثانية',
    'Sekunde {value}',
    '{value} secondes'
  ),
  '{value} tickets': tr(
    '{value} ትኬቶች',
    'Tikeetota {value}',
    '{value} ትኬታት',
    '{value} tigidh',
    '{value} تذكرة',
    'Tiketi {value}',
    '{value} tickets'
  ),
  '{value} · View round details': tr(
    '{value} · የዙር ዝርዝሮችን ይመልከቱ',
    '{value} · Balʼina marsaa ilaali',
    '{value} · ዝርዝር ዙር ርአ',
    '{value} · Eeg faahfaahinta wareegga',
    '{value} · عرض تفاصيل الجولة',
    '{value} · Tazama maelezo ya raundi',
    '{value} · Voir les détails de la manche'
  ),
  '{value} · anonymous practice players': tr(
    '{value} · ስማቸው ያልታወቀ የልምምድ ተጫዋቾች',
    '{value} · taphattoota shaakalaa maqaan isaanii hin mulʼanne',
    '{value} · ስሞም ዘይተገልጸ ተጻወትቲ ልምምድ',
    '{value} · ciyaartoy tababar oo aan magac lahayn',
    '{value} · لاعبون تدريبيون مجهولو الاسم',
    '{value} · wachezaji wa mazoezi wasiotajwa majina',
    '{value} · joueurs d’entraînement anonymes'
  ),
  '{value}% expected house edge': tr(
    '{value}% የሚጠበቅ የመድረክ ቁጥራዊ ብልጫ',
    '{value}% caalmaa istaatistiksii waltajjii eegamu',
    '{value}% ዝትጽበ ቁጽራዊ ብልጫ መድረኽ',
    '{value}% faaʼiidada xisaabeed ee madasha la filayo',
    '{value}% أفضلية متوقعة للمنصة',
    '{value}% faida ya kitakwimu inayotarajiwa ya jukwaa',
    '{value}% d’avantage théorique attendu de la plateforme'
  ),
  '{value}% theoretical return': tr(
    '{value}% ንድፈ ሐሳባዊ ተመላሽ',
    '{value}% deebii tiyoorii',
    '{value}% ቲዮራዊ ተመላሲ',
    '{value}% soo-noqosho aragtiyeed',
    '{value}% عائد نظري',
    '{value}% marejesho ya kinadharia',
    '{value}% de retour théorique'
  ),
  '{value}. Returns include stake.': tr(
    '{value}። ተመላሾች ውርርዱን ያካትታሉ።',
    '{value}. Deebiin buusii ni dabalata.',
    '{value}። ተመላሲታት ውርርድ ይሓውሱ።',
    '{value}. Soo-noqoshadu sharadka ayay ku jirtaa.',
    '{value}. العوائد تشمل مبلغ الرهان.',
    '{value}. Marejesho yanajumuisha dau.',
    '{value}. Les retours incluent la mise.'
  ),
  '{value}Rules v{rulesVersion}': tr(
    '{value}ደንቦች ስሪት {rulesVersion}',
    '{value}Seerota v{rulesVersion}',
    '{value}ሕግታት ስሪት {rulesVersion}',
    '{value}Xeerarka v{rulesVersion}',
    '{value}القواعد إصدار {rulesVersion}',
    '{value}Kanuni v{rulesVersion}',
    '{value}Règles v{rulesVersion}'
  ),
  '{value}s': tr(
    '{value}ሰ',
    '{value}s',
    '{value}ሰ',
    '{value}ilb',
    '{value}ث',
    '{value}sek',
    '{value}s'
  ),
  '{value}th': tr(
    '{value}ኛ',
    '{value}ffaa',
    'መበል {value}',
    '{value}aad',
    'المرتبة {value}',
    'Nafasi {value}',
    '{value}e'
  ),
  '{value}× locked · Stage {value2}': tr(
    '{value}× ተቆልፏል · ደረጃ {value2}',
    '{value}× cufame · Sadarkaa {value2}',
    '{value}× ተዓጽዩ · ደረጃ {value2}',
    '{value}× waa la xiray · Marxalad {value2}',
    '{value}× مثبت · المرحلة {value2}',
    '{value}× imefungwa · Hatua {value2}',
    '{value}× verrouillé · Étape {value2}'
  ),
  '· Bet {slot}: {value} ETB': tr(
    '· ውርርድ {slot}፦ {value} ETB',
    '· Buusii {slot}: {value} ETB',
    '· ውርርድ {slot}፦ {value} ETB',
    '· Sharad {slot}: {value} ETB',
    '· الرهان {slot}: {value} ETB',
    '· Dau {slot}: {value} ETB',
    '· Mise {slot} : {value} ETB'
  ),
  '· Range {value}–{value2}': tr(
    '· ክልል {value}–{value2}',
    '· Daangaa {value}–{value2}',
    '· ክልል {value}–{value2}',
    '· Xadka {value}–{value2}',
    '· النطاق {value}–{value2}',
    '· Masafa {value}–{value2}',
    '· Intervalle {value}–{value2}'
  ),
  '· Return': tr(
    '· ተመላሽ',
    '· Deebii',
    '· ተመላሲ',
    '· Soo-noqosho',
    '· العائد',
    '· Marejesho',
    '· Retour'
  ),
  '· Schema v{resultSchemaVersion}': tr(
    '· የውሂብ ንድፍ ስሪት {resultSchemaVersion}',
    '· Caasaa deetaa v{resultSchemaVersion}',
    '· ቅርጺ ሓበሬታ ስሪት {resultSchemaVersion}',
    '· Qaab-dhismeedka xogta v{resultSchemaVersion}',
    '· مخطط البيانات إصدار {resultSchemaVersion}',
    '· Muundo wa data v{resultSchemaVersion}',
    '· Schéma v{resultSchemaVersion}'
  ),
  '· Target': tr('· ዒላማ', '· Galma', '· ዒላማ', '· Bartilmaameed', '· الهدف', '· Lengo', '· Cible'),
  '← All games': tr(
    '← ሁሉም ጨዋታዎች',
    '← Taphoota hunda',
    '← ኩሎም ጸወታታት',
    '← Dhammaan ciyaaraha',
    '← جميع الألعاب',
    '← Michezo yote',
    '← Tous les jeux'
  ),
  '← Back to live table': tr(
    '← ወደ ቀጥታ ጠረጴዛ ተመለስ',
    '← Gara minjaala kallattiitti deebiʼi',
    '← ናብ ቀጥታ ጠረጴዛ ተመለስ',
    '← Ku noqo miiska tooska ah',
    '← العودة إلى الطاولة المباشرة',
    '← Rudi kwenye meza ya moja kwa moja',
    '← Retour à la table en direct'
  ),
  '← Games': tr(
    '← ጨዋታዎች',
    '← Taphoota',
    '← ጸወታታት',
    '← Ciyaaraha',
    '← الألعاب',
    '← Michezo',
    '← Jeux'
  ),
  '← Spin Win': tr(
    '← ስፒን ዊን',
    '← Spin Win',
    '← ስፒን ዊን',
    '← Spin Win',
    '← سبين وين',
    '← Spin Win',
    '← Spin Win'
  ),
  '○ Connecting': tr(
    '○ በመገናኘት ላይ',
    '○ Walqunnamaa jira',
    '○ ይራኸብ ኣሎ',
    '○ Waa la xirayaa',
    '○ جارٍ الاتصال',
    '○ Inaunganisha',
    '○ Connexion'
  ),
  '○ Refreshing race status': tr(
    '○ የውድድር ሁኔታን በማደስ ላይ',
    '○ Haala fiigichaa haaromsaa jira',
    '○ ኩነታት ውድድር የሐድስ ኣሎ',
    '○ Xaaladda tartanka waa la cusboonaysiinayaa',
    '○ جارٍ تحديث حالة السباق',
    '○ Inasasisha hali ya mbio',
    '○ Actualisation de la course'
  ),
  '● Connected': tr(
    '● ተገናኝቷል',
    '● Walqunnameera',
    '● ተራኺቡ',
    '● Xiriirku wuu shaqaynayaa',
    '● متصل',
    '● Imeunganishwa',
    '● Connecté'
  ),
  '✓ Bet confirmed': tr(
    '✓ ውርርዱ ተረጋግጧል',
    '✓ Buusiin mirkanaaʼeera',
    '✓ ውርርድ ተረጋጊጹ',
    '✓ Sharadka waa la xaqiijiyay',
    '✓ تم تأكيد الرهان',
    '✓ Dau limethibitishwa',
    '✓ Mise confirmée'
  ),
  '✓ Saved': tr(
    '✓ ተቀምጧል',
    '✓ Olkaaʼameera',
    '✓ ተዓቂቡ',
    '✓ Waa la kaydiyay',
    '✓ تم الحفظ',
    '✓ Imehifadhiwa',
    '✓ Enregistré'
  ),
};
export default catalogue;
