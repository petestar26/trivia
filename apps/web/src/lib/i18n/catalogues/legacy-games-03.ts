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
  'Entry open': tr(
    'ተሳትፎ ክፍት ነው',
    'Seensi banaa dha',
    'ተሳትፎ ክፉት እዩ',
    'Gelitaanku waa furan yahay',
    'المشاركة مفتوحة',
    'Usajili umefunguliwa',
    'Inscriptions ouvertes'
  ),
  'Entry paid once to the contest': tr(
    'የውድድር መግቢያው አንድ ጊዜ ተከፍሏል',
    'Kaffaltiin hirmaannaa dorgommiif yeroo tokko kaffalame',
    'መጠን ተሳትፎ ንውድድር ሓንሳብ ተኸፊሉ',
    'Lacagta ka qaybgalka tartanka hal mar ayaa la bixiyey',
    'دُفع مبلغ المشاركة للمسابقة مرة واحدة',
    'Kiasi cha ushiriki kimelipwa mara moja kwa shindano',
    'Participation payée une seule fois au concours'
  ),
  'Every ball brings a new possibility.': tr(
    'እያንዳንዱ ኳስ አዲስ ዕድል ያመጣል።',
    'Kubbaan hundi carraa haaraa fida.',
    'ነፍሲ ወከፍ ኩዕሶ ሓድሽ ዕድል የምጽእ።',
    'Kubbad kastaa waxay keentaa suurtagalnimo cusub.',
    'كل كرة تحمل احتمالًا جديدًا.',
    'Kila mpira huleta uwezekano mpya.',
    'Chaque boule ouvre une nouvelle possibilité.'
  ),
  'Every five minutes': tr(
    'በየአምስት ደቂቃው',
    'Daqiiqaa shan shaniin',
    'ኣብ ነፍሲ ወከፍ ሓሙሽተ ደቓይቕ',
    'Shantii daqiiqoba',
    'كل خمس دقائق',
    'Kila dakika tano',
    'Toutes les cinq minutes'
  ),
  'Every target from 1 to 100 is equally likely.': tr(
    'ከ1 እስከ 100 ያለ እያንዳንዱ ዒላማ እኩል ዕድል አለው።',
    'Galmi 1 hanga 100 jiru hundi carraa walqixa qaba.',
    'ካብ 1 ክሳብ 100 ዘሎ ነፍሲ ወከፍ ዕላማ ማዕረ ዕድል ኣለዎ።',
    'Bartilmaameed kasta oo 1 ilaa 100 ah wuxuu leeyahay fursad isku mid ah.',
    'لكل هدف من 1 إلى 100 الاحتمال نفسه.',
    'Kila lengo kutoka 1 hadi 100 lina nafasi sawa.',
    'Chaque cible de 1 à 100 a la même probabilité.'
  ),
  'Every {value} min': tr(
    'በየ{value} ደቂቃው',
    'Daqiiqaa {value}n',
    'ኣብ ነፍሲ ወከፍ {value} ደቓይቕ',
    '{value} daqiiqo kasta',
    'كل {value} دقيقة',
    'Kila dakika {value}',
    'Toutes les {value} min'
  ),
  Exact: tr('ትክክል', 'Sirrii', 'ልክዕ', 'Sax', 'مطابق تمامًا', 'Sahihi kabisa', 'Exact'),
  'Exact match!': tr(
    'በትክክል ተዛምዷል!',
    'Sirriitti walsime!',
    'ልክዕ ተዛሚዱ!',
    'Si sax ah ayuu u dhigmaa!',
    'مطابقة تامة!',
    'Inalingana kabisa!',
    'Correspondance exacte !'
  ),
  'FIRST BALL': tr(
    'የመጀመሪያ ኳስ',
    'KUBBAA JALQABAA',
    'ቀዳመይቲ ኩዕሶ',
    'KUBBADDA KOOWAAD',
    'الكرة الأولى',
    'MPIRA WA KWANZA',
    'PREMIÈRE BOULE'
  ),
  'FLEW AWAY!': tr(
    'በርሮ ሄዷል!',
    'BALALIʼEE BAʼE!',
    'በሪሩ ከይዱ!',
    'WUU DUULAY!',
    'طار بعيدًا!',
    'IMERUKA MBALI!',
    'ENVOLÉ !'
  ),
  FOOTBALL: tr(
    'እግር ኳስ',
    'KUBBAA MIILAA',
    'ኩዕሶ እግሪ',
    'KUBADDA CAGTA',
    'كرة القدم',
    'MPIRA WA MIGUU',
    'FOOTBALL'
  ),
  'Featured match': tr(
    'ተመራጭ ጨዋታ',
    'Tapha filatame',
    'ዝተመርጸ ጸወታ',
    'Kulanka la xushay',
    'المباراة المميزة',
    'Mechi iliyoangaziwa',
    'Match à lʼaffiche'
  ),
  'Final multiplier · confirmed by the server': tr(
    'የመጨረሻ ማባዣ · በአገልጋዩ የተረጋገጠ',
    'Baayʼisaa xumuraa · sarvariin mirkanaaʼe',
    'ናይ መወዳእታ መባዝሒ · ብሰርቨር ዝተረጋገጸ',
    'Isku-dhufteha kama dambaysta ah · serfarku xaqiijiyey',
    'المضاعف النهائي · مؤكد من الخادم',
    'Kizidishi cha mwisho · kimethibitishwa na seva',
    'Multiplicateur final · confirmé par le serveur'
  ),
  'Final points': tr(
    'የመጨረሻ ነጥቦች',
    'Qabxii xumuraa',
    'ናይ መወዳእታ ነጥብታት',
    'Dhibcaha kama dambaysta ah',
    'النقاط النهائية',
    'Alama za mwisho',
    'Points finaux'
  ),
  'Final result': tr(
    'የመጨረሻ ውጤት',
    'Buʼaa xumuraa',
    'ናይ መወዳእታ ውጽኢት',
    'Natiijada kama dambaysta ah',
    'النتيجة النهائية',
    'Matokeo ya mwisho',
    'Résultat final'
  ),
  'Find your game. Make it your moment.': tr(
    'ጨዋታዎን ያግኙ። ጊዜውን የእርስዎ ያድርጉት።',
    'Tapha kee argadhu. Yeroo kee taasifadhu.',
    'ጸወታኻ ርኸብ። እዋንካ ግበሮ።',
    'Hel ciyaartaada. Ka dhig waqtigaaga.',
    'اعثر على لعبتك. اجعلها لحظتك.',
    'Pata mchezo wako. Ufanye kuwa wakati wako.',
    'Trouvez votre jeu. Vivez votre instant.'
  ),
  Finished: tr('ተጠናቋል', 'Xumurameera', 'ተዛዚሙ', 'Wuu dhammaaday', 'انتهى', 'Imekamilika', 'Terminé'),
  'First ball': tr(
    'የመጀመሪያ ኳስ',
    'Kubbaa jalqabaa',
    'ቀዳመይቲ ኩዕሶ',
    'Kubbadda koowaad',
    'الكرة الأولى',
    'Mpira wa kwanza',
    'Première boule'
  ),
  'First to last': tr(
    'ከመጀመሪያ እስከ መጨረሻ',
    'Jalqabaa hanga dhumaatti',
    'ካብ ቀዳማይ ክሳብ መወዳእታ',
    'Koowaad ilaa ugu dambeeya',
    'من الأول إلى الأخير',
    'Wa kwanza hadi wa mwisho',
    'Du premier au dernier'
  ),
  'Fixed gross odds': tr(
    'ቋሚ ጠቅላላ የክፍያ ማባዣዎች',
    'Baayʼistoota kaffaltii waliigalaa dhaabbataa',
    'ቀወምቲ ጠቕላላ መባዝሕቲ ክፍሊት',
    'Isku-dhufteyaal guud oo goʼan',
    'معاملات عائد إجمالي ثابتة',
    'Vizidishi vya malipo ghafi vilivyowekwa',
    'Cotes brutes fixes'
  ),
  'Flight in progress · server confirms cash-out': tr(
    'በረራ በሂደት ላይ · አገልጋዩ መውጣትን ያረጋግጣል',
    'Balaliʼiin adeemsa irra · sarvariin kaffaltii fudhachuu mirkaneessa',
    'በረራ ይቕጽል ኣሎ · ሰርቨር ምውጻእ የረጋግጽ',
    'Duulimaadku wuu socdaa · serfarku xaqiijiyaa lacag-bixitaanka',
    'الطيران جارٍ · الخادم يؤكد الصرف',
    'Safari inaendelea · seva huthibitisha kuchukua malipo',
    'Vol en cours · le serveur confirme lʼencaissement'
  ),
  'Follow every ball.': tr(
    'እያንዳንዱን ኳስ ይከታተሉ።',
    'Kubbaa hunda hordofi.',
    'ንነፍሲ ወከፍ ኩዕሶ ተኸታተል።',
    'La soco kubbad kasta.',
    'تابع كل كرة.',
    'Fuatilia kila mpira.',
    'Suivez chaque boule.'
  ),
  'Follow race': tr(
    'ውድድሩን ይከታተሉ',
    'Fiigicha hordofi',
    'ውድድር ተኸታተል',
    'La soco tartanka',
    'تابع السباق',
    'Fuatilia mbio',
    'Suivre la course'
  ),
  'Follow the curve. Choose your moment.': tr(
    'መስመሩን ይከታተሉ። ጊዜዎን ይምረጡ።',
    'Sarara hordofi. Yeroo kee filadhu.',
    'ነቲ መስመር ተኸታተል። ግዜኻ ምረጽ።',
    'La soco khadka. Dooro waqtigaaga.',
    'تابع المنحنى. اختر لحظتك.',
    'Fuatilia mkunjo. Chagua wakati wako.',
    'Suivez la courbe. Choisissez votre instant.'
  ),
  Football: tr(
    'እግር ኳስ',
    'Kubbaa Miilaa',
    'ኩዕሶ እግሪ',
    'Kubadda Cagta',
    'كرة القدم',
    'Mpira wa Miguu',
    'Football'
  ),
  'Free practice': tr(
    'ነፃ ልምምድ',
    'Shaakala bilisaa',
    'ነጻ ልምምድ',
    'Tababar bilaash ah',
    'تدريب مجاني',
    'Mazoezi ya bure',
    'Entraînement gratuit'
  ),
  'Free practice only': tr(
    'ነፃ ልምምድ ብቻ',
    'Shaakala bilisaa qofa',
    'ነጻ ልምምድ ጥራይ',
    'Tababar bilaash ah oo keliya',
    'تدريب مجاني فقط',
    'Mazoezi ya bure pekee',
    'Entraînement gratuit uniquement'
  ),
  'Free to play · no stakes or cash prizes.': tr(
    'በነፃ ይጫወቱ · የውርርድ ገንዘብ ወይም የገንዘብ ሽልማት የለም።',
    'Bilisa taphadhu · maallaqni sharaddii yookaan badhaasni maallaqaa hin jiru.',
    'ብነጻ ተጻወት · መጠን ውርርድ ወይ ሽልማት ገንዘብ የለን።',
    'Ciyaar bilaash ah · ma jiraan lacag sharad ama abaalmarin lacageed.',
    'لعب مجاني · بلا مبالغ رهان أو جوائز نقدية.',
    'Cheza bure · hakuna dau au zawadi za pesa.',
    'Jeu gratuit · sans mises ni prix en argent.'
  ),
  'Full time': tr(
    'ጨዋታው ተጠናቋል',
    'Yeroon guutuu xumurame',
    'ጸወታ ተዛዚሙ',
    'Waqtigii buuxay',
    'نهاية المباراة',
    'Muda kamili',
    'Fin du match'
  ),
  'Full time · {value}': tr(
    'ጨዋታው ተጠናቋል · {value}',
    'Yeroon guutuu xumurame · {value}',
    'ጸወታ ተዛዚሙ · {value}',
    'Waqtigii buuxay · {value}',
    'نهاية المباراة · {value}',
    'Muda kamili · {value}',
    'Fin du match · {value}'
  ),
  'Game History': tr(
    'የጨዋታ ታሪክ',
    'Seenaa Taphaa',
    'ታሪኽ ጸወታ',
    'Taariikhda Ciyaaraha',
    'سجل الألعاب',
    'Historia ya Michezo',
    'Historique des jeux'
  ),
  'Game categories': tr(
    'የጨዋታ ምድቦች',
    'Ramaddiiwwan taphaa',
    'ምድባት ጸወታ',
    'Qaybaha ciyaaraha',
    'فئات الألعاب',
    'Makundi ya michezo',
    'Catégories de jeux'
  ),
  'Game sections': tr(
    'የጨዋታ ክፍሎች',
    'Kutaalee taphaa',
    'ክፍልታት ጸወታ',
    'Qaybaha ciyaarta',
    'أقسام اللعبة',
    'Sehemu za mchezo',
    'Sections du jeu'
  ),
  'Get a confirmed result': tr(
    'የተረጋገጠ ውጤት ያግኙ',
    'Buʼaa mirkanaaʼe argadhu',
    'ዝተረጋገጸ ውጽኢት ርኸብ',
    'Hel natiijo la xaqiijiyey',
    'احصل على نتيجة مؤكدة',
    'Pata matokeo yaliyothibitishwa',
    'Obtenir un résultat confirmé'
  ),
  'Got it': tr('ገባኝ', 'Hubadheera', 'ተረዲአ', 'Waan fahmay', 'فهمت', 'Nimeelewa', 'Compris'),
  'Gross return': tr(
    'ጠቅላላ ተመላሽ',
    'Deebii waliigalaa',
    'ጠቕላላ ተመላሲ',
    'Soo-noqoshada guud',
    'العائد الإجمالي',
    'Malipo ghafi',
    'Retour brut'
  ),
  'Guess accepted': tr(
    'ግምቱ ተቀባይነት አግኝቷል',
    'Tilmaamni fudhatameera',
    'ግምት ተቐቢሉ',
    'Qiyaasta waa la aqbalay',
    'قُبل التخمين',
    'Kadirio limekubaliwa',
    'Nombre accepté'
  ),
  'Guess accepted: {guess}': tr(
    'ግምቱ ተቀባይነት አግኝቷል፦ {guess}',
    'Tilmaamni fudhatameera: {guess}',
    'ግምት ተቐቢሉ፦ {guess}',
    'Qiyaasta waa la aqbalay: {guess}',
    'قُبل التخمين: {guess}',
    'Kadirio limekubaliwa: {guess}',
    'Nombre accepté : {guess}'
  ),
  'Guess placed': tr(
    'ግምቱ ተመዝግቧል',
    'Tilmaamni galmaaʼeera',
    'ግምት ተመዝጊቡ',
    'Qiyaasta waa la geliyey',
    'تم تسجيل التخمين',
    'Kadirio limewekwa',
    'Nombre enregistré'
  ),
  'How the return works': tr(
    'ተመላሹ እንዴት እንደሚሠራ',
    'Deebiin akkamitti akka hojjetu',
    'ተመላሲ ከመይ ይሰርሕ',
    'Sida soo-noqoshadu u shaqayso',
    'كيف يعمل العائد',
    'Jinsi malipo yanavyofanya kazi',
    'Fonctionnement du retour'
  ),
  'How to play': tr(
    'እንዴት መጫወት እንደሚቻል',
    'Akkaataa taphachuu',
    'ከመይ ትጻወት',
    'Sida loo ciyaaro',
    'طريقة اللعب',
    'Jinsi ya kucheza',
    'Comment jouer'
  ),
  'How to play & fairness': tr(
    'የጨዋታ መመሪያ እና ፍትሃዊነት',
    'Akkaataa taphachuu fi haqa',
    'ኣጻዋውታን ፍትሓውነትን',
    'Sida loo ciyaaro iyo caddaaladda',
    'طريقة اللعب والإنصاف',
    'Jinsi ya kucheza na usawa',
    'Règles et équité'
  ),
  'How to play Blackjack': tr(
    'ብላክጃክን እንዴት መጫወት እንደሚቻል',
    'Akkaataa Bilaakjaakii taphachuu',
    'ብላክጃክ ከመይ ትጻወት',
    'Sida loo ciyaaro Blackjack',
    'طريقة لعب البلاك جاك',
    'Jinsi ya kucheza Blackjack',
    'Comment jouer au blackjack'
  ),
  'How to play Lucky Six': tr(
    'ዕድለኛ ስድስትን እንዴት መጫወት እንደሚቻል',
    'Akkaataa Jaʼa Milkaaʼaa taphachuu',
    'ዕድለኛ ሽዱሽተ ከመይ ትጻወት',
    'Sida loo ciyaaro Lixda Nasiibka',
    'طريقة لعب الستة المحظوظة',
    'Jinsi ya kucheza Sita za Bahati',
    'Comment jouer aux Six chanceux'
  ),
  'How to play Roulette Keno': tr(
    'ሩሌት ኬኖን እንዴት መጫወት እንደሚቻል',
    'Akkaataa Ruuleetii Keno taphachuu',
    'ሩሌት ኬኖ ከመይ ትጻወት',
    'Sida loo ciyaaro Ruuleet Keno',
    'طريقة لعب روليت كينو',
    'Jinsi ya kucheza Ruleti Keno',
    'Comment jouer à Roulette Keno'
  ),
  'How to play ↗': tr(
    'የጨዋታ መመሪያ ↗',
    'Akkaataa taphachuu ↗',
    'ከመይ ትጻወት ↗',
    'Sida loo ciyaaro ↗',
    'طريقة اللعب ↗',
    'Jinsi ya kucheza ↗',
    'Comment jouer ↗'
  ),
  'In play': tr(
    'በጨዋታ ላይ',
    'Tapha irra',
    'ኣብ ጸወታ',
    'Ciyaar baa socota',
    'قيد اللعب',
    'Inaendelea',
    'En jeu'
  ),
  'Increase amount': tr(
    'መጠኑን ይጨምሩ',
    'Hanga dabali',
    'መጠን ወስኽ',
    'Kordhi qadarka',
    'زيادة المبلغ',
    'Ongeza kiasi',
    'Augmenter le montant'
  ),
  'Increase bet amount': tr(
    'የውርርድ መጠኑን ይጨምሩ',
    'Hanga sharaddii dabali',
    'መጠን ውርርድ ወስኽ',
    'Kordhi qadarka sharadka',
    'زيادة مبلغ الرهان',
    'Ongeza kiasi cha dau',
    'Augmenter le montant du pari'
  ),
  'Increase number': tr(
    'ቁጥሩን ይጨምሩ',
    'Lakkoofsa dabali',
    'ቁጽሪ ወስኽ',
    'Kordhi lambarka',
    'زيادة الرقم',
    'Ongeza namba',
    'Augmenter le nombre'
  ),
  'KNOW YOUR SCORE': tr(
    'ነጥብዎን ይወቁ',
    'QABXII KEE BEEKI',
    'ነጥብኻ ፍለጥ',
    'OGOW DHIBCAHAAGA',
    'اعرف نتيجتك',
    'JUA ALAMA ZAKO',
    'CONNAISSEZ VOTRE SCORE'
  ),
  'Keep editing': tr(
    'ማስተካከሉን ይቀጥሉ',
    'Gulaaluu itti fufi',
    'ምእራም ቀጽል',
    'Sii wad wax ka beddelka',
    'متابعة التعديل',
    'Endelea kuhariri',
    'Continuer la modification'
  ),
  Keno: tr('ኬኖ', 'Keno', 'ኬኖ', 'Keno', 'كينو', 'Keno', 'Keno'),
  'Keno ball machine ready': tr(
    'የኬኖ ኳስ ማሽን ዝግጁ ነው',
    'Maashiniin kubbaa Keno qophaaʼeera',
    'ማሽን ኩዕሶ ኬኖ ድሉው እዩ',
    'Mashiinka kubbadaha Keno waa diyaar',
    'آلة كرات كينو جاهزة',
    'Mashine ya mipira ya Keno iko tayari',
    'Machine à boules Keno prête'
  ),
  'Keno draw': tr(
    'የኬኖ ዕጣ',
    'Baafama Keno',
    'ዕጫ ኬኖ',
    'Soo saarista Keno',
    'سحب كينو',
    'Droo ya Keno',
    'Tirage Keno'
  ),
  'Keno tickets': tr(
    'የኬኖ ትኬቶች',
    'Tikeetota Keno',
    'ትኬታት ኬኖ',
    'Tigidhada Keno',
    'تذاكر كينو',
    'Tiketi za Keno',
    'Tickets Keno'
  ),
  'LATEST COMPLETED RACE': tr(
    'የመጨረሻው የተጠናቀቀ ውድድር',
    'FIIGICHA DHUMA XUMURAME',
    'ዝሓለፈ ዝተዛዘመ ውድድር',
    'TARTANKII UGU DAMBEEYEY EE DHAMMAADAY',
    'آخر سباق مكتمل',
    'MBIO ZA MWISHO ZILIZOKAMILIKA',
    'DERNIÈRE COURSE TERMINÉE'
  ),
  'LATEST DRAWN BALL': tr(
    'በመጨረሻ የወጣች ኳስ',
    'KUBBAA DHUMAA BAAFAMTE',
    'መወዳእታ ዝወጸት ኩዕሶ',
    'KUBBADDII UGU DAMBEEYEY EE LA SOO SAARAY',
    'آخر كرة مسحوبة',
    'MPIRA WA MWISHO ULIOTOLEWA',
    'DERNIÈRE BOULE TIRÉE'
  ),
  'LIVE BALL REVEAL': tr(
    'የኳስ ቀጥታ ማሳያ',
    'KUBBAA KALLATTIIN MULʼISUU',
    'ቀጥታ ምግላጽ ኩዕሶ',
    'MUUJINTA TOOSKA AH EE KUBBADDA',
    'كشف الكرات مباشرة',
    'KUONYESHA MPIRA MOJA KWA MOJA',
    'RÉVÉLATION DES BOULES EN DIRECT'
  ),
  'LIVE DRAW CHAMBER': tr(
    'የቀጥታ ዕጣ ክፍል',
    'KUTAA BAAFAMA KALLATTII',
    'ክፍሊ ቀጥታ ዕጫ',
    'QOLKA SOO SAARISTA TOOSKA AH',
    'حجرة السحب المباشر',
    'CHUMBA CHA DROO YA MOJA KWA MOJA',
    'CHAMBRE DE TIRAGE EN DIRECT'
  ),
  'LIVE MULTIPLIER': tr(
    'የቀጥታ ማባዣ',
    'BAAYʼISAA KALLATTII',
    'ቀጥታ መባዝሒ',
    'ISKU-DHUFTEHA TOOSKA AH',
    'المضاعف المباشر',
    'KIZIDISHI CHA MOJA KWA MOJA',
    'MULTIPLICATEUR EN DIRECT'
  ),
  'LIVE PRACTICE': tr(
    'ቀጥታ ልምምድ',
    'SHAAKALA KALLATTII',
    'ቀጥታ ልምምድ',
    'TABABAR TOOS AH',
    'تدريب مباشر',
    'MAZOEZI YA MOJA KWA MOJA',
    'ENTRAÎNEMENT EN DIRECT'
  ),
  'LIVE PUBLISHED POSITIONS': tr(
    'በቀጥታ የታወቁ ደረጃዎች',
    'SADARKAALEE KALLATTIIN MAXXANFAMAN',
    'ብቐጥታ ዝተገልጹ ደረጃታት',
    'KAALMAHA TOOS LOO SHAACIYEY',
    'الترتيب المنشور مباشرة',
    'NAFASI ZILIZOCHAPISHWA MOJA KWA MOJA',
    'POSITIONS PUBLIÉES EN DIRECT'
  ),
  'Last 15 results': tr(
    'ያለፉት 15 ውጤቶች',
    'Buʼaawwan 15 dhumaa',
    'ዝሓለፉ 15 ውጽኢታት',
    '15-kii natiijo ee ugu dambeeyey',
    'آخر 15 نتيجة',
    'Matokeo 15 ya mwisho',
    '15 derniers résultats'
  ),
  'Last completed matchweek · {value}': tr(
    'ያለፈው የተጠናቀቀ የጨዋታ ሳምንት · {value}',
    'Torban taphaa dhuma xumurame · {value}',
    'ዝሓለፈ ዝተዛዘመ ሰሙን ጸወታ · {value}',
    'Toddobaadkii kulan ee ugu dambeeyey ee dhammaaday · {value}',
    'آخر أسبوع مباريات مكتمل · {value}',
    'Wiki ya mechi ya mwisho iliyokamilika · {value}',
    'Dernière journée terminée · {value}'
  ),
  'Latest drawn ball {number}': tr(
    'በመጨረሻ የወጣች ኳስ {number}',
    'Kubbaa dhumaa baafamte {number}',
    'መወዳእታ ዝወጸት ኩዕሶ {number}',
    'Kubbaddii ugu dambeysay ee la soo saaray {number}',
    'آخر كرة مسحوبة {number}',
    'Mpira wa mwisho uliotolewa {number}',
    'Dernière boule tirée {number}'
  ),
  'Latest winner': tr(
    'የቅርብ ጊዜ አሸናፊ',
    'Moʼataa dhumaa',
    'ዝሓለፈ ተዓዋታይ',
    'Guuleystihii ugu dambeeyey',
    'آخر فائز',
    'Mshindi wa mwisho',
    'Dernier gagnant'
  ),
  'Leaderboard unavailable. Reconnecting…': tr(
    'የደረጃ ሰንጠረዡ አይገኝም። ዳግም በማገናኘት ላይ…',
    'Gabateen sadarkaa hin argamu. Deebiʼee walqunnamaa jira…',
    'ሰሌዳ ደረጃ ኣይርከብን። ዳግማይ ይራኸብ ኣሎ…',
    'Liiska kala sarreynta lama heli karo. Dib ayaa loo xirmayaa…',
    'لوحة المتصدرين غير متاحة. جارٍ إعادة الاتصال…',
    'Jedwali la viwango halipatikani. Inaunganisha tena…',
    'Classement indisponible. Reconnexion…'
  ),
  'Live flight arena': tr(
    'የቀጥታ በረራ መድረክ',
    'Dirree balaliʼii kallattii',
    'መድረኽ ቀጥታ በረራ',
    'Goobta duulimaadka tooska ah',
    'ساحة الطيران المباشر',
    'Uwanja wa safari ya moja kwa moja',
    'Arène de vol en direct'
  ),
  'Live multiplier': tr(
    'የቀጥታ ማባዣ',
    'Baayʼisaa kallattii',
    'ቀጥታ መባዝሒ',
    'Isku-dhufteha tooska ah',
    'المضاعف المباشر',
    'Kizidishi cha moja kwa moja',
    'Multiplicateur en direct'
  ),
  'Live multiplier graph': tr(
    'የቀጥታ ማባዣ ግራፍ',
    'Giraafii baayʼisaa kallattii',
    'ግራፍ ቀጥታ መባዝሒ',
    'Jaantuska isku-dhufteha tooska ah',
    'رسم المضاعف المباشر',
    'Grafu ya kizidishi cha moja kwa moja',
    'Graphique du multiplicateur en direct'
  ),
  'Live practice draw': tr(
    'የቀጥታ ልምምድ ዕጣ',
    'Baafama shaakalaa kallattii',
    'ቀጥታ ዕጫ ልምምድ',
    'Soo saarista tababarka tooska ah',
    'سحب تدريب مباشر',
    'Droo ya mazoezi ya moja kwa moja',
    'Tirage dʼentraînement en direct'
  ),
  'Load published proof': tr(
    'የታተመውን ማስረጃ ጫን',
    'Ragaa maxxanfame feʼi',
    'ዝተሓትመ መርትዖ ጽዓን',
    'Soo geli caddeynta la daabacay',
    'تحميل الإثبات المنشور',
    'Pakia uthibitisho uliochapishwa',
    'Charger la preuve publiée'
  ),
  'Load timestamp archive': tr(
    'የጊዜ ማህተም ማህደርን ጫን',
    'Kuusaa mallattoo yeroo feʼi',
    'መዝገብ ማሕተም ግዜ ጽዓን',
    'Soo geli kaydka calaamadda waqtiga',
    'تحميل أرشيف الطابع الزمني',
    'Pakia kumbukumbu ya muhuri wa muda',
    'Charger lʼarchive dʼhorodatage'
  ),
  'Loading activity…': tr(
    'እንቅስቃሴ በመጫን ላይ…',
    'Sochii feʼaa jira…',
    'ንጥፈት ይጽዕን ኣሎ…',
    'Dhaqdhaqaaqa waa la soo gelinayaa…',
    'جارٍ تحميل النشاط…',
    'Inapakia shughuli…',
    'Chargement de lʼactivité…'
  ),
  'Loading game availability…': tr(
    'የጨዋታ አቅርቦት በመጫን ላይ…',
    'Argama taphaa feʼaa jira…',
    'ምርካብ ጸወታ ይጽዕን ኣሎ…',
    'Helitaanka ciyaarta waa la soo gelinayaa…',
    'جارٍ تحميل توفر الألعاب…',
    'Inapakia upatikanaji wa michezo…',
    'Chargement de la disponibilité des jeux…'
  ),
  'Loading games…': tr(
    'ጨዋታዎች በመጫን ላይ…',
    'Taphoota feʼaa jira…',
    'ጸወታታት ይጽዕን ኣሎ…',
    'Ciyaaraha waa la soo gelinayaa…',
    'جارٍ تحميل الألعاب…',
    'Inapakia michezo…',
    'Chargement des jeux…'
  ),
  'Loading leaderboard…': tr(
    'የደረጃ ሰንጠረዥ በመጫን ላይ…',
    'Gabatee sadarkaa feʼaa jira…',
    'ሰሌዳ ደረጃ ይጽዕን ኣሎ…',
    'Liiska kala sarreynta waa la soo gelinayaa…',
    'جارٍ تحميل لوحة المتصدرين…',
    'Inapakia jedwali la viwango…',
    'Chargement du classement…'
  ),
  'Loading practice…': tr(
    'ልምምድ በመጫን ላይ…',
    'Shaakala feʼaa jira…',
    'ልምምድ ይጽዕን ኣሎ…',
    'Tababarka waa la soo gelinayaa…',
    'جارٍ تحميل التدريب…',
    'Inapakia mazoezi…',
    'Chargement de lʼentraînement…'
  ),
  Loses: tr('ይሸነፋል', 'Ni moʼama', 'ይስዓር', 'Wuu khasaarayaa', 'يخسر', 'Inashindwa', 'Perd'),
  Lucky: tr('ዕድለኛ', 'Milkaaʼaa', 'ዕድለኛ', 'Nasiib leh', 'محظوظ', 'Ya Bahati', 'Chanceux'),
  'Lucky Spin': tr(
    'ዕድለኛ ሽክርክሪት',
    'Naannawaa Milkaaʼaa',
    'ዕድለኛ ዙር',
    'Wareegga Nasiibka',
    'الدوران المحظوظ',
    'Mzunguko wa Bahati',
    'Roue chanceuse'
  ),
  'MIXING & REVEALING': tr(
    'በማቀላቀል እና በማሳየት ላይ',
    'MAKUU FI MULʼISUU',
    'ምሕዋስን ምግላጽን',
    'ISKU QASID IYO MUUJIN',
    'خلط وكشف',
    'KUCHANGANYA NA KUONYESHA',
    'MÉLANGE ET RÉVÉLATION'
  ),
  'Make your entry': tr(
    'ተሳትፎዎን ያስገቡ',
    'Hirmaannaa kee galchi',
    'ተሳትፎኻ ኣእቱ',
    'Geli ka qaybgalkaaga',
    'سجّل مشاركتك',
    'Weka ushiriki wako',
    'Enregistrez votre participation'
  ),
  'Make your play': tr(
    'ጨዋታዎን ይጀምሩ',
    'Tapha kee jalqabi',
    'ጸወታኻ ጀምር',
    'Samee ciyaartaada',
    'ابدأ لعبك',
    'Anza mchezo wako',
    'À vous de jouer'
  ),
  'Manual only': tr(
    'በእጅ ብቻ',
    'Harkaan qofa',
    'ብኢድ ጥራይ',
    'Gacanta oo keliya',
    'يدوي فقط',
    'Kwa mkono pekee',
    'Manuel uniquement'
  ),
  Market: tr(
    'የውርርድ ገበያ',
    'Gabaa sharaddii',
    'ዕዳጋ ውርርድ',
    'Suuqa sharadka',
    'السوق',
    'Soko',
    'Marché'
  ),
  'Market category': tr(
    'የውርርድ ገበያ ምድብ',
    'Ramaddii gabaa sharaddii',
    'ምድብ ዕዳጋ ውርርድ',
    'Qaybta suuqa sharadka',
    'فئة السوق',
    'Kundi la soko',
    'Catégorie du marché'
  ),
  Match: tr(
    'ተዛማጅ',
    'Walsimannaa',
    'ዝተዛመደ',
    'Iswaafajin',
    'مطابقة',
    'Inayolingana',
    'Correspondance'
  ),
  'Match view': tr(
    'የጨዋታ እይታ',
    'Mulʼata taphaa',
    'ርእይቶ ጸወታ',
    'Muuqaalka kulanka',
    'عرض المباراة',
    'Mwonekano wa mechi',
    'Vue du match'
  ),
  'Match view of {value}': tr(
    'የ{value} ጨዋታ እይታ',
    'Mulʼata taphaa {value}',
    'ርእይቶ ጸወታ {value}',
    'Muuqaalka kulanka {value}',
    'عرض مباراة {value}',
    'Mwonekano wa mechi ya {value}',
    'Vue du match de {value}'
  ),
  'Matches this week': tr(
    'የዚህ ሳምንት ጨዋታዎች',
    'Taphoota torban kanaa',
    'ጸወታታት ናይዚ ሰሙን',
    'Kulamada toddobaadkan',
    'مباريات هذا الأسبوع',
    'Mechi za wiki hii',
    'Matchs de cette semaine'
  ),
  'Matches your saved commitment.': tr(
    'ከተቀመጠው ቅድመ ማረጋገጫዎ ጋር ይዛመዳል።',
    'Ragaa duraa kee kuufame waliin walsima.',
    'ምስ ዝተዓቀበ ቅድመ መረጋገጺኻ ይዛመድ።',
    'Waxay la mid tahay xaqiijintaadii hore ee kaydsan.',
    'يطابق التزامك المحفوظ.',
    'Inalingana na uthibitisho wako wa awali uliohifadhiwa.',
    'Correspond à votre engagement enregistré.'
  ),
  'More options': tr(
    'ተጨማሪ አማራጮች',
    'Filannoowwan dabalataa',
    'ተወሰኽቲ ኣማራጺታት',
    'Ikhtiyaarro dheeraad ah',
    'خيارات أخرى',
    'Chaguo zaidi',
    'Plus dʼoptions'
  ),
  'My recent tickets': tr(
    'የቅርብ ጊዜ ትኬቶቼ',
    'Tikeetota koo dhiyoo',
    'ናይ ቀረባ ግዜ ትኬታተይ',
    'Tigidhadaydii dhowaa',
    'تذاكري الأخيرة',
    'Tiketi zangu za karibuni',
    'Mes tickets récents'
  ),
  'Natural blackjack': tr(
    'የመጀመሪያ ሁለት ካርድ ብላክጃክ',
    'Bilaakjaakii kaardii lamaa jalqabaa',
    'ብቐዳሞት ክልተ ካርታታት ብላክጃክ',
    'Blackjack labada kaar ee hore',
    'بلاك جاك طبيعي',
    'Blackjack ya kadi mbili za kwanza',
    'Blackjack naturel'
  ),
  'New draw every 90 seconds': tr(
    'በየ90 ሰከንዱ አዲስ ዕጣ',
    'Sekondii 90n baafama haaraa',
    'ኣብ ነፍሲ ወከፍ 90 ካልኢታት ሓድሽ ዕጫ',
    'Soo saarid cusub 90 ilbiriqsi kasta',
    'سحب جديد كل 90 ثانية',
    'Droo mpya kila sekunde 90',
    'Nouveau tirage toutes les 90 secondes'
  ),
  'Next deal': tr(
    'የሚቀጥለው የካርድ ስርጭት',
    'Qoodinsa kaardii itti aanu',
    'ቀጻሊ ዕደላ ካርታ',
    'Qaybinta kaararka ee xigta',
    'التوزيع التالي',
    'Ugawaji unaofuata',
    'Prochaine donne'
  ),
  'Next draw': tr(
    'ቀጣዩ ዕጣ',
    'Baafama itti aanu',
    'ቀጻሊ ዕጫ',
    'Soo saarista xigta',
    'السحب التالي',
    'Droo inayofuata',
    'Prochain tirage'
  ),
  'Next draw pending': tr(
    'ቀጣዩ ዕጣ በጥበቃ ላይ ነው',
    'Baafamni itti aanu eegaa jira',
    'ቀጻሊ ዕጫ ይጽበ ኣሎ',
    'Soo saarista xigta waa la sugayaa',
    'السحب التالي قيد الانتظار',
    'Droo inayofuata inasubiri',
    'Prochain tirage en attente'
  ),
  'Next entry in {seconds}s': tr(
    'ቀጣዩ ተሳትፎ በ{seconds} ሰከንዶች',
    'Seensa itti aanu sekondii {seconds} booda',
    'ቀጻሊ ተሳትፎ ድሕሪ {seconds} ካልኢታት',
    'Gelitaanka xiga {seconds} ilbiriqsi gudahood',
    'المشاركة التالية بعد {seconds} ثانية',
    'Usajili unaofuata baada ya sekunde {seconds}',
    'Prochaine inscription dans {seconds} s'
  ),
  'Next race': tr(
    'ቀጣዩ ውድድር',
    'Fiigicha itti aanu',
    'ቀጻሊ ውድድር',
    'Tartanka xiga',
    'السباق التالي',
    'Mbio zinazofuata',
    'Prochaine course'
  ),
  'Next round': tr(
    'ቀጣዩ ዙር',
    'Marsaa itti aanu',
    'ቀጻሊ ዙር',
    'Wareegga xiga',
    'الجولة التالية',
    'Raundi inayofuata',
    'Prochaine manche'
  ),
  'Next round in': tr(
    'ቀጣዩ ዙር የሚጀምርበት ቀሪ ጊዜ',
    'Marsaan itti aanu',
    'ንቀጻሊ ዙር ዝተረፈ',
    'Wareegga xiga wuxuu bilaabmaa',
    'الجولة التالية خلال',
    'Raundi inayofuata baada ya',
    'Prochaine manche dans'
  ),
  'No cash stakes · No cash prizes': tr(
    'የገንዘብ ውርርድ የለም · የገንዘብ ሽልማት የለም',
    'Sharaddiin maallaqaa hin jiru · Badhaasni maallaqaa hin jiru',
    'ውርርድ ገንዘብ የለን · ሽልማት ገንዘብ የለን',
    'Ma jiro sharad lacageed · Ma jiraan abaalmarinno lacageed',
    'بلا رهانات نقدية · بلا جوائز نقدية',
    'Hakuna dau za pesa · Hakuna zawadi za pesa',
    'Aucune mise en argent · Aucun prix en argent'
  ),
  'No completed draws yet.': tr(
    'እስካሁን የተጠናቀቀ ዕጣ የለም።',
    'Hanga ammaatti baafamni xumurame hin jiru.',
    'ክሳብ ሕጂ ዝተዛዘመ ዕጫ የለን።',
    'Weli ma jiro soo saarid dhammaatay.',
    'لا توجد سحوبات مكتملة بعد.',
    'Hakuna droo iliyokamilika bado.',
    'Aucun tirage terminé pour le moment.'
  ),
  'No confirmed returns in the last 24 hours.': tr(
    'ባለፉት 24 ሰዓታት የተረጋገጡ ተመላሾች የሉም።',
    'Saʼaatii 24 darban keessatti deebiin mirkanaaʼe hin jiru.',
    'ኣብ ዝሓለፉ 24 ሰዓታት ዝተረጋገጸ ተመላሲ የለን።',
    'Ma jiraan soo-noqoshooyin la xaqiijiyey 24-kii saac ee la soo dhaafay.',
    'لا توجد عوائد مؤكدة خلال آخر 24 ساعة.',
    'Hakuna malipo yaliyothibitishwa katika saa 24 zilizopita.',
    'Aucun retour confirmé au cours des dernières 24 heures.'
  ),
  'No earlier saved receipt was compared.': tr(
    'ቀደም ሲል የተቀመጠ ደረሰኝ አልተነጻጸረም።',
    'Nagaheen duraan kuufame hin madaalamne.',
    'ቅድሚ ሕጂ ዝተዓቀበ ቅብሊት ኣይተነጻጸረን።',
    'Lama barbar dhigin rasiid hore oo kaydsan.',
    'لم تتم المقارنة بإيصال محفوظ سابقًا.',
    'Hakuna risiti iliyohifadhiwa awali iliyolinganishwa.',
    'Aucun reçu enregistré auparavant nʼa été comparé.'
  ),
  'No games yet. Head to the Games hub to play!': tr(
    'እስካሁን ጨዋታ የለም። ለመጫወት ወደ ጨዋታዎች ማዕከል ይሂዱ!',
    'Ammaaf taphoonni hin jiran. Taphachuuf gara wiirtuu taphootaatti deemi!',
    'ክሳብ ሕጂ ጸወታ የለን። ንምጽዋት ናብ ማእከል ጸወታታት ኪድ!',
    'Weli ciyaaro ma jiraan. Aad xarunta ciyaaraha si aad u ciyaarto!',
    'لا توجد ألعاب بعد. توجّه إلى مركز الألعاب للعب!',
    'Hakuna michezo bado. Nenda kwenye kituo cha michezo kucheza!',
    'Aucun jeu pour le moment. Rendez-vous dans lʼespace Jeux pour jouer !'
  ),
  'No goals released yet.': tr(
    'እስካሁን ጎሎች አልታወቁም።',
    'Hanga ammaatti galchi hin maxxanfamne.',
    'ክሳብ ሕጂ ሸቶታት ኣይተገልጹን።',
    'Weli goolal lama shaacin.',
    'لم تُعلن أهداف بعد.',
    'Hakuna mabao yaliyotangazwa bado.',
    'Aucun but publié pour le moment.'
  ),
  'No ticket': tr(
    'ትኬት የለም',
    'Tikeetiin hin jiru',
    'ትኬት የለን',
    'Tigidh ma jiro',
    'لا توجد تذكرة',
    'Hakuna tiketi',
    'Aucun ticket'
  ),
  'No tickets': tr(
    'ትኬቶች የሉም',
    'Tikeetonni hin jiran',
    'ትኬታት የለዉን',
    'Tigidho ma jiraan',
    'لا توجد تذاكر',
    'Hakuna tiketi',
    'Aucun ticket'
  ),
  'No tickets in the latest 12 rounds.': tr(
    'በመጨረሻዎቹ 12 ዙሮች ትኬቶች የሉም።',
    'Marsaalee 12 dhumaa keessatti tikeetonni hin jiran.',
    'ኣብ ዝሓለፉ 12 ዙራት ትኬታት የለዉን።',
    'Ma jiraan tigidho 12-kii wareeg ee ugu dambeeyey.',
    'لا توجد تذاكر في آخر 12 جولة.',
    'Hakuna tiketi katika raundi 12 za mwisho.',
    'Aucun ticket dans les 12 dernières manches.'
  ),
  'No tickets in this round.': tr(
    'በዚህ ዙር ትኬቶች የሉም።',
    'Marsaa kana keessatti tikeetonni hin jiran.',
    'ኣብዚ ዙር ትኬታት የለዉን።',
    'Ma jiraan tigidho wareeggan.',
    'لا توجد تذاكر في هذه الجولة.',
    'Hakuna tiketi katika raundi hii.',
    'Aucun ticket dans cette manche.'
  ),
  None: tr('ምንም', 'Homaa', 'ዋላ ሓደ', 'Midna', 'لا شيء', 'Hakuna', 'Aucun'),
  'Not enough practice ETB for this amount.': tr(
    'ለዚህ መጠን በቂ የልምምድ ETB የለም።',
    'Hanga kanaaf ETB shaakalaa gahaan hin jiru.',
    'ነዚ መጠን እኹል ናይ ልምምድ ETB የለን።',
    'ETB tababarka kuma filna qadarkan.',
    'رصيد ETB التدريبي غير كافٍ لهذا المبلغ.',
    'ETB za mazoezi hazitoshi kwa kiasi hiki.',
    'Solde ETB dʼentraînement insuffisant pour ce montant.'
  ),
  'Not enough practice ETB for this bet.': tr(
    'ለዚህ ውርርድ በቂ የልምምድ ETB የለም።',
    'Sharaddii kanaaf ETB shaakalaa gahaan hin jiru.',
    'ነዚ ውርርድ እኹል ናይ ልምምድ ETB የለን።',
    'ETB tababarka kuma filna sharadkan.',
    'رصيد ETB التدريبي غير كافٍ لهذا الرهان.',
    'ETB za mazoezi hazitoshi kwa dau hili.',
    'Solde ETB dʼentraînement insuffisant pour ce pari.'
  ),
  'Not enough practice ETB.': tr(
    'በቂ የልምምድ ETB የለም።',
    'ETB shaakalaa gahaan hin jiru.',
    'እኹል ናይ ልምምድ ETB የለን።',
    'ETB tababarka kuma filna.',
    'رصيد ETB التدريبي غير كافٍ.',
    'ETB za mazoezi hazitoshi.',
    'Solde ETB dʼentraînement insuffisant.'
  ),
  'Not used in practice': tr(
    'በልምምድ አይጠቀምም',
    'Shaakala keessatti hin fayyadamu',
    'ኣብ ልምምድ ኣይጥቀምን',
    'Laguma isticmaalo tababarka',
    'لا يُستخدم في التدريب',
    'Haitumiki kwenye mazoezi',
    'Non utilisé en entraînement'
  ),
  Number: tr('ቁጥር', 'Lakkoofsa', 'ቁጽሪ', 'Lambar', 'رقم', 'Namba', 'Numéro'),
};
export default catalogue;
