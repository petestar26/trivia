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
  Rolling: tr(
    'በመንከባለል ላይ',
    'Gangalachaa jira',
    'ይንከባለል ኣሎ',
    'Wuu rogmanayaa',
    'جارٍ الرمي',
    'Zinazunguka',
    'Lancer en cours'
  ),
  Roulette: tr('ሩሌት', 'Ruuleetii', 'ሩሌት', 'Ruuleet', 'روليت', 'Ruleti', 'Roulette'),
  Round: tr('ዙር', 'Marsaa', 'ዙር', 'Wareeg', 'جولة', 'Raundi', 'Manche'),
  'Round ID': tr(
    'የዙር መለያ',
    'Eenyummaa marsaa',
    'መለለዪ ዙር',
    'Aqoonsiga wareegga',
    'معرّف الجولة',
    'Kitambulisho cha raundi',
    'Identifiant de la manche'
  ),
  'Round commitment': tr(
    'የዙር ቅድመ ማረጋገጫ',
    'Ragaa duraa marsaa',
    'ቅድመ መረጋገጺ ዙር',
    'Xaqiijinta hore ee wareegga',
    'الالتزام المسبق للجولة',
    'Uthibitisho wa awali wa raundi',
    'Engagement préalable de la manche'
  ),
  'Round countdown': tr(
    'የዙር ቆጠራ',
    'Lakkoofsa yeroo marsaa',
    'ቆጸራ ግዜ ዙር',
    'Tirinta waqtiga wareegga',
    'العد التنازلي للجولة',
    'Hesabu ya muda wa raundi',
    'Compte à rebours de la manche'
  ),
  'Round finished · no return for this ticket': tr(
    'ዙሩ ተጠናቋል · ለዚህ ትኬት ተመላሽ የለም',
    'Marsaan xumurameera · tikeetii kanaaf deebiin hin jiru',
    'ዙር ተዛዚሙ · ነዚ ትኬት ተመላሲ የለን',
    'Wareeggu wuu dhammaaday · tigidhkan soo-noqosho ma leh',
    'انتهت الجولة · بلا عائد لهذه التذكرة',
    'Raundi imeisha · hakuna malipo kwa tiketi hii',
    'Manche terminée · aucun retour pour ce ticket'
  ),
  'Round history': tr(
    'የዙር ታሪክ',
    'Seenaa marsaa',
    'ታሪኽ ዙር',
    'Taariikhda wareegyada',
    'سجل الجولات',
    'Historia ya raundi',
    'Historique des manches'
  ),
  'Round proof JSON': tr(
    'የዙር ማስረጃ JSON',
    'JSON ragaa marsaa',
    'JSON መርትዖ ዙር',
    'JSON caddeynta wareegga',
    'إثبات الجولة بصيغة JSON',
    'JSON ya uthibitisho wa raundi',
    'JSON de preuve de la manche'
  ),
  'Round receipts': tr(
    'የዙር ደረሰኞች',
    'Nagaheewwan marsaa',
    'ቅብሊታት ዙር',
    'Rasiidyada wareegga',
    'إيصالات الجولة',
    'Risiti za raundi',
    'Reçus de la manche'
  ),
  'Round result': tr(
    'የዙር ውጤት',
    'Buʼaa marsaa',
    'ውጽኢት ዙር',
    'Natiijada wareegga',
    'نتيجة الجولة',
    'Matokeo ya raundi',
    'Résultat de la manche'
  ),
  'Round verification': tr(
    'የዙር ማረጋገጫ',
    'Mirkaneessa marsaa',
    'መረጋገጺ ዙር',
    'Xaqiijinta wareegga',
    'التحقق من الجولة',
    'Uthibitishaji wa raundi',
    'Vérification de la manche'
  ),
  'Round {roundId}': tr(
    'ዙር {roundId}',
    'Marsaa {roundId}',
    'ዙር {roundId}',
    'Wareeg {roundId}',
    'الجولة {roundId}',
    'Raundi {roundId}',
    'Manche {roundId}'
  ),
  'Round {sequence}': tr(
    'ዙር {sequence}',
    'Marsaa {sequence}',
    'ዙር {sequence}',
    'Wareeg {sequence}',
    'الجولة {sequence}',
    'Raundi {sequence}',
    'Manche {sequence}'
  ),
  'Round {sequence} · Result {value}': tr(
    'ዙር {sequence} · ውጤት {value}',
    'Marsaa {sequence} · Buʼaa {value}',
    'ዙር {sequence} · ውጽኢት {value}',
    'Wareeg {sequence} · Natiijo {value}',
    'الجولة {sequence} · النتيجة {value}',
    'Raundi {sequence} · Matokeo {value}',
    'Manche {sequence} · Résultat {value}'
  ),
  'Round-proof verifier': tr(
    'የዙር ማስረጃ ማረጋገጫ',
    'Mirkaneessaa ragaa marsaa',
    'መረጋገጺ መርትዖ ዙር',
    'Hubiyaha caddeynta wareegga',
    'أداة التحقق من إثبات الجولة',
    'Kikaguzi cha uthibitisho wa raundi',
    'Vérificateur de preuve de manche'
  ),
  'Rows A–F · 12 numbers each': tr(
    'ረድፎች A–F · በእያንዳንዱ 12 ቁጥሮች',
    'Tarreewwan A–F · tokkoon tokkoon lakkoofsota 12',
    'መስርዓት A–F · ነፍሲ ወከፎም 12 ቁጽርታት',
    'Safafka A–F · mid kasta 12 lambar',
    'الصفوف A–F · 12 رقمًا لكل صف',
    'Mistari A–F · namba 12 kila mmoja',
    'Lignes A–F · 12 numéros chacune'
  ),
  Rule: tr('ህግ', 'Seera', 'ሕጊ', 'Xeer', 'قاعدة', 'Kanuni', 'Règle'),
  'Rules & payouts': tr(
    'ህጎች እና ክፍያዎች',
    'Seerota fi kaffaltiiwwan',
    'ሕግታትን ክፍሊታትን',
    'Xeerarka iyo lacag-bixinta',
    'القواعد والمدفوعات',
    'Kanuni na malipo',
    'Règles et paiements'
  ),
  'Rules & recent server draws': tr(
    'ህጎች እና የቅርብ ጊዜ የአገልጋይ ዕጣዎች',
    'Seerota fi baafamoota sarvarii dhiyoo',
    'ሕግታትን ናይ ቀረባ ዕጫታት ሰርቨርን',
    'Xeerarka iyo soo saaristii dhowayd ee serfarka',
    'القواعد وسحوبات الخادم الأخيرة',
    'Kanuni na droo za karibuni za seva',
    'Règles et tirages récents du serveur'
  ),
  'Rules v{rulesVersion}': tr(
    'ህጎች እትም {rulesVersion}',
    'Seerota maxxansa {rulesVersion}',
    'ሕግታት ሕታም {rulesVersion}',
    'Xeerarka nooca {rulesVersion}',
    'القواعد الإصدار {rulesVersion}',
    'Kanuni toleo {rulesVersion}',
    'Règles v{rulesVersion}'
  ),
  'Rules, timing and round verification': tr(
    'ህጎች፣ ጊዜ እና የዙር ማረጋገጫ',
    'Seerota, yeroo fi mirkaneessa marsaa',
    'ሕግታት፣ ግዜን መረጋገጺ ዙርን',
    'Xeerarka, waqtiga iyo xaqiijinta wareegga',
    'القواعد والتوقيت والتحقق من الجولة',
    'Kanuni, muda na uthibitishaji wa raundi',
    'Règles, calendrier et vérification de la manche'
  ),
  'Runner progress': tr(
    'የሯጩ ሂደት',
    'Adeemsa fiigduu',
    'ምዕባለ ጎያዪ',
    'Horumarka orodyahanka',
    'تقدم المتسابق',
    'Maendeleo ya mkimbiaji',
    'Progression du concurrent'
  ),
  Running: tr('በሂደት ላይ', 'Adeemaa jira', 'ይካየድ ኣሎ', 'Wuu socdaa', 'جارٍ', 'Inaendelea', 'En cours'),
  'SALEM BET / EMERALD COURSE': tr(
    'SALEM BET / ኤመራልድ መንገድ',
    'SALEM BET / DAANDII EMERALD',
    'SALEM BET / መንገዲ ኤመራልድ',
    'SALEM BET / WADDADA EMERALD',
    'SALEM BET / مضمار إيميرالد',
    'SALEM BET / UWANJA WA EMERALD',
    'SALEM BET / PISTE EMERALD'
  ),
  'SALEM BET / SALEM OVAL': tr(
    'SALEM BET / ሳሌም ኦቫል',
    'SALEM BET / SALEM OVAL',
    'SALEM BET / ሳሌም ኦቫል',
    'SALEM BET / SALEM OVAL',
    'SALEM BET / سالم أوفال',
    'SALEM BET / SALEM OVAL',
    'SALEM BET / SALEM OVAL'
  ),
  'SALEM BET COLLECTION': tr(
    'የSALEM BET ስብስብ',
    'WALITTI QABAMA SALEM BET',
    'ስብስብ SALEM BET',
    'URURINTA SALEM BET',
    'مجموعة SALEM BET',
    'MKUSANYIKO WA SALEM BET',
    'COLLECTION SALEM BET'
  ),
  'SALEM BET ORIGINAL': tr(
    'የSALEM BET የራሱ ጨዋታ',
    'TAPHA OFII SALEM BET',
    'ናይ SALEM BET ጸወታ',
    'CIYAAR ASAL AH OO SALEM BET',
    'لعبة أصلية من SALEM BET',
    'MCHEZO ASILI WA SALEM BET',
    'CRÉATION SALEM BET'
  ),
  'SALEM BET ORIGINAL · FREE PRACTICE': tr(
    'የSALEM BET የራሱ ጨዋታ · ነፃ ልምምድ',
    'TAPHA OFII SALEM BET · SHAAKALA BILISAA',
    'ናይ SALEM BET ጸወታ · ነጻ ልምምድ',
    'CIYAAR ASAL AH OO SALEM BET · TABABAR BILAASH AH',
    'لعبة أصلية من SALEM BET · تدريب مجاني',
    'MCHEZO ASILI WA SALEM BET · MAZOEZI YA BURE',
    'CRÉATION SALEM BET · ENTRAÎNEMENT GRATUIT'
  ),
  'SALEM BET ORIGINALS': tr(
    'የSALEM BET የራሱ ጨዋታዎች',
    'TAPHOOTA OFII SALEM BET',
    'ናይ SALEM BET ጸወታታት',
    'CIYAARAHA ASALKA AH EE SALEM BET',
    'ألعاب SALEM BET الأصلية',
    'MICHEZO ASILI YA SALEM BET',
    'CRÉATIONS SALEM BET'
  ),
  'SALEM BET ORIGINALS / CRASH POINT': tr(
    'የSALEM BET ጨዋታዎች / ክራሽ ፖይንት',
    'TAPHOOTA SALEM BET / CRASH POINT',
    'ጸወታታት SALEM BET / ክራሽ ፖይንት',
    'CIYAARAHA SALEM BET / CRASH POINT',
    'ألعاب SALEM BET الأصلية / كراش بوينت',
    'MICHEZO ASILI YA SALEM BET / CRASH POINT',
    'CRÉATIONS SALEM BET / CRASH POINT'
  ),
  'SALEM BET ORIGINALS / SKY CRASH': tr(
    'የSALEM BET ጨዋታዎች / ስካይ ክራሽ',
    'TAPHOOTA SALEM BET / SKY CRASH',
    'ጸወታታት SALEM BET / ስካይ ክራሽ',
    'CIYAARAHA SALEM BET / SKY CRASH',
    'ألعاب SALEM BET الأصلية / سكاي كراش',
    'MICHEZO ASILI YA SALEM BET / SKY CRASH',
    'CRÉATIONS SALEM BET / SKY CRASH'
  ),
  'SALEM BET ORIGINALS · SYSTEM TABLE': tr(
    'የSALEM BET ጨዋታዎች · የስርዓት ጠረጴዛ',
    'TAPHOOTA SALEM BET · MINJAALA SIRNAA',
    'ጸወታታት SALEM BET · ጠረጴዛ ስርዓት',
    'CIYAARAHA SALEM BET · MIISKA NIDAAMKA',
    'ألعاب SALEM BET الأصلية · طاولة النظام',
    'MICHEZO ASILI YA SALEM BET · MEZA YA MFUMO',
    'CRÉATIONS SALEM BET · TABLE SYSTÈME'
  ),
  'SALEM BET · PRACTICE ONLY': tr(
    'SALEM BET · ልምምድ ብቻ',
    'SALEM BET · SHAAKALA QOFA',
    'SALEM BET · ልምምድ ጥራይ',
    'SALEM BET · TABABAR OO KELIYA',
    'SALEM BET · تدريب فقط',
    'SALEM BET · MAZOEZI PEKEE',
    'SALEM BET · ENTRAÎNEMENT UNIQUEMENT'
  ),
  'SALEM OVAL': tr(
    'ሳሌም ኦቫል',
    'SALEM OVAL',
    'ሳሌም ኦቫል',
    'SALEM OVAL',
    'سالم أوفال',
    'SALEM OVAL',
    'SALEM OVAL'
  ),
  'SALEM OVAL · GREYHOUNDS': tr(
    'ሳሌም ኦቫል · የውድድር ውሾች',
    'SALEM OVAL · SAREEWWAN FIIGICHAA',
    'ሳሌም ኦቫል · ኣኽላባት ውድድር',
    'SALEM OVAL · EEYAHA ORODKA',
    'سالم أوفال · كلاب السباق',
    'SALEM OVAL · MBWA WA MBIO',
    'SALEM OVAL · LÉVRIERS'
  ),
  'SALEM TABLE GAMES': tr(
    'የሳሌም የጠረጴዛ ጨዋታዎች',
    'TAPHOOTA MINJAALAA SALEM',
    'ናይ ሳሌም ጸወታታት ጠረጴዛ',
    'CIYAARAHA MIISKA SALEM',
    'ألعاب طاولة سالم',
    'MICHEZO YA MEZANI YA SALEM',
    'JEUX DE TABLE SALEM'
  ),
  'SERVER BALL REVEAL': tr(
    'አገልጋዩ ኳሶችን ያሳያል',
    'SARVARIIN KUBBAA MULʼISA',
    'ሰርቨር ኩዕሶ ይገልጽ',
    'MUUJINTA KUBBADDA EE SERFARKA',
    'كشف الكرة من الخادم',
    'KUONYESHA MPIRA KUTOKA SEVA',
    'RÉVÉLATION DES BOULES PAR LE SERVEUR'
  ),
  'SHARED ROUND RESULT': tr(
    'የጋራ ዙር ውጤት',
    'BUʼAA MARSAA WALII',
    'ውጽኢት ናይ ሓባር ዙር',
    'NATIIJADA WAREEGGA LA WADAAGO',
    'نتيجة الجولة المشتركة',
    'MATOKEO YA RAUNDI YA PAMOJA',
    'RÉSULTAT DE LA MANCHE COMMUNE'
  ),
  SYNCHRONIZING: tr(
    'በማመሳሰል ላይ',
    'WALSIMSIISAA JIRA',
    'የወሃህድ ኣሎ',
    'WAA LA WAAFAJINAYAA',
    'جارٍ المزامنة',
    'INASAWAZISHA',
    'SYNCHRONISATION'
  ),
  'SYSTEM TABLE': tr(
    'የስርዓት ጠረጴዛ',
    'MINJAALA SIRNAA',
    'ጠረጴዛ ስርዓት',
    'MIISKA NIDAAMKA',
    'طاولة النظام',
    'MEZA YA MFUMO',
    'TABLE SYSTÈME'
  ),
  'Salem Bet Crash Point': tr(
    'የSalem Bet ክራሽ ፖይንት',
    'Salem Bet Crash Point',
    'ናይ Salem Bet ክራሽ ፖይንት',
    'Salem Bet Crash Point',
    'كراش بوينت من Salem Bet',
    'Salem Bet Crash Point',
    'Salem Bet Crash Point'
  ),
  'Salem Bet · Round transparency': tr(
    'Salem Bet · የዙር ግልጽነት',
    'Salem Bet · Ifa taʼummaa marsaa',
    'Salem Bet · ግሉጽነት ዙር',
    'Salem Bet · Hufnaanta wareegga',
    'Salem Bet · شفافية الجولة',
    'Salem Bet · Uwazi wa raundi',
    'Salem Bet · Transparence des manches'
  ),
  'Saved Spin bets': tr(
    'የተቀመጡ የሽክርክሪት ውርርዶች',
    'Sharaddilee naannawaa kuufaman',
    'ዝተዓቀቡ ውርርዳት ዙር',
    'Sharadyada wareegga ee kaydsan',
    'رهانات الدوران المحفوظة',
    'Dau za mzunguko zilizohifadhiwa',
    'Paris de roue enregistrés'
  ),
  'Saved bets': tr(
    'የተቀመጡ ውርርዶች',
    'Sharaddilee kuufaman',
    'ዝተዓቀቡ ውርርዳት',
    'Sharadyada kaydsan',
    'الرهانات المحفوظة',
    'Dau zilizohifadhiwa',
    'Paris enregistrés'
  ),
  'Saved bets this round': tr(
    'በዚህ ዙር የተቀመጡ ውርርዶች',
    'Sharaddilee marsaa kana keessatti kuufaman',
    'ኣብዚ ዙር ዝተዓቀቡ ውርርዳት',
    'Sharadyada kaydsan ee wareeggan',
    'الرهانات المحفوظة في هذه الجولة',
    'Dau zilizohifadhiwa kwenye raundi hii',
    'Paris enregistrés dans cette manche'
  ),
  'Saved guess:': tr(
    'የተቀመጠ ግምት፦',
    'Tilmaama kuufame:',
    'ዝተዓቀበ ግምት፦',
    'Qiyaasta kaydsan:',
    'التخمين المحفوظ:',
    'Kadirio lililohifadhiwa:',
    'Nombre enregistré :'
  ),
  'Saved tickets': tr(
    'የተቀመጡ ትኬቶች',
    'Tikeetota kuufaman',
    'ዝተዓቀቡ ትኬታት',
    'Tigidhada kaydsan',
    'التذاكر المحفوظة',
    'Tiketi zilizohifadhiwa',
    'Tickets enregistrés'
  ),
  'Schedule & rules': tr(
    'መርሃ ግብር እና ህጎች',
    'Sagantaa fi seerota',
    'መደብን ሕግታትን',
    'Jadwalka iyo xeerarka',
    'الجدول والقواعد',
    'Ratiba na kanuni',
    'Calendrier et règles'
  ),
  'Scheduled practice markets': tr(
    'በመርሃ ግብር የሚካሄዱ የልምምድ ገበያዎች',
    'Gabaa shaakalaa saganteeffame',
    'ብመደብ ዝካየዱ ዕዳጋታት ልምምድ',
    'Suuqyada tababarka ee jadwalaysan',
    'أسواق التدريب المجدولة',
    'Masoko ya mazoezi yaliyopangwa',
    'Marchés dʼentraînement programmés'
  ),
  Score: tr('ነጥብ', 'Qabxii', 'ነጥቢ', 'Dhibco', 'النقاط', 'Alama', 'Score'),
  'Search games or providers': tr(
    'ጨዋታዎችን ወይም አቅራቢዎችን ፈልግ',
    'Taphoota yookaan dhiyeessitoota barbaadi',
    'ጸወታታት ወይ ኣቕረብቲ ድለ',
    'Raadi ciyaaro ama bixiyayaal',
    'ابحث عن ألعاب أو مزوّدين',
    'Tafuta michezo au watoa huduma',
    'Rechercher des jeux ou fournisseurs'
  ),
  'Seat {seat}': tr(
    'መቀመጫ {seat}',
    'Teessoo {seat}',
    'መቐመጢ {seat}',
    'Kursi {seat}',
    'المقعد {seat}',
    'Kiti {seat}',
    'Place {seat}'
  ),
  'Seat {s}': tr(
    'መቀመጫ {s}',
    'Teessoo {s}',
    'መቐመጢ {s}',
    'Kursi {s}',
    'المقعد {s}',
    'Kiti {s}',
    'Place {s}'
  ),
  'Select your numbers before the countdown ends.': tr(
    'ቆጠራው ከማብቃቱ በፊት ቁጥሮችዎን ይምረጡ።',
    'Lakkoofsi yeroo osoo hin xumuramin lakkoofsota kee filadhu.',
    'ቅድሚ ቆጸራ ግዜ ምውድኡ ቁጽርታትካ ምረጽ።',
    'Dooro lambarradaada ka hor inta tirinta waqtigu dhammaan.',
    'اختر أرقامك قبل انتهاء العد التنازلي.',
    'Chagua namba zako kabla hesabu ya muda haijaisha.',
    'Choisissez vos numéros avant la fin du compte à rebours.'
  ),
  'Select your numbers, then start the draw.': tr(
    'ቁጥሮችዎን ይምረጡ፣ ከዚያ ዕጣውን ያስጀምሩ።',
    'Lakkoofsota kee filadhu, sana booda baafama jalqabi.',
    'ቁጽርታትካ ምረጽ፣ ድሕሪኡ ዕጫ ጀምር።',
    'Dooro lambarradaada, ka dib bilow soo saarista.',
    'اختر أرقامك ثم ابدأ السحب.',
    'Chagua namba zako, kisha anza droo.',
    'Choisissez vos numéros, puis lancez le tirage.'
  ),
  'Select {label}': tr(
    '{label} ይምረጡ',
    '{label} filadhu',
    '{label} ምረጽ',
    'Dooro {label}',
    'اختر {label}',
    'Chagua {label}',
    'Sélectionner {label}'
  ),
  Selected: tr('ተመርጧል', 'Filatameera', 'ተመሪጹ', 'La doortay', 'محدد', 'Imechaguliwa', 'Sélectionné'),
  'Selected for this bet': tr(
    'ለዚህ ውርርድ ተመርጧል',
    'Sharaddii kanaaf filatameera',
    'ነዚ ውርርድ ተመሪጹ',
    'Loo doortay sharadkan',
    'محدد لهذا الرهان',
    'Imechaguliwa kwa dau hili',
    'Sélectionné pour ce pari'
  ),
  'Selected provider game': tr(
    'የተመረጠ የአቅራቢ ጨዋታ',
    'Tapha dhiyeessaa filatame',
    'ዝተመርጸ ጸወታ ኣቕራቢ',
    'Ciyaarta bixiyaha ee la doortay',
    'لعبة المزوّد المحددة',
    'Mchezo wa mtoa huduma uliochaguliwa',
    'Jeu du fournisseur sélectionné'
  ),
  'Selection confirmed': tr(
    'ምርጫው ተረጋግጧል',
    'Filannoon mirkanaaʼeera',
    'ምርጫ ተረጋጊጹ',
    'Doorashada waa la xaqiijiyey',
    'تم تأكيد الاختيار',
    'Chaguo limethibitishwa',
    'Sélection confirmée'
  ),
  'Selection type': tr(
    'የምርጫ ዓይነት',
    'Gosa filannoo',
    'ዓይነት ምርጫ',
    'Nooca doorashada',
    'نوع الاختيار',
    'Aina ya chaguo',
    'Type de sélection'
  ),
  'Selections close': tr(
    'ምርጫዎች ይዘጋሉ',
    'Filannoowwan ni cufamu',
    'ምርጫታት ይዕጸዉ',
    'Doorashooyinku way xirmayaan',
    'تُغلق الاختيارات',
    'Machaguo yanafungwa',
    'Clôture des sélections'
  ),
  'Selections closed': tr(
    'ምርጫዎች ተዘግተዋል',
    'Filannoowwan cufamaniiru',
    'ምርጫታት ተዓጽዮም',
    'Doorashooyinku way xirmeen',
    'أُغلقت الاختيارات',
    'Machaguo yamefungwa',
    'Sélections fermées'
  ),
  'Server confirms your final multiplier': tr(
    'አገልጋዩ የመጨረሻ ማባዣዎን ያረጋግጣል',
    'Sarvariin baayʼisaa kee xumuraa mirkaneessa',
    'ሰርቨር ናይ መወዳእታ መባዝሒኻ የረጋግጽ',
    'Serfarku wuxuu xaqiijiyaa isku-dhuftehaaga kama dambaysta ah',
    'يؤكد الخادم مضاعفك النهائي',
    'Seva huthibitisha kizidishi chako cha mwisho',
    'Le serveur confirme votre multiplicateur final'
  ),
  'Server-confirmed data · practice ETB only': tr(
    'በአገልጋዩ የተረጋገጠ ውሂብ · የልምምድ ETB ብቻ',
    'Daataa sarvariin mirkanaaʼe · ETB shaakalaa qofa',
    'ብሰርቨር ዝተረጋገጸ ሓበሬታ · ናይ ልምምድ ETB ጥራይ',
    'Xog serfarku xaqiijiyey · ETB tababar oo keliya',
    'بيانات مؤكدة من الخادم · ETB تدريبي فقط',
    'Data iliyothibitishwa na seva · ETB za mazoezi pekee',
    'Données confirmées par le serveur · ETB dʼentraînement uniquement'
  ),
  'Server-confirmed practice returns': tr(
    'በአገልጋዩ የተረጋገጡ የልምምድ ተመላሾች',
    'Deebii shaakalaa sarvariin mirkanaaʼe',
    'ብሰርቨር ዝተረጋገጸ ተመላሲ ልምምድ',
    'Soo-noqoshada tababarka ee serfarku xaqiijiyey',
    'عوائد التدريب المؤكدة من الخادم',
    'Malipo ya mazoezi yaliyothibitishwa na seva',
    'Retours dʼentraînement confirmés par le serveur'
  ),
  'Server-set results': tr(
    'በአገልጋዩ የተወሰኑ ውጤቶች',
    'Buʼaawwan sarvariin murtaaʼan',
    'ብሰርቨር ዝተወሰኑ ውጽኢታት',
    'Natiijooyinka uu serfarku goʼaamiyey',
    'نتائج محددة من الخادم',
    'Matokeo yaliyowekwa na seva',
    'Résultats définis par le serveur'
  ),
  'Settling…': tr(
    'ክፍያን በማጠናቀቅ ላይ…',
    'Kaffaltii xumuraa jira…',
    'ክፍሊት የጻፍፍ ኣሎ…',
    'Xisaab-xir baa socda…',
    'جارٍ تسوية المدفوعات…',
    'Inakamilisha malipo…',
    'Règlement…'
  ),
  'Seven Up': tr(
    'ሰባትና በላይ',
    'Torbaa fi Ol',
    'ሸውዓተን ልዕሊኡን',
    'Toddoba iyo Ka Badan',
    'سبعة فأكثر',
    'Saba na Zaidi',
    'Sept ou plus'
  ),
  'Seven up · winning result': tr(
    'ሰባትና በላይ · የማሸነፍ ውጤት',
    'Torbaa fi ol · buʼaa injifannoo',
    'ሸውዓተን ልዕሊኡን · ውጽኢት ዓወት',
    'Toddoba iyo ka badan · natiijo guul ah',
    'سبعة فأكثر · نتيجة فائزة',
    'Saba na zaidi · matokeo ya ushindi',
    'Sept ou plus · résultat gagnant'
  ),
  'Show match': tr(
    'ጨዋታውን አሳይ',
    'Tapha agarsiisi',
    'ጸወታ ኣርኢ',
    'Muuji kulanka',
    'عرض المباراة',
    'Onyesha mechi',
    'Afficher le match'
  ),
  'Show more games': tr(
    'ተጨማሪ ጨዋታዎችን አሳይ',
    'Taphoota dabalataa agarsiisi',
    'ተወሰኽቲ ጸወታታት ኣርኢ',
    'Muuji ciyaaro dheeraad ah',
    'عرض المزيد من الألعاب',
    'Onyesha michezo zaidi',
    'Afficher plus de jeux'
  ),
  'Showing {length} of {totalTickets} tickets.': tr(
    'ከ{totalTickets} ትኬቶች {length} እየታዩ ነው።',
    'Tikeetota {totalTickets} keessaa {length} agarsiisaa jira.',
    'ካብ {totalTickets} ትኬታት {length} ይርኣዩ ኣለዉ።',
    'Waxaa la muujinayaa {length} ka mid ah {totalTickets} tigidh.',
    'عرض {length} من {totalTickets} تذكرة.',
    'Inaonyesha tiketi {length} kati ya {totalTickets}.',
    'Affichage de {length} tickets sur {totalTickets}.'
  ),
  'Showing {value} of {value2} games': tr(
    'ከ{value2} ጨዋታዎች {value} እየታዩ ነው',
    'Taphoota {value2} keessaa {value} agarsiisaa jira',
    'ካብ {value2} ጸወታታት {value} ይርኣዩ ኣለዉ',
    'Waxaa la muujinayaa {value} ka mid ah {value2} ciyaarood',
    'عرض {value} من {value2} لعبة',
    'Inaonyesha michezo {value} kati ya {value2}',
    'Affichage de {value} jeux sur {value2}'
  ),
  'Sign in to browse the casino.': tr(
    'ካዚኖውን ለማየት ይግቡ።',
    'Kaazinoo ilaaluuf seeni.',
    'ካዚኖ ንምርኣይ እቶ።',
    'Soo gal si aad u daalacato kaasiinada.',
    'سجّل الدخول لتصفح الكازينو.',
    'Ingia ili kuvinjari kasino.',
    'Connectez-vous pour parcourir le casino.'
  ),
  'Sign in to play Number Challenge.': tr(
    'የቁጥር ውድድርን ለመጫወት ይግቡ።',
    'Dorgommii Lakkoofsaa taphachuuf seeni.',
    'ውድድር ቁጽሪ ንምጽዋት እቶ።',
    'Soo gal si aad u ciyaarto Tartanka Lambarka.',
    'سجّل الدخول للعب تحدي الأرقام.',
    'Ingia ili kucheza Changamoto ya Namba.',
    'Connectez-vous pour jouer au Défi des nombres.'
  ),
  Six: tr('ስድስት', 'Jaʼa', 'ሽዱሽተ', 'Lix', 'ستة', 'Sita', 'Six'),
  'Six seats. One dealer. Your call.': tr(
    'ስድስት መቀመጫዎች። አንድ አከፋፋይ። የእርስዎ ምርጫ።',
    'Teessoo jaʼa. Qoodaa tokko. Filannoo kee.',
    'ሽዱሽተ መቐመጢታት። ሓደ ኣከፋፋሊ። ምርጫኻ።',
    'Lix kursi. Hal qaybiye. Doorashadaada.',
    'ستة مقاعد. موزع واحد. القرار لك.',
    'Viti sita. Mgawaji mmoja. Chaguo lako.',
    'Six places. Un croupier. À vous de choisir.'
  ),
  'Six-match returns': tr(
    'ለስድስት ተዛማጆች ተመላሾች',
    'Deebii walsimannaa jaʼaa',
    'ተመላሲ ሽዱሽተ ዝተዛመዱ',
    'Soo-noqoshada lix iswaafajin',
    'عوائد ست مطابقات',
    'Malipo ya namba sita zinazolingana',
    'Retours pour six correspondances'
  ),
  'Six-match table per line': tr(
    'በእያንዳንዱ መስመር የስድስት ተዛማጆች ሰንጠረዥ',
    'Gabatee walsimannaa jaʼaa sarara tokkoof',
    'ሰሌዳ ሽዱሽተ ዝተዛመዱ ንነፍሲ ወከፍ መስመር',
    'Jadwalka lix iswaafajin sadar kasta',
    'جدول ست مطابقات لكل صف',
    'Jedwali la namba sita zinazolingana kwa kila mstari',
    'Tableau de six correspondances par ligne'
  ),
  Sky: tr('ስካይ', 'Sky', 'ስካይ', 'Sky', 'سكاي', 'Sky', 'Sky'),
  'Sky Crash': tr(
    'ስካይ ክራሽ',
    'Sky Crash',
    'ስካይ ክራሽ',
    'Sky Crash',
    'سكاي كراش',
    'Sky Crash',
    'Sky Crash'
  ),
  'Sky Crash practice is unavailable.': tr(
    'የስካይ ክራሽ ልምምድ አይገኝም።',
    'Shaakalli Sky Crash hin jiru.',
    'ልምምድ ስካይ ክራሽ ኣይርከብን።',
    'Tababarka Sky Crash lama heli karo.',
    'تدريب سكاي كراش غير متاح.',
    'Mazoezi ya Sky Crash hayapatikani.',
    'Lʼentraînement Sky Crash est indisponible.'
  ),
  'Sound off': tr(
    'ድምፅ ጠፍቷል',
    'Sagaleen cufameera',
    'ድምጺ ተዓጽዩ',
    'Codku wuu dansan yahay',
    'الصوت مغلق',
    'Sauti imezimwa',
    'Son désactivé'
  ),
  'Sound on': tr(
    'ድምፅ በርቷል',
    'Sagaleen banameera',
    'ድምጺ ተኸፊቱ',
    'Codku wuu shidan yahay',
    'الصوت مفعّل',
    'Sauti imewashwa',
    'Son activé'
  ),
  'Sports · Real wallet': tr(
    'ስፖርት · እውነተኛ የገንዘብ ቦርሳ',
    'Ispoortii · Boorsaa maallaqaa dhugaa',
    'ስፖርት · ናይ ሓቂ ቦርሳ ገንዘብ',
    'Isboorti · Boorso lacag dhab ah',
    'رياضة · محفظة حقيقية',
    'Michezo · Pochi halisi',
    'Sports · Portefeuille réel'
  ),
  'Stage {value} prices': tr(
    'የደረጃ {value} ዋጋዎች',
    'Gatiiwwan sadarkaa {value}',
    'ዋጋታት መድረኽ {value}',
    'Qiimayaasha marxaladda {value}',
    'معاملات المرحلة {value}',
    'Bei za hatua {value}',
    'Cotes de la phase {value}'
  ),
  'Stage {value} · {value2}': tr(
    'ደረጃ {value} · {value2}',
    'Sadarkaa {value} · {value2}',
    'መድረኽ {value} · {value2}',
    'Marxalad {value} · {value2}',
    'المرحلة {value} · {value2}',
    'Hatua {value} · {value2}',
    'Phase {value} · {value2}'
  ),
  Stake: tr(
    'የውርርድ መጠን',
    'Maallaqa sharaddii',
    'መጠን ውርርድ',
    'Lacagta sharadka',
    'مبلغ الرهان',
    'Kiasi cha dau',
    'Mise'
  ),
  'Stand on all 17s': tr(
    'በሁሉም 17 ላይ ይቆማል',
    '17 hunda irratti dhaabbata',
    'ኣብ ኩሎም 17 ይደው',
    'Wuxuu joogsadaa dhammaan 17-yada',
    'التوقف عند كل حالات 17',
    'Husimama kwa 17 zote',
    'Reste sur tous les 17'
  ),
  Standing: tr('ቆሟል', 'Dhaabbateera', 'ደው ኢሉ', 'Wuu joogsaday', 'متوقف', 'Imesimama', 'Reste'),
  'Start autoplay · 10 rounds': tr(
    'ራስ-ሰር ጨዋታ ጀምር · 10 ዙሮች',
    'Tapha ofumaan jalqabi · marsaa 10',
    'ርእሰ-ሰር ጸወታ ጀምር · 10 ዙራት',
    'Bilow ciyaarta tooska ah · 10 wareeg',
    'ابدأ اللعب التلقائي · 10 جولات',
    'Anza kucheza kiotomatiki · raundi 10',
    'Lancer le jeu automatique · 10 manches'
  ),
  'Start draw · {ticketCost} credits': tr(
    'ዕጣውን ጀምር · {ticketCost} ክሬዲቶች',
    'Baafama jalqabi · kiridiitii {ticketCost}',
    'ዕጫ ጀምር · {ticketCost} ክሬዲት',
    'Bilow soo saarista · {ticketCost} dhibco ciyaareed',
    'ابدأ السحب · {ticketCost} من رصيد اللعب',
    'Anza droo · vitengo {ticketCost} vya mchezo',
    'Lancer le tirage · {ticketCost} crédits'
  ),
  'Steps of 5 ETB · Up to 500 ETB per bet.': tr(
    'በ5 ETB ጭማሪ · በአንድ ውርርድ እስከ 500 ETB።',
    'Daballii 5 ETB · sharaddii tokkoof hanga 500 ETB.',
    'ብ5 ETB ወሰኽ · ንሓደ ውርርድ ክሳብ 500 ETB።',
    'Koror 5 ETB ah · ilaa 500 ETB sharad kasta.',
    'بزيادات 5 ETB · حتى 500 ETB لكل رهان.',
    'Hatua za 5 ETB · hadi 500 ETB kwa dau.',
    'Pas de 5 ETB · jusquʼà 500 ETB par pari.'
  ),
  'Steps of 5 · Maximum 480 ETB per ticket': tr(
    'በ5 ጭማሪ · በአንድ ትኬት ከፍተኛው 480 ETB',
    'Daballii 5 · tikeetii tokkoof olʼaantuu 480 ETB',
    'ብ5 ወሰኽ · ንሓደ ትኬት ዝለዓለ 480 ETB',
    'Koror 5 ah · ugu badnaan 480 ETB tigidh kasta',
    'بزيادات 5 · بحد أقصى 480 ETB لكل تذكرة',
    'Hatua za 5 · kiwango cha juu 480 ETB kwa tiketi',
    'Pas de 5 · maximum 480 ETB par ticket'
  ),
  'Stop autoplay · {remaining} entries left': tr(
    'ራስ-ሰር ጨዋታ አቁም · {remaining} ተሳትፎዎች ቀርተዋል',
    'Tapha ofumaan dhaabi · hirmaannaa {remaining} hafe',
    'ርእሰ-ሰር ጸወታ ኣቋርጽ · {remaining} ተሳትፎታት ተሪፎም',
    'Jooji ciyaarta tooska ah · {remaining} ka qaybgal ayaa haray',
    'أوقف اللعب التلقائي · تبقت {remaining} مشاركة',
    'Simamisha kucheza kiotomatiki · ushiriki {remaining} umebaki',
    'Arrêter le jeu automatique · {remaining} participations restantes'
  ),
  'Synchronizing with the table': tr(
    'ከጠረጴዛው ጋር በማመሳሰል ላይ',
    'Minjaala waliin walsimsiisaa jira',
    'ምስ ጠረጴዛ የወሃህድ ኣሎ',
    'Waxaa lala waafajinayaa miiska',
    'جارٍ المزامنة مع الطاولة',
    'Inasawazisha na meza',
    'Synchronisation avec la table'
  ),
  'Syncing the next round': tr(
    'ቀጣዩን ዙር በማመሳሰል ላይ',
    'Marsaa itti aanu walsimsiisaa jira',
    'ቀጻሊ ዙር የወሃህድ ኣሎ',
    'Waxaa la waafajinayaa wareegga xiga',
    'جارٍ مزامنة الجولة التالية',
    'Inasawazisha raundi inayofuata',
    'Synchronisation de la prochaine manche'
  ),
  'System Dice practice': tr(
    'የስርዓት ዳይስ ልምምድ',
    'Shaakala Daayisii sirnaa',
    'ልምምድ ዳይስ ስርዓት',
    'Tababarka Laadhuuga nidaamka',
    'تدريب نرد النظام',
    'Mazoezi ya Kete ya mfumo',
    'Entraînement Dés système'
  ),
  'System Keno practice': tr(
    'የስርዓት ኬኖ ልምምድ',
    'Shaakala Keno sirnaa',
    'ልምምድ ኬኖ ስርዓት',
    'Tababarka Keno nidaamka',
    'تدريب كينو النظام',
    'Mazoezi ya Keno ya mfumo',
    'Entraînement Keno système'
  ),
  'System table · Free practice': tr(
    'የስርዓት ጠረጴዛ · ነፃ ልምምድ',
    'Minjaala sirnaa · Shaakala bilisaa',
    'ጠረጴዛ ስርዓት · ነጻ ልምምድ',
    'Miiska nidaamka · Tababar bilaash ah',
    'طاولة النظام · تدريب مجاني',
    'Meza ya mfumo · Mazoezi ya bure',
    'Table système · Entraînement gratuit'
  ),
  'THE EMERALD COURSE': tr(
    'የኤመራልድ መንገድ',
    'DAANDII EMERALD',
    'መንገዲ ኤመራልድ',
    'WADDADA EMERALD',
    'مضمار إيميرالد',
    'UWANJA WA EMERALD',
    'LA PISTE EMERALD'
  ),
  'THE FLIGHT COLLECTION': tr(
    'የበረራ ስብስብ',
    'WALITTI QABAMA BALALIʼII',
    'ስብስብ በረራ',
    'URURINTA DUULIMAADKA',
    'مجموعة الطيران',
    'MKUSANYIKO WA NDEGE',
    'LA COLLECTION VOL'
  ),
  'THE MAGIC NUMBER': tr(
    'አስማታዊው ቁጥር',
    'LAKKOOFSA DINQII',
    'እቲ ድንቂ ቁጽሪ',
    'LAMBARKA SIXIRKA',
    'الرقم السحري',
    'NAMBA YA AJABU',
    'LE NOMBRE MAGIQUE'
  ),
  'THE RUBY GRAND COLLECTION': tr(
    'የሩቢ ግራንድ ስብስብ',
    'WALITTI QABAMA RUBY GRAND',
    'ስብስብ ሩቢ ግራንድ',
    'URURINTA RUBY GRAND',
    'مجموعة روبي غراند',
    'MKUSANYIKO WA RUBY GRAND',
    'LA COLLECTION RUBY GRAND'
  ),
  'THE TOTAL IS': tr(
    'ድምሩ',
    'IDAʼAMNI',
    'እቲ ድምር',
    'WADARTU WAA',
    'المجموع هو',
    'JUMLA NI',
    'LE TOTAL EST'
  ),
  'TOTAL BET': tr(
    'አጠቃላይ ውርርድ',
    'SHARADDII WALIIGALAA',
    'ጠቕላላ ውርርድ',
    'WADARTA SHARADKA',
    'إجمالي الرهان',
    'JUMLA YA DAU',
    'MISE TOTALE'
  ),
  'Tap dogs in selection order.': tr(
    'ውሾችን በምርጫ ቅደም ተከተል ይንኩ።',
    'Sareewwan tartiiba filannootiin tuqi.',
    'ኣኽላባት ብቅደም ተኸተል ምርጫ ጠውቕ።',
    'Taabo eeyaha sida ay doorashadu u kala horreyso.',
    'اضغط على الكلاب حسب ترتيب الاختيار.',
    'Gusa mbwa kwa mpangilio wa uchaguzi.',
    'Touchez les chiens dans lʼordre de sélection.'
  ),
  'Tap horses in selection order.': tr(
    'ፈረሶችን በምርጫ ቅደም ተከተል ይንኩ።',
    'Fardeen tartiiba filannootiin tuqi.',
    'ኣፍራስ ብቅደም ተኸተል ምርጫ ጠውቕ።',
    'Taabo fardaha sida ay doorashadu u kala horreyso.',
    'اضغط على الخيول حسب ترتيب الاختيار.',
    'Gusa farasi kwa mpangilio wa uchaguzi.',
    'Touchez les chevaux dans lʼordre de sélection.'
  ),
  Target: tr('ዒላማ', 'Galma', 'ዕላማ', 'Bartilmaameed', 'الهدف', 'Lengo', 'Cible'),
  'Target: {target}': tr(
    'ዒላማ፦ {target}',
    'Galma: {target}',
    'ዕላማ፦ {target}',
    'Bartilmaameed: {target}',
    'الهدف: {target}',
    'Lengo: {target}',
    'Cible : {target}'
  ),
  'Test wallet': tr(
    'የሙከራ ቦርሳ',
    'Boorsaa yaalii',
    'ቦርሳ ፈተነ',
    'Boorsada tijaabada',
    'محفظة الاختبار',
    'Pochi ya majaribio',
    'Portefeuille de test'
  ),
  'Text match centre': tr(
    'የጨዋታ የጽሑፍ ማዕከል',
    'Wiirtuu barruu taphaa',
    'ማእከል ጽሑፍ ጸወታ',
    'Xarunta qoraalka kulanka',
    'مركز المباراة النصي',
    'Kituo cha maandishi ya mechi',
    'Centre de match textuel'
  ),
  'The first five slots are the pre-balls.': tr(
    'የመጀመሪያዎቹ አምስት ቦታዎች የቅድመ ኳሶች ናቸው።',
    'Bakki shanan jalqabaa kan kubbaawwan duraa ti.',
    'ቀዳሞት ሓሙሽተ ቦታታት ናይ ቅድመ ኩዕሶታት እዮም።',
    'Shanta boos ee hore waa kubbadaha hordhaca ah.',
    'الخانات الخمس الأولى للكرات التمهيدية.',
    'Nafasi tano za kwanza ni za mipira ya awali.',
    'Les cinq premiers emplacements sont les boules préliminaires.'
  ),
  'The game collection': tr(
    'የጨዋታ ስብስብ',
    'Walitti qabama taphoota',
    'ስብስብ ጸወታታት',
    'Ururinta ciyaaraha',
    'مجموعة الألعاب',
    'Mkusanyiko wa michezo',
    'La collection de jeux'
  ),
  'The next matchweek is opening…': tr(
    'ቀጣዩ የጨዋታ ሳምንት እየተከፈተ ነው…',
    'Torban taphaa itti aanu banamaa jira…',
    'ቀጻሊ ሰሙን ጸወታ ይኽፈት ኣሎ…',
    'Toddobaadka kulan ee xiga ayaa furmaya…',
    'جارٍ فتح أسبوع المباريات التالي…',
    'Wiki ya mechi inayofuata inafunguliwa…',
    'Ouverture de la prochaine journée…'
  ),
  'The race is on': tr(
    'ውድድሩ ተጀምሯል',
    'Fiigichi jalqabeera',
    'ውድድር ጀሚሩ',
    'Tartanku wuu bilowday',
    'انطلق السباق',
    'Mbio zimeanza',
    'La course est lancée'
  ),
  'The server has revealed this round’s result': tr(
    'አገልጋዩ የዚህን ዙር ውጤት ገልጧል',
    'Sarvariin buʼaa marsaa kanaa mulʼiseera',
    'ሰርቨር ውጽኢት ናይዚ ዙር ገሊጹ',
    'Serfarku wuxuu muujiyey natiijada wareeggan',
    'كشف الخادم نتيجة هذه الجولة',
    'Seva imeonyesha matokeo ya raundi hii',
    'Le serveur a révélé le résultat de cette manche'
  ),
  'This game could not be opened.': tr(
    'ይህ ጨዋታ መከፈት አልቻለም።',
    'Tapha kana banuun hin dandaʼamne.',
    'እዚ ጸወታ ክኽፈት ኣይተኻእለን።',
    'Ciyaartan lama furi karin.',
    'تعذر فتح هذه اللعبة.',
    'Mchezo huu haukuweza kufunguliwa.',
    'Ce jeu nʼa pas pu être ouvert.'
  ),
};
export default catalogue;
