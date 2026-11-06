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
  'This game is no longer available.': tr(
    'ይህ ጨዋታ ከእንግዲህ አይገኝም።',
    'Taphi kun kana booda hin argamu.',
    'እዚ ጸወታ ደጊም ኣይርከብን።',
    'Ciyaartan hadda lama heli karo.',
    'هذه اللعبة لم تعد متاحة.',
    'Mchezo huu haupatikani tena.',
    'Ce jeu n’est plus disponible.'
  ),
  'Ticket confirmed': tr(
    'ትኬቱ ተረጋግጧል',
    'Tikeetiin mirkanaaʼeera',
    'ትኬት ተረጋጊጹ',
    'Tigidhka waa la xaqiijiyay',
    'تم تأكيد التذكرة',
    'Tiketi imethibitishwa',
    'Ticket confirmé'
  ),
  'Ticket confirmed. Waiting for the draw.': tr(
    'ትኬቱ ተረጋግጧል። ዕጣውን በመጠባበቅ ላይ።',
    'Tikeetiin mirkanaaʼeera. Carraa baʼu eegaa jira.',
    'ትኬት ተረጋጊጹ። ዕጣ ይጽበ ኣሎ።',
    'Tigidhka waa la xaqiijiyay. Waxaa la sugayaa isku-aadka.',
    'تم تأكيد التذكرة. بانتظار السحب.',
    'Tiketi imethibitishwa. Tunasubiri droo.',
    'Ticket confirmé. En attente du tirage.'
  ),
  Time: tr('ጊዜ', 'Yeroo', 'ግዜ', 'Waqti', 'الوقت', 'Muda', 'Heure'),
  'Top returns · last 24 hours': tr(
    'ከፍተኛ ተመላሾች · ባለፉት 24 ሰዓታት',
    'Deebii olaanaa · saʼaatii 24 darban',
    'ዝለዓሉ ተመላሲታት · ዝሓለፉ 24 ሰዓታት',
    'Soo-noqoshada ugu sarreysa · 24-kii saac ee u dambeeyay',
    'أعلى العوائد · آخر 24 ساعة',
    'Marejesho makubwa · saa 24 zilizopita',
    'Meilleurs retours · dernières 24 heures'
  ),
  'Total bet': tr(
    'ጠቅላላ ውርርድ',
    'Waliigala buusii',
    'ጠቕላላ ውርርድ',
    'Wadarta sharadka',
    'إجمالي الرهان',
    'Jumla ya dau',
    'Mise totale'
  ),
  'Total bet:': tr(
    'ጠቅላላ ውርርድ፦',
    'Waliigala buusii:',
    'ጠቕላላ ውርርድ፦',
    'Wadarta sharadka:',
    'إجمالي الرهان:',
    'Jumla ya dau:',
    'Mise totale :'
  ),
  'Total return if successful': tr(
    'ከተሳካ ጠቅላላ ተመላሽ',
    'Yoo milkaaʼe waliigala deebii',
    'እንተተዓዊቱ ጠቕላላ ተመላሲ',
    'Wadarta soo-noqoshada haddii la guuleysto',
    'إجمالي العائد عند النجاح',
    'Jumla ya marejesho ukifanikiwa',
    'Retour total en cas de réussite'
  ),
  'Total tickets:': tr(
    'ጠቅላላ ትኬቶች፦',
    'Waliigala tikeetii:',
    'ጠቕላላ ትኬታት፦',
    'Wadarta tigidhada:',
    'إجمالي التذاكر:',
    'Jumla ya tiketi:',
    'Total des tickets :'
  ),
  Trackside: tr(
    'የውድድር ሜዳ ዳር',
    'Qarqara dirree fiigichaa',
    'ጥቓ መድረኽ ውድድር',
    'Dhinaca garoonka orodka',
    'جانب المضمار',
    'Kando ya uwanja wa mbio',
    'Bord de piste'
  ),
  'Try again or choose another game.': tr(
    'እንደገና ይሞክሩ ወይም ሌላ ጨዋታ ይምረጡ።',
    'Irra deebiʼii yaali ykn tapha biraa filadhu.',
    'ደጊምካ ፈትን ወይ ካልእ ጸወታ ምረጽ።',
    'Mar kale isku day ama dooro ciyaar kale.',
    'حاول مجددًا أو اختر لعبة أخرى.',
    'Jaribu tena au chagua mchezo mwingine.',
    'Réessayez ou choisissez un autre jeu.'
  ),
  'Try another title, provider, or category.': tr(
    'ሌላ ርዕስ፣ አቅራቢ ወይም ምድብ ይሞክሩ።',
    'Maqaa, dhiyeessaa ykn ramaddii biraa yaali.',
    'ካልእ ስም፣ ኣቕራቢ ወይ ምድብ ፈትን።',
    'Isku day magac, bixiye ama qayb kale.',
    'جرّب عنوانًا أو مزوّدًا أو فئة أخرى.',
    'Jaribu jina, mtoa huduma au aina nyingine.',
    'Essayez un autre titre, fournisseur ou catégorie.'
  ),
  Turbo: tr('ቱርቦ', 'Turbo', 'ቱርቦ', 'Turbo', 'توربو', 'Turbo', 'Turbo'),
  'Turbo Keno practice': tr(
    'የቱርቦ ኬኖ ልምምድ',
    'Shaakala Turbo Keno',
    'ልምምድ ቱርቦ ኬኖ',
    'Tababarka Turbo Keno',
    'تدريب توربو كينو',
    'Mazoezi ya Turbo Keno',
    'Entraînement Turbo Keno'
  ),
  Undo: tr('ቀልብስ', 'Duubatti deebisi', 'ንድሕሪት ምለስ', 'Ka noqo', 'تراجع', 'Tendua', 'Annuler'),
  'Unresolved selection:': tr(
    'ያልተወሰነ ምርጫ፦',
    'Filannoo hin xumuramne:',
    'ዘይተወድአ ምርጫ፦',
    'Doorasho aan la xallin:',
    'اختيار لم يُحسم:',
    'Chaguo ambalo halijatatuliwa:',
    'Sélection non résolue :'
  ),
  'Up to two tickets': tr(
    'እስከ ሁለት ትኬቶች',
    'Hanga tikeetii lamaa',
    'ክሳብ ክልተ ትኬታት',
    'Ilaa laba tigidh',
    'حتى تذكرتين',
    'Hadi tiketi mbili',
    'Jusqu’à deux tickets'
  ),
  'Upload proof JSON': tr(
    'የማስረጃ JSON ይጫኑ',
    'Ragaa JSON olkaaʼi',
    'JSON መርትዖ ጽዓን',
    'Soo geli caddaynta JSON',
    'رفع إثبات JSON',
    'Pakia uthibitisho wa JSON',
    'Importer la preuve JSON'
  ),
  'Upload saved receipt': tr(
    'የተቀመጠ ደረሰኝ ይጫኑ',
    'Nagahee olkaaʼame feʼi',
    'ዝተዓቀበ ቅብሊት ጽዓን',
    'Soo geli rasiidka la kaydiyay',
    'رفع الإيصال المحفوظ',
    'Pakia risiti iliyohifadhiwa',
    'Importer le reçu enregistré'
  ),
  'VIEW PAUSED · RECONNECTING': tr(
    'እይታው ቆሟል · እንደገና በመገናኘት ላይ',
    'MULʼANNI DHAABBATE · IRRA DEEBIʼEE WALQUNNAMAA JIRA',
    'ምርኢት ተቛሪጹ · ዳግም ይራኸብ ኣሎ',
    'MUUQAALKU WUU JOOGSADAY · DIB AYAA LOO XIRAYAA',
    'العرض متوقف · جارٍ إعادة الاتصال',
    'MWONEKANO UMESITISHWA · INAUNGANISHA TENA',
    'AFFICHAGE EN PAUSE · RECONNEXION'
  ),
  'Verified result · {computedOutcome}': tr(
    'የተረጋገጠ ውጤት · {computedOutcome}',
    'Buʼaa mirkanaaʼe · {computedOutcome}',
    'ዝተረጋገጸ ውጽኢት · {computedOutcome}',
    'Natiijo la xaqiijiyay · {computedOutcome}',
    'نتيجة موثقة · {computedOutcome}',
    'Matokeo yaliyothibitishwa · {computedOutcome}',
    'Résultat vérifié · {computedOutcome}'
  ),
  'Verify a Spin Win round': tr(
    'የSpin Win ዙር ያረጋግጡ',
    'Marsaa Spin Win mirkaneessi',
    'ዙር Spin Win ኣረጋግጽ',
    'Xaqiiji wareegga Spin Win',
    'التحقق من جولة Spin Win',
    'Thibitisha raundi ya Spin Win',
    'Vérifier une manche Spin Win'
  ),
  'Verify locally': tr(
    'በዚህ መሣሪያ ያረጋግጡ',
    'Meeshaa kana irratti mirkaneessi',
    'ኣብዚ መሳርሒ ኣረጋግጽ',
    'Ku xaqiiji qalabkan',
    'التحقق على هذا الجهاز',
    'Thibitisha kwenye kifaa hiki',
    'Vérifier sur cet appareil'
  ),
  'Verify round': tr(
    'ዙር ያረጋግጡ',
    'Marsaa mirkaneessi',
    'ዙር ኣረጋግጽ',
    'Xaqiiji wareegga',
    'التحقق من الجولة',
    'Thibitisha raundi',
    'Vérifier la manche'
  ),
  'View completed round {id}: {value}×': tr(
    'የተጠናቀቀውን ዙር {id} ይመልከቱ፦ {value}×',
    'Marsaa xumurame {id} ilaali: {value}×',
    'ዝተዛዘመ ዙር {id} ርአ፦ {value}×',
    'Eeg wareegga dhammaaday {id}: {value}×',
    'عرض الجولة المكتملة {id}: {value}×',
    'Tazama raundi iliyokamilika {id}: {value}×',
    'Voir la manche terminée {id} : {value}×'
  ),
  'View paused · Reconnecting': tr(
    'እይታው ቆሟል · እንደገና በመገናኘት ላይ',
    'Mulʼanni dhaabbate · irra deebiʼee walqunnamaa jira',
    'ምርኢት ተቛሪጹ · ዳግም ይራኸብ ኣሎ',
    'Muuqaalku wuu joogsaday · dib ayaa loo xirayaa',
    'العرض متوقف · جارٍ إعادة الاتصال',
    'Mwonekano umesitishwa · inaunganisha tena',
    'Affichage en pause · Reconnexion'
  ),
  'View round {id}': tr(
    'ዙር {id} ይመልከቱ',
    'Marsaa {id} ilaali',
    'ዙር {id} ርአ',
    'Eeg wareegga {id}',
    'عرض الجولة {id}',
    'Tazama raundi {id}',
    'Voir la manche {id}'
  ),
  'Viewing past round': tr(
    'ያለፈ ዙር በመመልከት ላይ',
    'Marsaa darbe ilaalaa jira',
    'ዝሓለፈ ዙር ይርአ ኣሎ',
    'Waxaa la eegayaa wareeg hore',
    'عرض جولة سابقة',
    'Unatazama raundi iliyopita',
    'Consultation d’une manche passée'
  ),
  'Virtual ETB · no cash value': tr(
    'ምናባዊ ETB · የገንዘብ ዋጋ የለውም',
    'ETB fakkeeffame · gatii maallaqaa hin qabu',
    'ምናባዊ ETB · ዋጋ ገንዘብ የብሉን',
    'ETB dalwad ah · lacag dhab ah uma qalmo',
    'ETB افتراضي · بلا قيمة نقدية',
    'ETB pepe · haina thamani ya pesa halisi',
    'ETB virtuels · aucune valeur monétaire'
  ),
  'Virtual play': tr(
    'ምናባዊ ጨዋታ',
    'Tapha fakkeeffame',
    'ምናባዊ ጸወታ',
    'Ciyaar dalwad ah',
    'لعب افتراضي',
    'Mchezo pepe',
    'Jeu virtuel'
  ),
  'Virtual test balance': tr(
    'ምናባዊ የሙከራ ቀሪ ሂሳብ',
    'Haftee yaalii fakkeeffame',
    'ምናባዊ ሒሳብ ፈተነ',
    'Haraaga tijaabada dalwadda',
    'رصيد اختبار افتراضي',
    'Salio pepe la majaribio',
    'Solde de test virtuel'
  ),
  WAITING: tr(
    'በመጠባበቅ ላይ',
    'EEGAA JIRA',
    'ይጽበ ኣሎ',
    'WAA LA SUGAYAA',
    'انتظار',
    'INASUBIRI',
    'EN ATTENTE'
  ),
  'WAITING FOR ROUND': tr(
    'ዙር በመጠባበቅ ላይ',
    'MARSAA EEGAA JIRA',
    'ዙር ይጽበ ኣሎ',
    'WAREEGGA AYAA LA SUGAYAA',
    'بانتظار الجولة',
    'INASUBIRI RAUNDI',
    'EN ATTENTE DE LA MANCHE'
  ),
  'Wait for next round': tr(
    'ቀጣዩን ዙር ይጠብቁ',
    'Marsaa itti aanu eegi',
    'ቀጻሊ ዙር ተጸበ',
    'Sug wareegga xiga',
    'انتظر الجولة التالية',
    'Subiri raundi inayofuata',
    'Attendez la prochaine manche'
  ),
  Waiting: tr(
    'በመጠባበቅ ላይ',
    'Eegaa jira',
    'ይጽበ ኣሎ',
    'Waa la sugayaa',
    'انتظار',
    'Inasubiri',
    'En attente'
  ),
  'Waiting for a fresh server update': tr(
    'ከአገልጋዩ አዲስ መረጃ በመጠባበቅ ላይ',
    'Odeeffannoo haaraa sarvaraa eegaa jira',
    'ሓድሽ ሓበሬታ ካብ ኣገልጋሊ ይጽበ ኣሎ',
    'Waxaa la sugayaa xog cusub oo seerfarka ah',
    'بانتظار تحديث جديد من الخادم',
    'Inasubiri taarifa mpya kutoka seva',
    'En attente d’une nouvelle mise à jour du serveur'
  ),
  'Waiting for a round': tr(
    'ዙር በመጠባበቅ ላይ',
    'Marsaa eegaa jira',
    'ዙር ይጽበ ኣሎ',
    'Wareeg ayaa la sugayaa',
    'بانتظار جولة',
    'Inasubiri raundi',
    'En attente d’une manche'
  ),
  'Waiting for card': tr(
    'ካርድ በመጠባበቅ ላይ',
    'Kaardii eegaa jira',
    'ካርድ ይጽበ ኣሎ',
    'Kaarka ayaa la sugayaa',
    'بانتظار الورقة',
    'Inasubiri kadi',
    'En attente d’une carte'
  ),
  'Waiting for round': tr(
    'ዙር በመጠባበቅ ላይ',
    'Marsaa eegaa jira',
    'ዙር ይጽበ ኣሎ',
    'Wareegga ayaa la sugayaa',
    'بانتظار الجولة',
    'Inasubiri raundi',
    'En attente de la manche'
  ),
  'Waiting for the confirmed result…': tr(
    'የተረጋገጠውን ውጤት በመጠባበቅ ላይ…',
    'Buʼaa mirkanaaʼe eegaa jira…',
    'ዝተረጋገጸ ውጽኢት ይጽበ ኣሎ…',
    'Natiijada la xaqiijiyay ayaa la sugayaa…',
    'بانتظار النتيجة المؤكدة…',
    'Inasubiri matokeo yaliyothibitishwa…',
    'En attente du résultat confirmé…'
  ),
  'Waiting for the draw': tr(
    'ዕጣውን በመጠባበቅ ላይ',
    'Carraa baʼu eegaa jira',
    'ዕጣ ይጽበ ኣሎ',
    'Isku-aadka ayaa la sugayaa',
    'بانتظار السحب',
    'Inasubiri droo',
    'En attente du tirage'
  ),
  'Waiting for the next race.': tr(
    'ቀጣዩን ውድድር በመጠባበቅ ላይ።',
    'Fiigicha itti aanu eegaa jira.',
    'ቀጻሊ ውድድር ይጽበ ኣሎ።',
    'Tartanka xiga ayaa la sugayaa.',
    'بانتظار السباق التالي.',
    'Inasubiri mbio zinazofuata.',
    'En attente de la prochaine course.'
  ),
  'Waiting for the next scheduled draw…': tr(
    'ቀጣዩን የታቀደ ዕጣ በመጠባበቅ ላይ…',
    'Carraa itti aanu saganteeffame eegaa jira…',
    'ቀጻሊ ዝተመደበ ዕጣ ይጽበ ኣሎ…',
    'Isku-aadka xiga ee jadwalaysan ayaa la sugayaa…',
    'بانتظار السحب المجدول التالي…',
    'Inasubiri droo inayofuata iliyopangwa…',
    'En attente du prochain tirage programmé…'
  ),
  'Waiting for the next scheduled round…': tr(
    'ቀጣዩን የታቀደ ዙር በመጠባበቅ ላይ…',
    'Marsaa itti aanu saganteeffame eegaa jira…',
    'ቀጻሊ ዝተመደበ ዙር ይጽበ ኣሎ…',
    'Wareegga xiga ee jadwalaysan ayaa la sugayaa…',
    'بانتظار الجولة المجدولة التالية…',
    'Inasubiri raundi inayofuata iliyopangwa…',
    'En attente de la prochaine manche programmée…'
  ),
  'Waiting for the result': tr(
    'ውጤቱን በመጠባበቅ ላይ',
    'Buʼaa eegaa jira',
    'ውጽኢት ይጽበ ኣሎ',
    'Natiijada ayaa la sugayaa',
    'بانتظار النتيجة',
    'Inasubiri matokeo',
    'En attente du résultat'
  ),
  'Welcome to Derby': tr(
    'እንኳን ወደ ደርቢ በደህና መጡ',
    'Baga gara Derby dhuftan',
    'ናብ ደርቢ እንቋዕ ብደሓን መጻእኩም',
    'Ku soo dhowow Derby',
    'مرحبًا بك في ديربي',
    'Karibu Derby',
    'Bienvenue dans Derby'
  ),
  'Welcome to Dog Racing': tr(
    'እንኳን ወደ ውሻ ውድድር በደህና መጡ',
    'Baga gara fiigicha saree dhuftan',
    'ናብ ውድድር ኣኽላባት እንቋዕ ብደሓን መጻእኩም',
    'Ku soo dhowow Tartanka Eeyaha',
    'مرحبًا بك في سباق الكلاب',
    'Karibu Mbio za Mbwa',
    'Bienvenue aux courses de chiens'
  ),
  'Win / refund': tr(
    'ሽልማት / ተመላሽ',
    'Moʼannaa / deebii',
    'ዓወት / ተመላሲ',
    'Guul / lacag-celin',
    'ربح / استرداد',
    'Ushindi / marejesho',
    'Gain / remboursement'
  ),
  'Win probability': tr(
    'የማሸነፍ ዕድል',
    'Carraa moʼannaa',
    'ዕድል ምዕዋት',
    'Suurtagalnimada guusha',
    'احتمال الفوز',
    'Uwezekano wa kushinda',
    'Probabilité de victoire'
  ),
  'Winner · #{value} {name}': tr(
    'አሸናፊ · #{value} {name}',
    'Moʼataa · #{value} {name}',
    'ተዓዋቲ · #{value} {name}',
    'Guuleyste · #{value} {name}',
    'الفائز · #{value} {name}',
    'Mshindi · #{value} {name}',
    'Vainqueur · n°{value} {name}'
  ),
  'Winning numbers: {value}': tr(
    'አሸናፊ ቁጥሮች፦ {value}',
    'Lakkoofsota moʼatan: {value}',
    'ተዓወትቲ ቁጽርታት፦ {value}',
    'Lambarada guuleystay: {value}',
    'الأرقام الفائزة: {value}',
    'Nambari zilizoshinda: {value}',
    'Numéros gagnants : {value}'
  ),
  Wins: tr('ድሎች', 'Moʼannoowwan', 'ዓወታት', 'Guulo', 'انتصارات', 'Ushindi', 'Victoires'),
  'YOUR LAST 20 ROUNDS': tr(
    'የእርስዎ የመጨረሻ 20 ዙሮች',
    'MARSAWWAN KEE 20 DHUMAA',
    'ናይ መወዳእታ 20 ዙራትካ',
    '20-KII WAREEG EE KUUGU DAMBEEYAY',
    'آخر 20 جولة لك',
    'RAUNDI ZAKO 20 ZA MWISHO',
    'VOS 20 DERNIÈRES MANCHES'
  ),
  'YOUR RACE SELECTION': tr(
    'የእርስዎ የውድድር ምርጫ',
    'FILANNOO FIIGICHAA KEE',
    'ምርጫ ውድድርካ',
    'DOORASHADAADA TARTANKA',
    'اختيارك للسباق',
    'CHAGUO LAKO LA MBIO',
    'VOTRE SÉLECTION DE COURSE'
  ),
  'YOUR SELECTION': tr(
    'የእርስዎ ምርጫ',
    'FILANNOO KEE',
    'ምርጫኻ',
    'DOORASHADAADA',
    'اختيارك',
    'CHAGUO LAKO',
    'VOTRE SÉLECTION'
  ),
  'YOUR TICKET': tr(
    'የእርስዎ ትኬት',
    'TIKEETII KEE',
    'ትኬትካ',
    'TIGIDHKAAGA',
    'تذكرتك',
    'TIKETI YAKO',
    'VOTRE TICKET'
  ),
  'You did not enter this round.': tr(
    'በዚህ ዙር አልተሳተፉም።',
    'Marsaa kana keessatti hin hirmaanne.',
    'ኣብዚ ዙር ኣይተሳተፍካን።',
    'Wareeggan kama aadan qaybgelin.',
    'لم تشارك في هذه الجولة.',
    'Hukushiriki katika raundi hii.',
    'Vous n’avez pas participé à cette manche.'
  ),
  'Your Dice ticket': tr(
    'የእርስዎ ዳይስ ትኬት',
    'Tikeetii Daayisii kee',
    'ትኬት ዳይስካ',
    'Tigidhkaaga Laadhuuda',
    'تذكرة النرد الخاصة بك',
    'Tiketi yako ya Kete',
    'Votre ticket de dés'
  ),
  'Your Spin bets': tr(
    'የእርስዎ የሽክርክሪት ውርርዶች',
    'Buusiiwwan naannaʼaa kee',
    'ውርርዳት ምዝዋርካ',
    'Sharadyadaada wareejinta',
    'رهانات الدوران الخاصة بك',
    'Dau zako za mzunguko',
    'Vos mises de rotation'
  ),
  'Your bet': tr(
    'የእርስዎ ውርርድ',
    'Buusii kee',
    'ውርርድካ',
    'Sharadkaaga',
    'رهانك',
    'Dau lako',
    'Votre mise'
  ),
  'Your bets': tr(
    'የእርስዎ ውርርዶች',
    'Buusiiwwan kee',
    'ውርርዳትካ',
    'Sharadyadaada',
    'رهاناتك',
    'Dau zako',
    'Vos mises'
  ),
  'Your bets this draw': tr(
    'በዚህ ዕጣ ያሉ ውርርዶችዎ',
    'Buusiiwwan kee carraa kanaa',
    'ውርርዳትካ ኣብዚ ዕጣ',
    'Sharadyadaada isku-aadkan',
    'رهاناتك في هذا السحب',
    'Dau zako katika droo hii',
    'Vos mises pour ce tirage'
  ),
  'Your bets this round': tr(
    'በዚህ ዙር ያሉ ውርርዶችዎ',
    'Buusiiwwan kee marsaa kanaa',
    'ውርርዳትካ ኣብዚ ዙር',
    'Sharadyadaada wareeggan',
    'رهاناتك في هذه الجولة',
    'Dau zako katika raundi hii',
    'Vos mises pour cette manche'
  ),
  'Your current round': tr(
    'የእርስዎ የአሁኑ ዙር',
    'Marsaa kee ammaa',
    'ናይ ሕጂ ዙርካ',
    'Wareeggaaga hadda',
    'جولتك الحالية',
    'Raundi yako ya sasa',
    'Votre manche actuelle'
  ),
  'Your game history': tr(
    'የጨዋታ ታሪክዎ',
    'Seenaa tapha kee',
    'ታሪኽ ጸወታኻ',
    'Taariikhda ciyaarahaaga',
    'سجل ألعابك',
    'Historia yako ya michezo',
    'Votre historique de jeu'
  ),
  'Your guess is saved while we confirm it.': tr(
    'ግምትዎን እያረጋገጥን እስካለን ድረስ ተቀምጧል።',
    'Tilmaamni kee yeroo mirkaneessinu olkaaʼameera.',
    'ግምትካ ክነረጋግጾ ከለና ተዓቂቡ ኣሎ።',
    'Qiyaastaada waa la kaydiyay inta aan xaqiijinayno.',
    'تم حفظ تخمينك أثناء تأكيده.',
    'Makisio yako yamehifadhiwa tunapoyathibitisha.',
    'Votre estimation est enregistrée pendant sa confirmation.'
  ),
  'Your number': tr(
    'የእርስዎ ቁጥር',
    'Lakkoofsa kee',
    'ቁጽርኻ',
    'Lambarkaaga',
    'رقمك',
    'Nambari yako',
    'Votre numéro'
  ),
  'Your practice activity · latest 12 rounds': tr(
    'የልምምድ እንቅስቃሴዎ · የመጨረሻ 12 ዙሮች',
    'Sochii shaakala kee · marsaa 12 dhumaa',
    'ንጥፈት ልምምድካ · ናይ መወዳእታ 12 ዙራት',
    'Dhaqdhaqaaqa tababarkaaga · 12-kii wareeg ee u dambeeyay',
    'نشاطك التدريبي · آخر 12 جولة',
    'Shughuli zako za mazoezi · raundi 12 za mwisho',
    'Votre activité d’entraînement · 12 dernières manches'
  ),
  'Your recent games and results.': tr(
    'የቅርብ ጨዋታዎችዎ እና ውጤቶችዎ።',
    'Taphoota fi buʼaawwan kee dhihoo.',
    'ናይ ቀረባ ጸወታታትካን ውጽኢታትካን።',
    'Ciyaarahaaga iyo natiijooyinkaagii dhowaa.',
    'ألعابك ونتائجك الأخيرة.',
    'Michezo na matokeo yako ya karibuni.',
    'Vos jeux et résultats récents.'
  ),
  'Your return is being confirmed…': tr(
    'ተመላሽዎ እየተረጋገጠ ነው…',
    'Deebiin kee mirkanaaʼaa jira…',
    'ተመላሲኻ ይረጋገጽ ኣሎ…',
    'Soo-noqoshadaada waa la xaqiijinayaa…',
    'جارٍ تأكيد عائدك…',
    'Marejesho yako yanathibitishwa…',
    'Confirmation de votre retour…'
  ),
  'Your return is being settled.': tr(
    'ተመላሽዎ እየተከፈለ ነው።',
    'Deebiin kee kaffalamaa jira.',
    'ተመላሲኻ ይኽፈል ኣሎ።',
    'Soo-noqoshadaada waa la bixinayaa.',
    'جارٍ تسوية عائدك.',
    'Marejesho yako yanashughulikiwa.',
    'Votre retour est en cours de règlement.'
  ),
  'Your round activity': tr(
    'የዙር እንቅስቃሴዎ',
    'Sochii marsaa kee',
    'ንጥፈት ዙርካ',
    'Dhaqdhaqaaqa wareeggaaga',
    'نشاط جولتك',
    'Shughuli zako za raundi',
    'Votre activité de manche'
  ),
  'Your selection returned {value} ETB.': tr(
    'ምርጫዎ {value} ETB መልሷል።',
    'Filannoon kee {value} ETB deebiseera.',
    'ምርጫኻ {value} ETB መሊሱ።',
    'Doorashadaadu waxay soo celisay {value} ETB.',
    'أعاد اختيارك {value} ETB.',
    'Chaguo lako limerudisha {value} ETB.',
    'Votre sélection a rapporté {value} ETB.'
  ),
  'Your selections appear here': tr(
    'ምርጫዎችዎ እዚህ ይታያሉ',
    'Filannoowwan kee asitti mulʼatu',
    'ምርጫታትካ ኣብዚ ይርኣዩ',
    'Doorashooyinkaagu halkan ayay ka muuqdaan',
    'تظهر اختياراتك هنا',
    'Machaguo yako yanaonekana hapa',
    'Vos sélections apparaissent ici'
  ),
  'Your session has expired. Sign in again to play.': tr(
    'የመግቢያ ጊዜዎ አልፏል። ለመጫወት እንደገና ይግቡ።',
    'Yeroon seensaa kee darbeera. Taphachuuf irra deebiʼii seeni.',
    'ግዜ ክፍለግዜኻ ኣሕሊፉ። ንምጽዋት ዳግም እቶ።',
    'Fadhigaagii wuu dhacay. Mar kale gal si aad u ciyaarto.',
    'انتهت جلستك. سجّل الدخول مجددًا للعب.',
    'Kipindi chako kimeisha. Ingia tena ili kucheza.',
    'Votre session a expiré. Reconnectez-vous pour jouer.'
  ),
  'Your ticket controls': tr(
    'የትኬትዎ መቆጣጠሪያዎች',
    'Toʼannoowwan tikeetii kee',
    'መቆጻጸሪታት ትኬትካ',
    'Xakamaynta tigidhkaaga',
    'عناصر التحكم بتذكرتك',
    'Vidhibiti vya tiketi yako',
    'Commandes de votre ticket'
  ),
  'Your ticket is confirmed. Good luck!': tr(
    'ትኬትዎ ተረጋግጧል። መልካም ዕድል!',
    'Tikeetiin kee mirkanaaʼeera. Carraa gaarii!',
    'ትኬትካ ተረጋጊጹ። ጽቡቕ ዕድል!',
    'Tigidhkaaga waa la xaqiijiyay. Nasiib wacan!',
    'تم تأكيد تذكرتك. حظًا سعيدًا!',
    'Tiketi yako imethibitishwa. Kila la heri!',
    'Votre ticket est confirmé. Bonne chance !'
  ),
  'Your tickets': tr(
    'የእርስዎ ትኬቶች',
    'Tikeetota kee',
    'ትኬታትካ',
    'Tigidhadaada',
    'تذاكرك',
    'Tiketi zako',
    'Vos tickets'
  ),
  'commitment receipt': tr(
    'የቅድመ ማረጋገጫ ደረሰኝ',
    'nagahee ragaa duraa',
    'ቅብሊት ቅድመ መረጋገጺ',
    'rasiidka xaqiijinta hore',
    'إيصال الالتزام المسبق',
    'risiti ya uthibitisho wa awali',
    'reçu d’engagement'
  ),
  'credits · no cash value': tr(
    'የጨዋታ ክሬዲቶች · የገንዘብ ዋጋ የላቸውም',
    'qabxii taphaa · gatii maallaqaa hin qabu',
    'ክሬዲት ጸወታ · ዋጋ ገንዘብ የብሉን',
    'dhibcaha ciyaarta · lacag dhab ah uma qalmaan',
    'أرصدة لعب · بلا قيمة نقدية',
    'vitengo vya mchezo · havina thamani ya pesa halisi',
    'crédits · aucune valeur monétaire'
  ),
  dogs: tr('ውሾች', 'sareewwan', 'ኣኽላባት', 'eeyo', 'كلاب', 'mbwa', 'chiens'),
  'expected house edge': tr(
    'የሚጠበቀው የመድረኩ የቁጥር ብልጫ',
    'caalmaa istaatistiksii waltajjii eegamu',
    'ዝትጽበ ናይ መድረኽ ቁጽራዊ ብልጫ',
    'faaʼiidada xisaabeed ee madasha la filayo',
    'أفضلية المنصة المتوقعة',
    'faida ya kitakwimu inayotarajiwa ya jukwaa',
    'avantage théorique attendu de la plateforme'
  ),
  horses: tr('ፈረሶች', 'fardeen', 'ኣፍራስ', 'fardo', 'خيول', 'farasi', 'chevaux'),
  'if your selection wins': tr(
    'ምርጫዎ ካሸነፈ',
    'yoo filannoon kee moʼate',
    'ምርጫኻ እንተተዓዊቱ',
    'haddii doorashadaadu guuleysato',
    'إذا فاز اختيارك',
    'chaguo lako likishinda',
    'si votre sélection gagne'
  ),
  jack: tr('ጃክ', 'jaakii', 'ጃክ', 'jaak', 'ولد', 'jaki', 'valet'),
  'maximum cash-out': tr(
    'ከፍተኛ የጨዋታ መውጫ መጠን',
    'baʼii taphaa olaanaa',
    'ዝለዓለ መጠን ምውጻእ ካብ ጸወታ',
    'inta ugu badan ee ciyaarta laga baxo',
    'الحد الأقصى للخروج من الجولة',
    'kiwango cha juu cha kutoka mchezoni',
    'encaissement maximal'
  ),
  'or a special finish': tr(
    'ወይም ልዩ አጨራረስ',
    'ykn xumura addaa',
    'ወይ ፍሉይ ኣወዳድኣ',
    'ama dhammaad gaar ah',
    'أو نهاية خاصة',
    'au mwisho maalumu',
    'ou une fin spéciale'
  ),
  pending: tr(
    'በመጠባበቅ ላይ',
    'eeggachaa',
    'ይጽበ ኣሎ',
    'sugaya',
    'قيد الانتظار',
    'inasubiri',
    'en attente'
  ),
  'per match': tr(
    'በእያንዳንዱ ተዛማጅ',
    'walsimannaa tokkoof',
    'ንነፍሲ ወከፍ ዝተዛመደ',
    'is-waafajin kasta',
    'لكل مطابقة',
    'kwa kila inayolingana',
    'par correspondance'
  ),
  'per matching number': tr(
    'በእያንዳንዱ ተዛማጅ ቁጥር',
    'lakkoofsa walsimu tokkoof',
    'ንነፍሲ ወከፍ ዝተዛመደ ቁጽሪ',
    'lambar kasta oo is-waafaqa',
    'لكل رقم مطابق',
    'kwa kila nambari inayolingana',
    'par numéro correspondant'
  ),
  'practice credits': tr(
    'የልምምድ ክሬዲቶች',
    'qabxii shaakalaa',
    'ክሬዲት ልምምድ',
    'dhibcaha tababarka',
    'أرصدة تدريب',
    'vitengo vya mazoezi',
    'crédits d’entraînement'
  ),
  return: tr('ተመላሽ', 'deebii', 'ተመላሲ', 'soo-noqosho', 'عائد', 'marejesho', 'retour'),
  'stream:sequence': tr(
    'ፍሰት፦ቅደም ተከተል',
    'dhangalaʼa:tartiiba',
    'ዋሕዚ፦ቅደም ተኸተል',
    'qulqul:taxane',
    'تدفق:تسلسل',
    'mtiririko:mfuatano',
    'flux:séquence'
  ),
  'theoretical return': tr(
    'ንድፈ ሐሳባዊ ተመላሽ',
    'deebii tiyoorii',
    'ቲዮራዊ ተመላሲ',
    'soo-noqoshada aragtiyeed',
    'العائد النظري',
    'marejesho ya kinadharia',
    'retour théorique'
  ),
  'to confirm your entry': tr(
    'ተሳትፎዎን ለማረጋገጥ',
    'hirmaannaa kee mirkaneessuuf',
    'ተሳትፎኻ ንምርግጋጽ',
    'si aad u xaqiijiso ka-qaybgalkaaga',
    'لتأكيد مشاركتك',
    'kuthibitisha ushiriki wako',
    'pour confirmer votre participation'
  ),
  'total:': tr('ጠቅላላ፦', 'waliigala:', 'ጠቕላላ፦', 'wadarta:', 'المجموع:', 'jumla:', 'total :'),
  'verified proof': tr(
    'የተረጋገጠ ማስረጃ',
    'ragaa mirkanaaʼe',
    'ዝተረጋገጸ መርትዖ',
    'caddayn la xaqiijiyay',
    'إثبات موثّق',
    'uthibitisho uliokaguliwa',
    'preuve vérifiée'
  ),
  'winning total': tr(
    'አሸናፊ ድምር',
    'idaʼama moʼatu',
    'ተዓዋቲ ድምር',
    'wadarta guuleysatay',
    'المجموع الفائز',
    'jumla iliyoshinda',
    'total gagnant'
  ),
  '{amount} Coins ·': tr(
    '{amount} ሳንቲሞች ·',
    'Saantima {amount} ·',
    '{amount} ሳንቲም ·',
    '{amount} qadaadiic ·',
    '{amount} عملة ·',
    'Sarafu {amount} ·',
    '{amount} pièces ·'
  ),
  '{away} away': tr(
    '{away} ውጪ',
    '{away} alaa',
    '{away} ወጻኢ',
    '{away} marti',
    '{away} ضيف',
    '{away} ugenini',
    '{away} extérieur'
  ),
  '{cost} ETB': tr(
    '{cost} ETB',
    '{cost} ETB',
    '{cost} ETB',
    '{cost} ETB',
    '{cost} ETB',
    '{cost} ETB',
    '{cost} ETB'
  ),
  '{countdown}s': tr(
    '{countdown}ሰ',
    '{countdown}s',
    '{countdown}ሰ',
    '{countdown}ilb',
    '{countdown}ث',
    '{countdown}sek',
    '{countdown}s'
  ),
  '{count} of 20': tr(
    '{count} ከ20',
    '20 keessaa {count}',
    'ካብ 20 {count}',
    '{count} ka mid ah 20',
    '{count} من 20',
    '{count} kati ya 20',
    '{count} sur 20'
  ),
  '{count} of 20 balls revealed': tr(
    'ከ20 ኳሶች {count} ታይተዋል',
    'Kubbaa 20 keessaa {count} mulʼate',
    'ካብ 20 ኩዕሶታት {count} ተገሊጾም',
    '{count} ka mid ah 20 kubbadood ayaa la muujiyay',
    'تم كشف {count} من 20 كرة',
    'Mipira {count} kati ya 20 imeonyeshwa',
    '{count} boules sur 20 révélées'
  ),
  '{count} of 20 revealed · {length} matches': tr(
    'ከ20 {count} ታይተዋል · {length} ተዛማጆች',
    '20 keessaa {count} mulʼate · walsimannaa {length}',
    'ካብ 20 {count} ተገሊጾም · {length} ዝተዛመዱ',
    '{count} ka mid ah 20 ayaa la muujiyay · {length} is-waafajin',
    'كُشف {count} من 20 · {length} مطابقة',
    '{count} kati ya 20 zimeonyeshwa · {length} zinazolingana',
    '{count} sur 20 révélés · {length} correspondances'
  ),
  '{field} runners · {id}': tr(
    '{field} ተወዳዳሪዎች · {id}',
    'Dorgomtoota {field} · {id}',
    '{field} ተወዳደርቲ · {id}',
    '{field} tartame · {id}',
    '{field} متسابق · {id}',
    'Washiriki {field} · {id}',
    '{field} partants · {id}'
  ),
  '{length} / 1 selected': tr(
    '{length} / 1 ተመርጧል',
    '{length} / 1 filatame',
    '{length} / 1 ተመሪጹ',
    '{length} / 1 la doortay',
    '{length} / 1 محدد',
    '{length} / 1 imechaguliwa',
    '{length} / 1 sélectionné'
  ),
  '{length} / 6 selected': tr(
    '{length} / 6 ተመርጠዋል',
    '{length} / 6 filataman',
    '{length} / 6 ተመሪጾም',
    '{length} / 6 la doortay',
    '{length} / 6 محدد',
    '{length} / 6 zimechaguliwa',
    '{length} / 6 sélectionnés'
  ),
  '{length} / {maxTickets} confirmed': tr(
    '{length} / {maxTickets} ተረጋግጠዋል',
    '{length} / {maxTickets} mirkanaaʼan',
    '{length} / {maxTickets} ተረጋጊጾም',
    '{length} / {maxTickets} la xaqiijiyay',
    '{length} / {maxTickets} مؤكد',
    '{length} / {maxTickets} zimethibitishwa',
    '{length} / {maxTickets} confirmés'
  ),
  '{length} matches · {value}': tr(
    '{length} ተዛማጆች · {value}',
    'Walsimannaa {length} · {value}',
    '{length} ዝተዛመዱ · {value}',
    '{length} is-waafajin · {value}',
    '{length} مطابقة · {value}',
    '{length} zinazolingana · {value}',
    '{length} correspondances · {value}'
  ),
  '{length} matches · {value} credits returned': tr(
    '{length} ተዛማጆች · {value} ክሬዲቶች ተመልሰዋል',
    'Walsimannaa {length} · qabxii {value} deebiʼe',
    '{length} ዝተዛመዱ · {value} ክሬዲት ተመሊሱ',
    '{length} is-waafajin · {value} dhibcood ayaa la soo celiyay',
    '{length} مطابقة · أعيد {value} من رصيد اللعب',
    '{length} zinazolingana · vitengo {value} vimerudishwa',
    '{length} correspondances · {value} crédits reversés'
  ),
  '{length} numbers × {value} ETB': tr(
    '{length} ቁጥሮች × {value} ETB',
    'Lakkoofsota {length} × {value} ETB',
    '{length} ቁጽርታት × {value} ETB',
    '{length} lambar × {value} ETB',
    '{length} رقم × {value} ETB',
    'Nambari {length} × {value} ETB',
    '{length} numéros × {value} ETB'
  ),
  '{length} numbers × {value} credits': tr(
    '{length} ቁጥሮች × {value} ክሬዲቶች',
    'Lakkoofsota {length} × qabxii {value}',
    '{length} ቁጽርታት × {value} ክሬዲት',
    '{length} lambar × {value} dhibcood',
    '{length} رقم × {value} من رصيد اللعب',
    'Nambari {length} × vitengo {value}',
    '{length} numéros × {value} crédits'
  ),
  '{length} of 6 numbers selected': tr(
    'ከ6 ቁጥሮች {length} ተመርጠዋል',
    'Lakkoofsota 6 keessaa {length} filataman',
    'ካብ 6 ቁጽርታት {length} ተመሪጾም',
    '{length} ka mid ah 6 lambar ayaa la doortay',
    'تم تحديد {length} من 6 أرقام',
    'Nambari {length} kati ya 6 zimechaguliwa',
    '{length} numéros sur 6 sélectionnés'
  ),
  '{length}/10 confirmed': tr(
    '{length}/10 ተረጋግጠዋል',
    '{length}/10 mirkanaaʼan',
    '{length}/10 ተረጋጊጾም',
    '{length}/10 la xaqiijiyay',
    '{length}/10 مؤكد',
    '{length}/10 zimethibitishwa',
    '{length}/10 confirmés'
  ),
  '{length}/10 numbers selected': tr(
    '{length}/10 ቁጥሮች ተመርጠዋል',
    'Lakkoofsota {length}/10 filataman',
    '{length}/10 ቁጽርታት ተመሪጾም',
    '{length}/10 lambar ayaa la doortay',
    'تم تحديد {length}/10 أرقام',
    'Nambari {length}/10 zimechaguliwa',
    '{length}/10 numéros sélectionnés'
  ),
  '{name} race progress': tr(
    'የ{name} ውድድር ሂደት',
    'Adeemsa fiigichaa {name}',
    'ከይዲ ውድድር {name}',
    'Horumarka tartanka {name}',
    'تقدم سباق {name}',
    'Maendeleo ya mbio za {name}',
    'Progression de course de {name}'
  ),
  '{name} test': tr(
    'የ{name} ሙከራ',
    'Yaalii {name}',
    'ፈተነ {name}',
    'Tijaabada {name}',
    'اختبار {name}',
    'Jaribio la {name}',
    'Test {name}'
  ),
  '{name} wins': tr(
    '{name} አሸነፈ',
    '{name} moʼate',
    '{name} ተዓዊቱ',
    '{name} ayaa guuleystay',
    'فاز {name}',
    '{name} ameshinda',
    '{name} gagne'
  ),
  '{payout} ETB': tr(
    '{payout} ETB',
    '{payout} ETB',
    '{payout} ETB',
    '{payout} ETB',
    '{payout} ETB',
    '{payout} ETB',
    '{payout} ETB'
  ),
};
export default catalogue;
