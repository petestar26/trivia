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
  'Check saved confirmation': tr(
    'የተቀመጠውን ማረጋገጫ ያረጋግጡ',
    'Mirkaneessa kuufame ilaali',
    'ዝተዓቀበ መረጋገጺ ፈትሽ',
    'Hubi xaqiijinta kaydsan',
    'تحقق من التأكيد المحفوظ',
    'Angalia uthibitisho uliohifadhiwa',
    'Vérifier la confirmation enregistrée'
  ),
  'Check this confirmation': tr(
    'ይህን ማረጋገጫ ያረጋግጡ',
    'Mirkaneessa kana ilaali',
    'ነዚ መረጋገጺ ፈትሽ',
    'Hubi xaqiijintan',
    'تحقق من هذا التأكيد',
    'Angalia uthibitisho huu',
    'Vérifier cette confirmation'
  ),
  Checking: tr(
    'በማረጋገጥ ላይ',
    'Ilaalaa jira',
    'ይፍትሽ ኣሎ',
    'Waa la hubinayaa',
    'جارٍ التحقق',
    'Inakagua',
    'Vérification'
  ),
  'Checking Bet {slot} · Round {value}': tr(
    'ውርርድ {slot} በማረጋገጥ ላይ · ዙር {value}',
    'Sharaddii {slot} ilaalaa jira · Marsaa {value}',
    'ውርርድ {slot} ይፍትሽ ኣሎ · ዙር {value}',
    'La hubinayo sharadka {slot} · Wareegga {value}',
    'التحقق من الرهان {slot} · الجولة {value}',
    'Inakagua dau {slot} · Raundi {value}',
    'Vérification du pari {slot} · Manche {value}'
  ),
  'Checking casino access…': tr(
    'የካዚኖ መዳረሻ በማረጋገጥ ላይ…',
    'Seensa kaazinoo ilaalaa jira…',
    'መእተዊ ካዚኖ ይፍትሽ ኣሎ…',
    'La hubinayo gelitaanka kaasiinada…',
    'جارٍ التحقق من الوصول إلى الكازينو…',
    'Inakagua ruhusa ya kasino…',
    'Vérification de lʼaccès au casino…'
  ),
  'Checking confirmation…': tr(
    'ማረጋገጫውን በመፈተሽ ላይ…',
    'Mirkaneessa ilaalaa jira…',
    'መረጋገጺ ይፍትሽ ኣሎ…',
    'La hubinayo xaqiijinta…',
    'جارٍ فحص التأكيد…',
    'Inakagua uthibitisho…',
    'Vérification de la confirmation…'
  ),
  'Checking saved ticket…': tr(
    'የተቀመጠውን ትኬት በማረጋገጥ ላይ…',
    'Tikeetii kuufame ilaalaa jira…',
    'ዝተዓቀበ ትኬት ይፍትሽ ኣሎ…',
    'La hubinayo tigidhka kaydsan…',
    'جارٍ فحص التذكرة المحفوظة…',
    'Inakagua tiketi iliyohifadhiwa…',
    'Vérification du ticket enregistré…'
  ),
  'Checking ticket': tr(
    'ትኬቱን በማረጋገጥ ላይ',
    'Tikeetii ilaalaa jira',
    'ትኬት ይፍትሽ ኣሎ',
    'La hubinayo tigidhka',
    'جارٍ فحص التذكرة',
    'Inakagua tiketi',
    'Vérification du ticket'
  ),
  'Checking ticket…': tr(
    'ትኬቱን በማረጋገጥ ላይ…',
    'Tikeetii ilaalaa jira…',
    'ትኬት ይፍትሽ ኣሎ…',
    'La hubinayo tigidhka…',
    'جارٍ فحص التذكرة…',
    'Inakagua tiketi…',
    'Vérification du ticket…'
  ),
  'Choose 1–100': tr(
    'ከ1–100 ይምረጡ',
    '1–100 keessaa filadhu',
    'ካብ 1–100 ምረጽ',
    'Dooro 1–100',
    'اختر من 1–100',
    'Chagua kati ya 1–100',
    'Choisissez de 1–100'
  ),
  'Choose Keno numbers': tr(
    'የኬኖ ቁጥሮችን ይምረጡ',
    'Lakkoofsota Keno filadhu',
    'ቁጽርታት ኬኖ ምረጽ',
    'Dooro lambarrada Keno',
    'اختر أرقام كينو',
    'Chagua namba za Keno',
    'Choisissez les numéros du Keno'
  ),
  'Choose a result above': tr(
    'ከላይ ያለ ውጤት ይምረጡ',
    'Buʼaa armaan olii filadhu',
    'ኣብ ላዕሊ ዘሎ ውጽኢት ምረጽ',
    'Dooro natiijo kor ku qoran',
    'اختر نتيجة أعلاه',
    'Chagua matokeo hapo juu',
    'Choisissez un résultat ci-dessus'
  ),
  'Choose dogs': tr(
    'ውሾችን ይምረጡ',
    'Sareewwan filadhu',
    'ኣኽላባት ምረጽ',
    'Dooro eeyaha',
    'اختر الكلاب',
    'Chagua mbwa',
    'Choisissez les chiens'
  ),
  'Choose horses': tr(
    'ፈረሶችን ይምረጡ',
    'Fardeen filadhu',
    'ኣፍራስ ምረጽ',
    'Dooro fardaha',
    'اختر الخيول',
    'Chagua farasi',
    'Choisissez les chevaux'
  ),
  'Choose number with slider': tr(
    'በተንሸራታቹ ቁጥር ይምረጡ',
    'Lakkoofsa harkistuun filadhu',
    'ብመንሸራተቲ ቁጽሪ ምረጽ',
    'Ku dooro lambarka jiidaha',
    'اختر الرقم باستخدام شريط التمرير',
    'Chagua namba kwa kitelezi',
    'Choisissez le nombre avec le curseur'
  ),
  'Choose your bet': tr(
    'ውርርድዎን ይምረጡ',
    'Sharaddii kee filadhu',
    'ውርርድካ ምረጽ',
    'Dooro sharadkaaga',
    'اختر رهانك',
    'Chagua dau lako',
    'Choisissez votre pari'
  ),
  'Choose your moment': tr(
    'ጊዜዎን ይምረጡ',
    'Yeroo kee filadhu',
    'ግዜኻ ምረጽ',
    'Dooro waqtigaaga',
    'اختر لحظتك',
    'Chagua wakati wako',
    'Choisissez votre instant'
  ),
  'Choose your number': tr(
    'ቁጥርዎን ይምረጡ',
    'Lakkoofsa kee filadhu',
    'ቁጽርኻ ምረጽ',
    'Dooro lambarkaaga',
    'اختر رقمك',
    'Chagua namba yako',
    'Choisissez votre nombre'
  ),
  'Choose your numbers above': tr(
    'ቁጥሮችዎን ከላይ ይምረጡ',
    'Lakkoofsota kee armaan olitti filadhu',
    'ቁጽርታትካ ኣብ ላዕሊ ምረጽ',
    'Lambarradaada kor ka dooro',
    'اختر أرقامك أعلاه',
    'Chagua namba zako hapo juu',
    'Choisissez vos numéros ci-dessus'
  ),
  'Choose your selection above': tr(
    'ምርጫዎን ከላይ ይምረጡ',
    'Filannoo kee armaan olitti filadhu',
    'ምርጫኻ ኣብ ላዕሊ ምረጽ',
    'Doorashadaada kor ka samee',
    'حدّد اختيارك أعلاه',
    'Fanya chaguo lako hapo juu',
    'Faites votre sélection ci-dessus'
  ),
  'Choose your ticket.': tr(
    'ትኬትዎን ይምረጡ።',
    'Tikeetii kee filadhu.',
    'ትኬትካ ምረጽ።',
    'Dooro tigidhkaaga.',
    'اختر تذكرتك.',
    'Chagua tiketi yako.',
    'Choisissez votre ticket.'
  ),
  'Clear bets': tr(
    'ውርርዶችን አጽዳ',
    'Sharaddilee haqi',
    'ውርርዳት ደምስስ',
    'Nadiifi sharadyada',
    'مسح الرهانات',
    'Futa dau',
    'Effacer les paris'
  ),
  'Close game rules': tr(
    'የጨዋታ ህጎችን ዝጋ',
    'Seerota taphaa cufi',
    'ሕግታት ጸወታ ዕጾ',
    'Xir xeerarka ciyaarta',
    'إغلاق قواعد اللعبة',
    'Funga kanuni za mchezo',
    'Fermer les règles du jeu'
  ),
  'Close result': tr(
    'ውጤቱን ዝጋ',
    'Buʼaa cufi',
    'ውጽኢት ዕጾ',
    'Xir natiijada',
    'إغلاق النتيجة',
    'Funga matokeo',
    'Fermer le résultat'
  ),
  'Close results': tr(
    'ውጤቶችን ዝጋ',
    'Buʼaawwan cufi',
    'ውጽኢታት ዕጾ',
    'Xir natiijooyinka',
    'إغلاق النتائج',
    'Funga matokeo',
    'Fermer les résultats'
  ),
  'Close round details': tr(
    'የዙሩን ዝርዝሮች ዝጋ',
    'Balʼina marsaa cufi',
    'ዝርዝር ዙር ዕጾ',
    'Xir faahfaahinta wareegga',
    'إغلاق تفاصيل الجولة',
    'Funga maelezo ya raundi',
    'Fermer les détails de la manche'
  ),
  'Close rules': tr(
    'ህጎችን ዝጋ',
    'Seerota cufi',
    'ሕግታት ዕጾ',
    'Xir xeerarka',
    'إغلاق القواعد',
    'Funga kanuni',
    'Fermer les règles'
  ),
  Closed: tr('ዝግ ነው', 'Cufameera', 'ተዓጽዩ', 'Waa xiran yahay', 'مغلق', 'Imefungwa', 'Fermé'),
  'Closer is better': tr(
    'ቅርብ መሆን ይሻላል',
    'Dhihoo taʼuun caala',
    'ቅርብ ምዃን ይሓይሽ',
    'Ka dhow ayaa fiican',
    'الأقرب أفضل',
    'Karibu zaidi ni bora',
    'Plus proche, cʼest mieux'
  ),
  Closes: tr('ይዘጋል', 'Ni cufama', 'ይዕጾ', 'Wuu xirmayaa', 'يُغلق', 'Inafungwa', 'Ferme'),
  'Closes in': tr(
    'የመዝጊያ ቀሪ ጊዜ',
    'Kan cufamu',
    'ንምዕጻው ዝተረፈ',
    'Wuxuu xirmayaa',
    'يُغلق خلال',
    'Inafungwa baada ya',
    'Ferme dans'
  ),
  'Coin bets': tr(
    'የሳንቲም ውርርዶች',
    'Sharaddilee saantimaa',
    'ውርርድ ሳንቲም',
    'Sharadyada qadaadiicda',
    'رهانات العملات',
    'Dau za sarafu',
    'Paris en pièces'
  ),
  'Coin chip value': tr(
    'የሳንቲም ቺፕ ዋጋ',
    'Gatii chiippii saantimaa',
    'ዋጋ ቺፕ ሳንቲም',
    'Qiimaha jibka qadaadiicda',
    'قيمة رقاقة العملات',
    'Thamani ya chipu ya sarafu',
    'Valeur du jeton en pièces'
  ),
  'Coin play is not available.{value}': tr(
    'በሳንቲም መጫወት አይገኝም።{value}',
    'Tapha saantimaa hin jiru.{value}',
    'ጸወታ ሳንቲም ኣይርከብን።{value}',
    'Ciyaarta qadaadiicda lama heli karo.{value}',
    'اللعب بالعملات غير متاح.{value}',
    'Kucheza kwa sarafu hakupatikani.{value}',
    'Le jeu en pièces est indisponible.{value}'
  ),
  'Columns 1–4 · 18 numbers each': tr(
    'አምዶች 1–4 · በእያንዳንዱ 18 ቁጥሮች',
    'Tarjaawwan 1–4 · tokkoon tokkoon lakkoofsota 18',
    'ዓምድታት 1–4 · ነፍሲ ወከፎም 18 ቁጽርታት',
    'Tiirarka 1–4 · mid kasta 18 lambar',
    'الأعمدة 1–4 · 18 رقمًا لكل عمود',
    'Safu 1–4 · namba 18 kila moja',
    'Colonnes 1–4 · 18 numéros chacune'
  ),
  'Coming soon': tr(
    'በቅርቡ ይመጣል',
    'Dhiheenyatti dhufa',
    'ቀረባ ግዜ ይመጽእ',
    'Dhawaan imanaya',
    'قريبًا',
    'Inakuja hivi karibuni',
    'Bientôt disponible'
  ),
  Commitment: tr(
    'ቅድመ ማረጋገጫ',
    'Ragaa duraa',
    'ቅድመ መረጋገጺ',
    'Xaqiijin hore',
    'التزام مسبق',
    'Uthibitisho wa awali',
    'Engagement préalable'
  ),
  'Commitment checked · awaiting draw': tr(
    'ቅድመ ማረጋገጫው ተፈትሿል · ዕጣውን በመጠበቅ ላይ',
    'Ragaan duraa ilaalameera · baafama eegaa jira',
    'ቅድመ መረጋገጺ ተፈቲሹ · ዕጫ ይጽበ ኣሎ',
    'Xaqiijinta hore waa la hubiyey · soo saarista ayaa la sugayaa',
    'تم فحص الالتزام · بانتظار السحب',
    'Uthibitisho wa awali umekaguliwa · inasubiri droo',
    'Engagement vérifié · en attente du tirage'
  ),
  'Commitment hash: {commitmentHash}': tr(
    'የቅድመ ማረጋገጫ ሃሽ፦ {commitmentHash}',
    'Haashii ragaa duraa: {commitmentHash}',
    'ሃሽ ቅድመ መረጋገጺ፦ {commitmentHash}',
    'Hash-ka xaqiijinta hore: {commitmentHash}',
    'بصمة الالتزام: {commitmentHash}',
    'Hashi ya uthibitisho wa awali: {commitmentHash}',
    'Empreinte de lʼengagement : {commitmentHash}'
  ),
  'Commitment: {commitment}': tr(
    'ቅድመ ማረጋገጫ፦ {commitment}',
    'Ragaa duraa: {commitment}',
    'ቅድመ መረጋገጺ፦ {commitment}',
    'Xaqiijin hore: {commitment}',
    'الالتزام: {commitment}',
    'Uthibitisho wa awali: {commitment}',
    'Engagement : {commitment}'
  ),
  Complete: tr('ተጠናቋል', 'Xumurameera', 'ተዛዚሙ', 'Wuu dhammaaday', 'مكتمل', 'Imekamilika', 'Terminé'),
  'Completed races will appear here.': tr(
    'የተጠናቀቁ ውድድሮች እዚህ ይታያሉ።',
    'Fiigichi xumurame asitti mulʼata.',
    'ዝተዛዘሙ ውድድራት ኣብዚ ይርኣዩ።',
    'Tartamada dhammaaday halkan ayay ka muuqan doonaan.',
    'ستظهر السباقات المكتملة هنا.',
    'Mbio zilizokamilika zitaonekana hapa.',
    'Les courses terminées apparaîtront ici.'
  ),
  'Completed rounds will appear here.': tr(
    'የተጠናቀቁ ዙሮች እዚህ ይታያሉ።',
    'Marsaaleen xumuraman asitti mulʼatu.',
    'ዝተዛዘሙ ዙራት ኣብዚ ይርኣዩ።',
    'Wareegyada dhammaaday halkan ayay ka muuqan doonaan.',
    'ستظهر الجولات المكتملة هنا.',
    'Raundi zilizokamilika zitaonekana hapa.',
    'Les manches terminées apparaîtront ici.'
  ),
  'Confirm Bet {slot}': tr(
    'ውርርድ {slot} ያረጋግጡ',
    'Sharaddii {slot} mirkaneessi',
    'ውርርድ {slot} ኣረጋግጽ',
    'Xaqiiji sharadka {slot}',
    'أكد الرهان {slot}',
    'Thibitisha dau {slot}',
    'Confirmer le pari {slot}'
  ),
  'Confirm during entry.': tr(
    'ተሳትፎ ክፍት ሲሆን ያረጋግጡ።',
    'Yeroo seensaa mirkaneessi.',
    'ኣብ ግዜ መእተዊ ኣረጋግጽ።',
    'Xaqiiji inta gelitaanku furan yahay.',
    'أكد أثناء فترة المشاركة.',
    'Thibitisha wakati wa kujiunga.',
    'Confirmez pendant les inscriptions.'
  ),
  'Confirm pending round': tr(
    'በጥበቃ ላይ ያለውን ዙር ያረጋግጡ',
    'Marsaa eegaa jiru mirkaneessi',
    'ዝጽበ ዘሎ ዙር ኣረጋግጽ',
    'Xaqiiji wareegga sugaya',
    'أكد الجولة المعلقة',
    'Thibitisha raundi inayosubiri',
    'Confirmer la manche en attente'
  ),
  'Confirm practice bet': tr(
    'የልምምድ ውርርድ ያረጋግጡ',
    'Sharaddii shaakalaa mirkaneessi',
    'ውርርድ ልምምድ ኣረጋግጽ',
    'Xaqiiji sharadka tababarka',
    'أكد رهان التدريب',
    'Thibitisha dau la mazoezi',
    'Confirmer le pari dʼentraînement'
  ),
  'Confirm practice selection': tr(
    'የልምምድ ምርጫ ያረጋግጡ',
    'Filannoo shaakalaa mirkaneessi',
    'ምርጫ ልምምድ ኣረጋግጽ',
    'Xaqiiji doorashada tababarka',
    'أكد اختيار التدريب',
    'Thibitisha chaguo la mazoezi',
    'Confirmer la sélection dʼentraînement'
  ),
  'Confirm ticket': tr(
    'ትኬቱን ያረጋግጡ',
    'Tikeetii mirkaneessi',
    'ትኬት ኣረጋግጽ',
    'Xaqiiji tigidhka',
    'أكد التذكرة',
    'Thibitisha tiketi',
    'Confirmer le ticket'
  ),
  'Confirm ticket · {cost} ETB': tr(
    'ትኬቱን ያረጋግጡ · {cost} ETB',
    'Tikeetii mirkaneessi · {cost} ETB',
    'ትኬት ኣረጋግጽ · {cost} ETB',
    'Xaqiiji tigidhka · {cost} ETB',
    'أكد التذكرة · {cost} ETB',
    'Thibitisha tiketi · {cost} ETB',
    'Confirmer le ticket · {cost} ETB'
  ),
  'Confirm ticket · {value} ETB': tr(
    'ትኬቱን ያረጋግጡ · {value} ETB',
    'Tikeetii mirkaneessi · {value} ETB',
    'ትኬት ኣረጋግጽ · {value} ETB',
    'Xaqiiji tigidhka · {value} ETB',
    'أكد التذكرة · {value} ETB',
    'Thibitisha tiketi · {value} ETB',
    'Confirmer le ticket · {value} ETB'
  ),
  'Confirm your practice selection': tr(
    'የልምምድ ምርጫዎን ያረጋግጡ',
    'Filannoo shaakalaa kee mirkaneessi',
    'ምርጫ ልምምድካ ኣረጋግጽ',
    'Xaqiiji doorashadaada tababarka',
    'أكد اختيارك للتدريب',
    'Thibitisha chaguo lako la mazoezi',
    'Confirmez votre sélection dʼentraînement'
  ),
  'Confirm your ticket before the round starts': tr(
    'ዙሩ ከመጀመሩ በፊት ትኬትዎን ያረጋግጡ',
    'Marsaan osoo hin jalqabin tikeetii kee mirkaneessi',
    'ቅድሚ ዙር ምጅማሩ ትኬትካ ኣረጋግጽ',
    'Xaqiiji tigidhkaaga ka hor bilowga wareegga',
    'أكد تذكرتك قبل بدء الجولة',
    'Thibitisha tiketi yako kabla raundi haijaanza',
    'Confirmez votre ticket avant le début de la manche'
  ),
  'Confirmed at {value}× · includes stake': tr(
    'በ{value}× ተረጋግጧል · መዋጮውን ያካትታል',
    '{value}× irratti mirkanaaʼe · maallaqa sharaddii dabalata',
    'ኣብ {value}× ተረጋጊጹ · መጠን ውርርድ የካትት',
    'Waxaa lagu xaqiijiyey {value}× · waxaa ku jira lacagtii sharadka',
    'مؤكد عند {value}× · يشمل مبلغ الرهان',
    'Imethibitishwa kwa {value}× · inajumuisha dau',
    'Confirmé à {value}× · mise incluse'
  ),
  'Confirmed bets': tr(
    'የተረጋገጡ ውርርዶች',
    'Sharaddilee mirkanaaʼan',
    'ዝተረጋገጹ ውርርዳት',
    'Sharadyo la xaqiijiyey',
    'رهانات مؤكدة',
    'Dau zilizothibitishwa',
    'Paris confirmés'
  ),
  'Confirmed selection': tr(
    'የተረጋገጠ ምርጫ',
    'Filannoo mirkanaaʼe',
    'ዝተረጋገጸ ምርጫ',
    'Doorasho la xaqiijiyey',
    'اختيار مؤكد',
    'Chaguo lililothibitishwa',
    'Sélection confirmée'
  ),
  'Confirmed · awaiting result': tr(
    'ተረጋግጧል · ውጤትን በመጠበቅ ላይ',
    'Mirkanaaʼeera · buʼaa eegaa jira',
    'ተረጋጊጹ · ውጽኢት ይጽበ ኣሎ',
    'La xaqiijiyey · natiijada ayaa la sugayaa',
    'مؤكد · بانتظار النتيجة',
    'Imethibitishwa · inasubiri matokeo',
    'Confirmé · en attente du résultat'
  ),
  'Confirmed · waiting for draw': tr(
    'ተረጋግጧል · ዕጣውን በመጠበቅ ላይ',
    'Mirkanaaʼeera · baafama eegaa jira',
    'ተረጋጊጹ · ዕጫ ይጽበ ኣሎ',
    'La xaqiijiyey · soo saarista ayaa la sugayaa',
    'مؤكد · بانتظار السحب',
    'Imethibitishwa · inasubiri droo',
    'Confirmé · en attente du tirage'
  ),
  'Confirmed · waiting for results': tr(
    'ተረጋግጧል · ውጤቶችን በመጠበቅ ላይ',
    'Mirkanaaʼeera · buʼaawwan eegaa jira',
    'ተረጋጊጹ · ውጽኢታት ይጽበ ኣሎ',
    'La xaqiijiyey · natiijooyinka ayaa la sugayaa',
    'مؤكد · بانتظار النتائج',
    'Imethibitishwa · inasubiri matokeo',
    'Confirmé · en attente des résultats'
  ),
  'Confirmed · waiting for showdown': tr(
    'ተረጋግጧል · ካርዶች እስኪገለጡ በመጠበቅ ላይ',
    'Mirkanaaʼeera · kaardii mulʼisuu eegaa jira',
    'ተረጋጊጹ · ምግላጽ ካርታ ይጽበ ኣሎ',
    'La xaqiijiyey · muujinta kaararka ayaa la sugayaa',
    'مؤكد · بانتظار كشف الأيدي',
    'Imethibitishwa · inasubiri kuonyeshwa kwa kadi',
    'Confirmé · en attente de lʼabattage'
  ),
  'Confirmed · {value}×': tr(
    'ተረጋግጧል · {value}×',
    'Mirkanaaʼeera · {value}×',
    'ተረጋጊጹ · {value}×',
    'La xaqiijiyey · {value}×',
    'مؤكد · {value}×',
    'Imethibitishwa · {value}×',
    'Confirmé · {value}×'
  ),
  'Confirming cash-out…': tr(
    'መውጣትዎን በማረጋገጥ ላይ…',
    'Kaffaltii fudhachuu mirkaneessaa jira…',
    'ምውጻእ የረጋግጽ ኣሎ…',
    'La xaqiijinayo lacag-bixitaanka…',
    'جارٍ تأكيد الصرف…',
    'Inathibitisha kuchukua malipo…',
    'Confirmation de lʼencaissement…'
  ),
  'Confirming round…': tr(
    'ዙሩን በማረጋገጥ ላይ…',
    'Marsaa mirkaneessaa jira…',
    'ዙር የረጋግጽ ኣሎ…',
    'La xaqiijinayo wareegga…',
    'جارٍ تأكيد الجولة…',
    'Inathibitisha raundi…',
    'Confirmation de la manche…'
  ),
  'Confirming saved ticket…': tr(
    'የተቀመጠውን ትኬት በማረጋገጥ ላይ…',
    'Tikeetii kuufame mirkaneessaa jira…',
    'ዝተዓቀበ ትኬት የረጋግጽ ኣሎ…',
    'La xaqiijinayo tigidhka kaydsan…',
    'جارٍ تأكيد التذكرة المحفوظة…',
    'Inathibitisha tiketi iliyohifadhiwa…',
    'Confirmation du ticket enregistré…'
  ),
  'Confirming your guess…': tr(
    'ግምትዎን በማረጋገጥ ላይ…',
    'Tilmaama kee mirkaneessaa jira…',
    'ግምትካ የረጋግጽ ኣሎ…',
    'La xaqiijinayo qiyaastaada…',
    'جارٍ تأكيد تخمينك…',
    'Inathibitisha kadirio lako…',
    'Confirmation de votre nombre…'
  ),
  'Confirming…': tr(
    'በማረጋገጥ ላይ…',
    'Mirkaneessaa jira…',
    'የረጋግጽ ኣሎ…',
    'Waa la xaqiijinayaa…',
    'جارٍ التأكيد…',
    'Inathibitisha…',
    'Confirmation…'
  ),
  Connected: tr(
    'ተገናኝቷል',
    'Walqunnameera',
    'ተራኺቡ',
    'Xiriirku wuu shaqaynayaa',
    'متصل',
    'Imeunganishwa',
    'Connecté'
  ),
  Connecting: tr(
    'በማገናኘት ላይ',
    'Walqunnamaa jira',
    'ይራኸብ ኣሎ',
    'Waa la isku xirayaa',
    'جارٍ الاتصال',
    'Inaunganisha',
    'Connexion'
  ),
  'Connecting to the system table…': tr(
    'ከስርዓቱ ጠረጴዛ ጋር በማገናኘት ላይ…',
    'Minjaala sirnaatti walqunnamaa jira…',
    'ምስ ጠረጴዛ ስርዓት ይራኸብ ኣሎ…',
    'Waxaa lagu xirmayaa miiska nidaamka…',
    'جارٍ الاتصال بطاولة النظام…',
    'Inaunganisha kwenye meza ya mfumo…',
    'Connexion à la table du système…'
  ),
  'Connecting…': tr(
    'በማገናኘት ላይ…',
    'Walqunnamaa jira…',
    'ይራኸብ ኣሎ…',
    'Waa la isku xirayaa…',
    'جارٍ الاتصال…',
    'Inaunganisha…',
    'Connexion…'
  ),
  'Could not check casino availability.': tr(
    'የካዚኖ አቅርቦትን ማረጋገጥ አልተቻለም።',
    'Kaazinoon jiraachuu isaa ilaaluun hin dandaʼamne.',
    'ካዚኖ ምርካቡ ምፍታሽ ኣይተኻእለን።',
    'Lama hubin karin helitaanka kaasiinada.',
    'تعذر التحقق من توفر الكازينو.',
    'Haikuwezekana kukagua upatikanaji wa kasino.',
    'Impossible de vérifier la disponibilité du casino.'
  ),
  'Could not check the test balance.': tr(
    'የሙከራ ቀሪ ገንዘቡን ማረጋገጥ አልተቻለም።',
    'Haftee yaalii ilaaluun hin dandaʼamne.',
    'ተረፍ ሕሳብ ፈተነ ምፍታሽ ኣይተኻእለን።',
    'Lama hubin karin hadhaaga tijaabada.',
    'تعذر فحص رصيد الاختبار.',
    'Haikuwezekana kukagua salio la majaribio.',
    'Impossible de vérifier le solde de test.'
  ),
  'Crash Point': tr(
    'ክራሽ ፖይንት',
    'Crash Point',
    'ክራሽ ፖይንት',
    'Crash Point',
    'كراش بوينت',
    'Crash Point',
    'Crash Point'
  ),
  'Crash Point practice is unavailable.': tr(
    'የክራሽ ፖይንት ልምምድ አይገኝም።',
    'Shaakalli Crash Point hin jiru.',
    'ልምምድ ክራሽ ፖይንት ኣይርከብን።',
    'Tababarka Crash Point lama heli karo.',
    'تدريب كراش بوينت غير متاح.',
    'Mazoezi ya Crash Point hayapatikani.',
    'Lʼentraînement Crash Point est indisponible.'
  ),
  'Crash Point rules': tr(
    'የክራሽ ፖይንት ህጎች',
    'Seerota Crash Point',
    'ሕግታት ክራሽ ፖይንት',
    'Xeerarka Crash Point',
    'قواعد كراش بوينت',
    'Kanuni za Crash Point',
    'Règles de Crash Point'
  ),
  'Crash point': tr(
    'የክራሽ ነጥብ',
    'Qabxii kufaatii',
    'ነጥቢ ክራሽ',
    'Barta burburka',
    'نقطة الانهيار',
    'Kiwango cha kuanguka',
    'Point de crash'
  ),
  'Current round': tr(
    'የአሁኑ ዙር',
    'Marsaa ammaa',
    'እዋናዊ ዙር',
    'Wareegga hadda',
    'الجولة الحالية',
    'Raundi ya sasa',
    'Manche actuelle'
  ),
  DERBY: tr('ደርቢ', 'DAARBII', 'ደርቢ', 'DERBY', 'ديربي', 'DERBY', 'DERBY'),
  'DICE IN MOTION': tr(
    'ዳይሶች እየተንቀሳቀሱ ነው',
    'DAAYISIIN SOCHII IRRA',
    'ዳይሳት ይንቀሳቐሱ ኣለዉ',
    'LAADHUUGU WUU SOCDAA',
    'النرد يتحرك',
    'KETE ZINAZUNGUKA',
    'DÉS EN MOUVEMENT'
  ),
  'DOG RACING': tr(
    'የውሻ ውድድር',
    'FIIGICHA SAREE',
    'ውድድር ኣኽላባት',
    'TARTANKA EEYAHA',
    'سباق الكلاب',
    'MBIO ZA MBWA',
    'COURSE DE CHIENS'
  ),
  DRAW: tr('ዕጣ', 'BAAFAMA', 'ዕጫ', 'SOO SAARID', 'سحب', 'DROO', 'TIRAGE'),
  'DRAW COMPLETE': tr(
    'ዕጣው ተጠናቋል',
    'BAAFAMNI XUMURAMEERA',
    'ዕጫ ተዛዚሙ',
    'SOO SAARISTU WAY DHAMMAATAY',
    'اكتمل السحب',
    'DROO IMEKAMILIKA',
    'TIRAGE TERMINÉ'
  ),
  'Dealing cards': tr(
    'ካርዶችን በማከፋፈል ላይ',
    'Kaardii qoodaa jira',
    'ካርታታት ይዕደሉ ኣለዉ',
    'Kaararka ayaa la qaybinayaa',
    'جارٍ توزيع البطاقات',
    'Inagawa kadi',
    'Distribution des cartes'
  ),
  'Decided by': tr(
    'የሚወሰነው በ',
    'Kan murtaaʼu',
    'ዝውሰን ብ',
    'Waxaa goʼaamiya',
    'يُحسم بواسطة',
    'Inaamuliwa na',
    'Déterminé par'
  ),
  'Decides the outside markets': tr(
    'የውጭ ውርርድ ገበያዎችን ይወስናል',
    'Gabaa sharaddii alaa murteessa',
    'ዓይነታት ውርርድ ወጻኢ ይውስን',
    'Waxay goʼaamisaa suuqyada sharadka dibadda',
    'يحسم الأسواق الخارجية',
    'Huamua masoko ya dau za nje',
    'Détermine les paris extérieurs'
  ),
  Declined: tr(
    'ተቀባይነት አላገኘም',
    'Didameera',
    'ተነጺጉ',
    'Waa la diiday',
    'مرفوض',
    'Imekataliwa',
    'Refusé'
  ),
  'Decrease amount': tr(
    'መጠኑን ይቀንሱ',
    'Hanga hirʼisi',
    'መጠን ኣጉድል',
    'Yaree qadarka',
    'تقليل المبلغ',
    'Punguza kiasi',
    'Diminuer le montant'
  ),
  'Decrease bet amount': tr(
    'የውርርድ መጠኑን ይቀንሱ',
    'Hanga sharaddii hirʼisi',
    'መጠን ውርርድ ኣጉድል',
    'Yaree qadarka sharadka',
    'تقليل مبلغ الرهان',
    'Punguza kiasi cha dau',
    'Diminuer le montant du pari'
  ),
  'Decrease number': tr(
    'ቁጥሩን ይቀንሱ',
    'Lakkoofsa hirʼisi',
    'ቁጽሪ ኣጉድል',
    'Yaree lambarka',
    'تقليل الرقم',
    'Punguza namba',
    'Diminuer le nombre'
  ),
  Derby: tr('ደርቢ', 'Daarbii', 'ደርቢ', 'Derby', 'ديربي', 'Derby', 'Derby'),
  Dice: tr('ዳይስ', 'Daayisii', 'ዳይስ', 'Laadhuu', 'نرد', 'Kete', 'Dés'),
  'Dice Seven Up': tr(
    'ዳይስ ሰባትና በላይ',
    'Daayisii Torbaa fi Ol',
    'ዳይስ ሸውዓተን ልዕሊኡን',
    'Laadhuu Toddoba iyo Ka Badan',
    'نرد سبعة فأكثر',
    'Kete Saba na Zaidi',
    'Dés Sept ou plus'
  ),
  'Dice awaiting result': tr(
    'ዳይሶች ውጤትን ይጠብቃሉ',
    'Daayisiin buʼaa eegaa jira',
    'ዳይሳት ውጽኢት ይጽበዩ ኣለዉ',
    'Laadhuugu wuxuu sugayaa natiijada',
    'النرد بانتظار النتيجة',
    'Kete zinasubiri matokeo',
    'Dés en attente du résultat'
  ),
  'Die {value}': tr(
    'ዳይስ {value}',
    'Daayisii {value}',
    'ዳይስ {value}',
    'Laadhuu {value}',
    'حجر النرد {value}',
    'Kete {value}',
    'Dé {value}'
  ),
  Distance: tr('ልዩነት', 'Garaagarummaa', 'ፍልልይ', 'Masaafad', 'المسافة', 'Umbali', 'Écart'),
  'Dog Racing': tr(
    'የውሻ ውድድር',
    'Fiigicha Saree',
    'ውድድር ኣኽላባት',
    'Tartanka Eeyaha',
    'سباق الكلاب',
    'Mbio za Mbwa',
    'Course de chiens'
  ),
  Done: tr('ተጠናቋል', 'Xumurameera', 'ተዛዚሙ', 'Waa dhammaatay', 'تم', 'Imekamilika', 'Terminé'),
  'Down the home straight': tr(
    'ወደ መጨረሻው ቀጥታ መስመር',
    'Daandii qajeelaa xumuraa irra',
    'ኣብ መወዳእታ ቀጥታ መስመር',
    'Jidka toosan ee dhammaadka',
    'في المسار المستقيم الأخير',
    'Kwenye sehemu ya mwisho iliyonyooka',
    'Dans la dernière ligne droite'
  ),
  'Download timestamp archive': tr(
    'የጊዜ ማህተም ማህደርን ያውርዱ',
    'Kuusaa mallattoo yeroo buusi',
    'መዝገብ ማሕተም ግዜ ኣውርድ',
    'Soo dejiso kaydka calaamadda waqtiga',
    'تنزيل أرشيف الطابع الزمني',
    'Pakua kumbukumbu ya muhuri wa muda',
    'Télécharger lʼarchive dʼhorodatage'
  ),
  'Download {value} JSON': tr(
    '{value} JSON ያውርዱ',
    '{value} JSON buusi',
    '{value} JSON ኣውርድ',
    'Soo dejiso {value} JSON',
    'تنزيل {value} JSON',
    'Pakua {value} JSON',
    'Télécharger {value} JSON'
  ),
  Draft: tr('ረቂቅ', 'Wixinee', 'ንድፊ', 'Qabyo', 'مسودة', 'Rasimu', 'Brouillon'),
  'Draw complete': tr(
    'ዕጣው ተጠናቋል',
    'Baafamni xumurameera',
    'ዕጫ ተዛዚሙ',
    'Soo saaristu way dhammaatay',
    'اكتمل السحب',
    'Droo imekamilika',
    'Tirage terminé'
  ),
  'Draw result': tr(
    'የዕጣ ውጤት',
    'Buʼaa baafamaa',
    'ውጽኢት ዕጫ',
    'Natiijada soo saarista',
    'نتيجة السحب',
    'Matokeo ya droo',
    'Résultat du tirage'
  ),
  'Draw {value}': tr(
    'ዕጣ {value}',
    'Baafama {value}',
    'ዕጫ {value}',
    'Soo saarid {value}',
    'السحب {value}',
    'Droo {value}',
    'Tirage {value}'
  ),
  'Drawing now': tr(
    'ዕጣ እየወጣ ነው',
    'Amma baafamaa jira',
    'ሕጂ ዕጫ ይወጽእ ኣሎ',
    'Hadda waa la soo saarayaa',
    'السحب جارٍ الآن',
    'Droo inaendelea sasa',
    'Tirage en cours'
  ),
  'Drawing…': tr(
    'ዕጣ በማውጣት ላይ…',
    'Baafamaa jira…',
    'ዕጫ ይወጽእ ኣሎ…',
    'Waa la soo saarayaa…',
    'جارٍ السحب…',
    'Droo inaendelea…',
    'Tirage…'
  ),
  'ENTRIES CLOSED': tr(
    'ተሳትፎ ተዘግቷል',
    'SEENSI CUFAMEERA',
    'ተሳትፎ ተዓጽዩ',
    'GELITAANKU WUU XIRAN YAHAY',
    'المشاركات مغلقة',
    'USAJILI UMEFUNGWA',
    'INSCRIPTIONS FERMÉES'
  ),
  'ENTRIES LOCKED': tr(
    'ተሳትፎዎች ተቆልፈዋል',
    'HIRMAANNAAN JIJJIIRAMUU HIN DANDAʼU',
    'ተሳትፎታት ተቖሊፎም',
    'KA QAYBGALLADA WAA LA XIRAY',
    'المشاركات مقفلة',
    'USHIRIKI UMEFUNGWA',
    'PARTICIPATIONS VERROUILLÉES'
  ),
  'ENTRY OPEN': tr(
    'ተሳትፎ ክፍት ነው',
    'SEENSI BANAMEERA',
    'ተሳትፎ ክፉት እዩ',
    'GELITAANKU WAA FURAN YAHAY',
    'المشاركة مفتوحة',
    'USAJILI UMEFUNGULIWA',
    'INSCRIPTIONS OUVERTES'
  ),
  'ENTRY WINDOW OPEN': tr(
    'የተሳትፎ ጊዜ ክፍት ነው',
    'YEROON SEENSAA BANAMEERA',
    'ግዜ ተሳትፎ ክፉት እዩ',
    'WAQTIGA GELITAANKU WAA FURAN YAHAY',
    'فترة المشاركة مفتوحة',
    'MUDA WA USAJILI UMEFUNGULIWA',
    'PÉRIODE DʼINSCRIPTION OUVERTE'
  ),
  'ETB per color line': tr(
    'ETB በእያንዳንዱ የቀለም መስመር',
    'ETB sarara halluu tokkoof',
    'ETB ንነፍሲ ወከፍ መስመር ሕብሪ',
    'ETB sadar midab kasta',
    'ETB لكل صف لون',
    'ETB kwa kila mstari wa rangi',
    'ETB par ligne de couleur'
  ),
  'ETB per number': tr(
    'ETB በእያንዳንዱ ቁጥር',
    'ETB lakkoofsa tokkoof',
    'ETB ንነፍሲ ወከፍ ቁጽሪ',
    'ETB lambar kasta',
    'ETB لكل رقم',
    'ETB kwa kila namba',
    'ETB par numéro'
  ),
  'ETB per ticket': tr(
    'ETB በእያንዳንዱ ትኬት',
    'ETB tikeetii tokkoof',
    'ETB ንነፍሲ ወከፍ ትኬት',
    'ETB tigidh kasta',
    'ETB لكل تذكرة',
    'ETB kwa kila tiketi',
    'ETB par ticket'
  ),
  'ETB · no cash value': tr(
    'ETB · የገንዘብ ዋጋ የለውም',
    'ETB · gatii maallaqaa hin qabu',
    'ETB · ዋጋ ገንዘብ የብሉን',
    'ETB · qiime lacageed ma leh',
    'ETB · بلا قيمة نقدية',
    'ETB · haina thamani ya pesa',
    'ETB · sans valeur monétaire'
  ),
  'ETB.': tr('ETB።', 'ETB.', 'ETB።', 'ETB.', 'ETB.', 'ETB.', 'ETB.'),
  'Each match returns {value} credits': tr(
    'እያንዳንዱ ተዛማጅ {value} ክሬዲቶችን ይመልሳል',
    'Walsimannaan hundi kiridiitii {value} deebisa',
    'ነፍሲ ወከፍ ዝተዛመደ {value} ክሬዲት ይመልስ',
    'Iswaafajin kasta waxay soo celisaa {value} dhibco lacageed',
    'كل مطابقة تعيد {value} من رصيد اللعب',
    'Kila inayolingana hurudisha vitengo {value} vya mchezo',
    'Chaque correspondance rapporte {value} crédits'
  ),
  'Earlier saved commitment (optional)': tr(
    'ቀደም ሲል የተቀመጠ ማረጋገጫ (አማራጭ)',
    'Ragaa duraan kuufame (filannoo)',
    'ቅድሚ ሕጂ ዝተዓቀበ መረጋገጺ (ኣማራጺ)',
    'Xaqiijin hore oo kaydsan (ikhtiyaari)',
    'التزام محفوظ سابقًا (اختياري)',
    'Uthibitisho uliohifadhiwa awali (hiari)',
    'Engagement enregistré auparavant (facultatif)'
  ),
  'Eight colors · six balls each': tr(
    'ስምንት ቀለሞች · በእያንዳንዱ ስድስት ኳሶች',
    'Halluu saddeet · tokkoon tokkoon kubbaa jaʼa',
    'ሸሞንተ ሕብርታት · ነፍሲ ወከፎም ሽዱሽተ ኩዕሶታት',
    'Siddeed midab · mid kasta lix kubbadood',
    'ثمانية ألوان · ست كرات لكل لون',
    'Rangi nane · mipira sita kila moja',
    'Huit couleurs · six boules chacune'
  ),
  'Entries closed': tr(
    'ተሳትፎ ተዘግቷል',
    'Seensi cufameera',
    'ተሳትፎ ተዓጽዩ',
    'Gelitaanku wuu xiran yahay',
    'المشاركات مغلقة',
    'Usajili umefungwa',
    'Inscriptions fermées'
  ),
  'Entry closes': tr(
    'ተሳትፎ ይዘጋል',
    'Seensi ni cufama',
    'ተሳትፎ ይዕጾ',
    'Gelitaanku wuu xirmayaa',
    'تُغلق المشاركة',
    'Usajili unafungwa',
    'Les inscriptions ferment'
  ),
};
export default catalogue;
