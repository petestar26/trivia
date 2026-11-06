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
  'Number from 1 to 100': tr(
    'ከ1 እስከ 100 ቁጥር',
    'Lakkoofsa 1 hanga 100',
    'ቁጽሪ ካብ 1 ክሳብ 100',
    'Lambar ka socda 1 ilaa 100',
    'رقم من 1 إلى 100',
    'Namba kutoka 1 hadi 100',
    'Nombre de 1 à 100'
  ),
  'Number {n}': tr(
    'ቁጥር {n}',
    'Lakkoofsa {n}',
    'ቁጽሪ {n}',
    'Lambar {n}',
    'الرقم {n}',
    'Namba {n}',
    'Numéro {n}'
  ),
  'Number {n}{value}': tr(
    'ቁጥር {n}{value}',
    'Lakkoofsa {n}{value}',
    'ቁጽሪ {n}{value}',
    'Lambar {n}{value}',
    'الرقم {n}{value}',
    'Namba {n}{value}',
    'Numéro {n}{value}'
  ),
  'Number {n}{value}{value2}': tr(
    'ቁጥር {n}{value}{value2}',
    'Lakkoofsa {n}{value}{value2}',
    'ቁጽሪ {n}{value}{value2}',
    'Lambar {n}{value}{value2}',
    'الرقم {n}{value}{value2}',
    'Namba {n}{value}{value2}',
    'Numéro {n}{value}{value2}'
  ),
  'Numbers · 1–10 picks': tr(
    'ቁጥሮች · 1–10 ምርጫዎች',
    'Lakkoofsota · filannoowwan 1–10',
    'ቁጽርታት · 1–10 ምርጫታት',
    'Lambarro · 1–10 doorasho',
    'أرقام · 1–10 اختيارات',
    'Namba · chaguo 1–10',
    'Numéros · 1–10 choix'
  ),
  'OFFICIAL FINISH': tr(
    'ይፋዊ አጨራረስ',
    'XUMURA MIRKANAAʼE',
    'ወግዓዊ መዛዘሚ',
    'DHAMMAADKA RASMIGA AH',
    'النهاية الرسمية',
    'MWISHO RASMI',
    'ARRIVÉE OFFICIELLE'
  ),
  'OFFICIAL RESULT': tr(
    'ይፋዊ ውጤት',
    'BUʼAA MIRKANAAʼE',
    'ወግዓዊ ውጽኢት',
    'NATIIJADA RASMIGA AH',
    'النتيجة الرسمية',
    'MATOKEO RASMI',
    'RÉSULTAT OFFICIEL'
  ),
  'Official finish': tr(
    'ይፋዊ አጨራረስ',
    'Xumura mirkanaaʼe',
    'ወግዓዊ መዛዘሚ',
    'Dhammaadka rasmiga ah',
    'النهاية الرسمية',
    'Mwisho rasmi',
    'Arrivée officielle'
  ),
  'Official finishing order': tr(
    'ይፋዊ የመጨረሻ ቅደም ተከተል',
    'Tartiiba xumuraa mirkanaaʼe',
    'ወግዓዊ ቅደም ተኸተል መዛዘሚ',
    'Kala horreynta rasmiga ah ee dhammaadka',
    'ترتيب الوصول الرسمي',
    'Mpangilio rasmi wa kumaliza',
    'Ordre dʼarrivée officiel'
  ),
  'Official race result': tr(
    'ይፋዊ የውድድር ውጤት',
    'Buʼaa fiigichaa mirkanaaʼe',
    'ወግዓዊ ውጽኢት ውድድር',
    'Natiijada rasmiga ah ee tartanka',
    'نتيجة السباق الرسمية',
    'Matokeo rasmi ya mbio',
    'Résultat officiel de la course'
  ),
  'One new round every minute.': tr(
    'በየደቂቃው አንድ አዲስ ዙር።',
    'Daqiiqaa hunda marsaa haaraa tokko.',
    'ኣብ ነፍሲ ወከፍ ደቒቕ ሓደ ሓድሽ ዙር።',
    'Hal wareeg oo cusub daqiiqad kasta.',
    'جولة جديدة كل دقيقة.',
    'Raundi moja mpya kila dakika.',
    'Une nouvelle manche chaque minute.'
  ),
  'One ticket': tr(
    'አንድ ትኬት',
    'Tikeetii tokko',
    'ሓደ ትኬት',
    'Hal tigidh',
    'تذكرة واحدة',
    'Tiketi moja',
    'Un ticket'
  ),
  'Only the first drawn ball counts.': tr(
    'መጀመሪያ የወጣችው ኳስ ብቻ ትቆጠራለች።',
    'Kubbaa jalqabaa baafamte qofatu lakkaaʼama.',
    'ቀዳመይቲ ዝወጸት ኩዕሶ ጥራይ ትቑጸር።',
    'Kubbadda koowaad ee la soo saaro oo keliya ayaa la xisaabiyaa.',
    'تُحتسب الكرة الأولى المسحوبة فقط.',
    'Mpira wa kwanza uliotolewa pekee huhesabiwa.',
    'Seule la première boule tirée compte.'
  ),
  'Open result {id}': tr(
    'ውጤት {id} ክፈት',
    'Buʼaa {id} bani',
    'ውጽኢት {id} ክፈት',
    'Fur natiijada {id}',
    'افتح النتيجة {id}',
    'Fungua matokeo {id}',
    'Ouvrir le résultat {id}'
  ),
  Opening: tr(
    'በመክፈት ላይ',
    'Banaa jira',
    'ይኸፍት ኣሎ',
    'Waa la furayaa',
    'جارٍ الفتح',
    'Inafungua',
    'Ouverture'
  ),
  'Other bet types': tr(
    'ሌሎች የውርርድ ዓይነቶች',
    'Gosoota sharaddii biroo',
    'ካልኦት ዓይነታት ውርርድ',
    'Noocyo kale oo sharad ah',
    'أنواع رهانات أخرى',
    'Aina nyingine za dau',
    'Autres types de paris'
  ),
  'PLACE YOUR TICKET': tr(
    'ትኬትዎን ያስገቡ',
    'TIKEETII KEE GALCHI',
    'ትኬትካ ኣእቱ',
    'GELI TIGIDHKAAGA',
    'سجّل تذكرتك',
    'WEKA TIKETI YAKO',
    'PLACEZ VOTRE TICKET'
  ),
  POINT: tr('ነጥብ', 'QABXII', 'ነጥቢ', 'DHIBIC', 'نقطة', 'ALAMA', 'POINT'),
  'PRACTICE BALANCE': tr(
    'የልምምድ ቀሪ ገንዘብ',
    'HAFTEE SHAAKALAA',
    'ተረፍ ሕሳብ ልምምድ',
    'HADHAAGA TABABARKA',
    'رصيد التدريب',
    'SALIO LA MAZOEZI',
    'SOLDE DʼENTRAÎNEMENT'
  ),
  'Page {page} of {totalPages}': tr(
    'ገጽ {page} ከ{totalPages}',
    'Fuula {page} keessaa {totalPages}',
    'ገጽ {page} ካብ {totalPages}',
    'Bogga {page} ee {totalPages}',
    'الصفحة {page} من {totalPages}',
    'Ukurasa {page} kati ya {totalPages}',
    'Page {page} sur {totalPages}'
  ),
  'Past bet {slot} receipt': tr(
    'ያለፈው ውርርድ {slot} ደረሰኝ',
    'Nagahee sharaddii darbe {slot}',
    'ቅብሊት ዝሓለፈ ውርርድ {slot}',
    'Rasiidka sharadkii hore {slot}',
    'إيصال الرهان السابق {slot}',
    'Risiti ya dau la awali {slot}',
    'Reçu du pari passé {slot}'
  ),
  'Past round': tr(
    'ያለፈ ዙር',
    'Marsaa darbe',
    'ዝሓለፈ ዙር',
    'Wareeg hore',
    'جولة سابقة',
    'Raundi iliyopita',
    'Manche passée'
  ),
  'Pause previews': tr(
    'ቅድመ እይታዎችን ለአፍታ አቁም',
    'Dursanii ilaaluu dhaabi',
    'ቅድመ ርእይቶ ኣቋርጽ',
    'Haki muuqaallada hordhaca',
    'إيقاف المعاينات مؤقتًا',
    'Sitisha maonyesho ya awali',
    'Mettre les aperçus en pause'
  ),
  'Pending settlement': tr(
    'ክፍያ መጠናቀቅን በመጠበቅ ላይ',
    'Xumura kaffaltii eegaa jira',
    'ምጽፋፍ ክፍሊት ይጽበ ኣሎ',
    'Sugaya xisaab-xirka',
    'بانتظار التسوية',
    'Inasubiri kukamilishwa kwa malipo',
    'Règlement en attente'
  ),
  'Pick 1–10 numbers · all 18 balls count': tr(
    '1–10 ቁጥሮችን ይምረጡ · ሁሉም 18 ኳሶች ይቆጠራሉ',
    'Lakkoofsota 1–10 filadhu · kubbaawwan 18 hundi lakkaaʼamu',
    '1–10 ቁጽርታት ምረጽ · ኩለን 18 ኩዕሶታት ይቑጸራ',
    'Dooro 1–10 lambar · dhammaan 18-ka kubbadood waa la xisaabiyaa',
    'اختر 1–10 أرقام · تُحتسب الكرات الـ18 كلها',
    'Chagua namba 1–10 · mipira yote 18 huhesabiwa',
    'Choisissez 1–10 numéros · les 18 boules comptent'
  ),
  'Pick a game and start playing.': tr(
    'ጨዋታ መርጠው መጫወት ይጀምሩ።',
    'Tapha filadhuutii taphachuu jalqabi.',
    'ጸወታ መሪጽካ ምጽዋት ጀምር።',
    'Dooro ciyaar oo bilow ciyaarista.',
    'اختر لعبة وابدأ اللعب.',
    'Chagua mchezo na uanze kucheza.',
    'Choisissez un jeu et commencez à jouer.'
  ),
  'Pick one option · first ball only': tr(
    'አንድ አማራጭ ይምረጡ · የመጀመሪያው ኳስ ብቻ',
    'Filannoo tokko filadhu · kubbaa jalqabaa qofa',
    'ሓደ ኣማራጺ ምረጽ · ቀዳመይቲ ኩዕሶ ጥራይ',
    'Dooro hal ikhtiyaar · kubbadda koowaad oo keliya',
    'اختر خيارًا واحدًا · الكرة الأولى فقط',
    'Chagua chaguo moja · mpira wa kwanza pekee',
    'Choisissez une option · première boule uniquement'
  ),
  'Pick six.': tr(
    'ስድስት ይምረጡ።',
    'Jaʼa filadhu.',
    'ሽዱሽተ ምረጽ።',
    'Dooro lix.',
    'اختر ستة.',
    'Chagua sita.',
    'Choisissez-en six.'
  ),
  'Pick your finish': tr(
    'የመጨረሻ ውጤትዎን ይምረጡ',
    'Xumura kee filadhu',
    'መዛዘሚኻ ምረጽ',
    'Dooro dhammaadkaaga',
    'اختر ترتيب الوصول',
    'Chagua nafasi yako ya mwisho',
    'Choisissez votre arrivée'
  ),
  'Pinned beacon': tr(
    'የተወሰነ የዕድል ምንጭ',
    'Madda tasaa murtaaʼe',
    'ዝተወሰነ ምንጪ ዕድል',
    'Ilaha nasiibka ee la xaddiday',
    'منارة العشوائية المثبتة',
    'Chanzo cha nasibu kilichowekwa',
    'Balise aléatoire fixée'
  ),
  'Place Coin bets': tr(
    'የሳንቲም ውርርዶችን ያስገቡ',
    'Sharaddilee saantimaa galchi',
    'ውርርድ ሳንቲም ኣእቱ',
    'Geli sharadyada qadaadiicda',
    'ضع رهانات العملات',
    'Weka dau za sarafu',
    'Placer les paris en pièces'
  ),
  'Place a practice bet': tr(
    'የልምምድ ውርርድ ያስገቡ',
    'Sharaddii shaakalaa galchi',
    'ውርርድ ልምምድ ኣእቱ',
    'Geli sharad tababar ah',
    'ضع رهانًا تدريبيًا',
    'Weka dau la mazoezi',
    'Placer un pari dʼentraînement'
  ),
  'Place guess': tr(
    'ግምት ያስገቡ',
    'Tilmaama galchi',
    'ግምት ኣእቱ',
    'Geli qiyaas',
    'سجّل التخمين',
    'Weka kadirio',
    'Enregistrer le nombre'
  ),
  'Place your bets': tr(
    'ውርርዶችዎን ያስገቡ',
    'Sharaddilee kee galchi',
    'ውርርዳትካ ኣእቱ',
    'Geli sharadyadaada',
    'ضع رهاناتك',
    'Weka dau zako',
    'Placez vos paris'
  ),
  'Place your guess': tr(
    'ግምትዎን ያስገቡ',
    'Tilmaama kee galchi',
    'ግምትካ ኣእቱ',
    'Geli qiyaastaada',
    'سجّل تخمينك',
    'Weka kadirio lako',
    'Enregistrez votre nombre'
  ),
  'Play modes': tr(
    'የጨዋታ ሁነታዎች',
    'Haalota taphaa',
    'ኣገባባት ጸወታ',
    'Hababka ciyaarta',
    'أوضاع اللعب',
    'Hali za kucheza',
    'Modes de jeu'
  ),
  'Play {name}': tr(
    '{name} ይጫወቱ',
    '{name} taphadhu',
    '{name} ተጻወት',
    'Ciyaar {name}',
    'العب {name}',
    'Cheza {name}',
    'Jouer à {name}'
  ),
  Player: tr('ተጫዋች', 'Taphataa', 'ተጻዋታይ', 'Ciyaaryahan', 'لاعب', 'Mchezaji', 'Joueur'),
  Point: tr('ነጥብ', 'Qabxii', 'ነጥቢ', 'Dhibic', 'نقطة', 'Alama', 'Point'),
  'Practice ETB': tr(
    'የልምምድ ETB',
    'ETB shaakalaa',
    'ናይ ልምምድ ETB',
    'ETB tababar',
    'ETB تدريبي',
    'ETB za mazoezi',
    'ETB dʼentraînement'
  ),
  'Practice is unavailable. Please try again later.': tr(
    'ልምምድ አይገኝም። እባክዎ ቆይተው ይሞክሩ።',
    'Shaakalli hin jiru. Maaloo booda deebiʼii yaali.',
    'ልምምድ ኣይርከብን። በጃኻ ድሒርካ ፈትን።',
    'Tababarka lama heli karo. Fadlan mar dambe isku day.',
    'التدريب غير متاح. حاول لاحقًا.',
    'Mazoezi hayapatikani. Tafadhali jaribu baadaye.',
    'Lʼentraînement est indisponible. Réessayez plus tard.'
  ),
  'Practice limits': tr(
    'የልምምድ ገደቦች',
    'Daangaawwan shaakalaa',
    'ገደባት ልምምድ',
    'Xadka tababarka',
    'حدود التدريب',
    'Mipaka ya mazoezi',
    'Limites dʼentraînement'
  ),
  'Practice return {payout} ETB': tr(
    'የልምምድ ተመላሽ {payout} ETB',
    'Deebii shaakalaa {payout} ETB',
    'ተመላሲ ልምምድ {payout} ETB',
    'Soo-noqoshada tababarka {payout} ETB',
    'عائد التدريب {payout} ETB',
    'Malipo ya mazoezi {payout} ETB',
    'Retour dʼentraînement {payout} ETB'
  ),
  'Practice rules & recent draws': tr(
    'የልምምድ ህጎች እና የቅርብ ጊዜ ዕጣዎች',
    'Seerota shaakalaa fi baafamoota dhiyoo',
    'ሕግታት ልምምድን ናይ ቀረባ ዕጫታትን',
    'Xeerarka tababarka iyo soo saaristii dhowayd',
    'قواعد التدريب والسحوبات الأخيرة',
    'Kanuni za mazoezi na droo za karibuni',
    'Règles dʼentraînement et tirages récents'
  ),
  'Practice scores cannot be spent or transferred.': tr(
    'የልምምድ ነጥቦች ለክፍያ ሊውሉ ወይም ሊተላለፉ አይችሉም።',
    'Qabxiin shaakalaa baasii taʼuu yookaan dabarfamuu hin dandaʼu.',
    'ነጥብታት ልምምድ ክወጹ ወይ ክመሓላለፉ ኣይክእሉን።',
    'Dhibcaha tababarka lama kharash garayn karo lamana wareejin karo.',
    'لا يمكن إنفاق نقاط التدريب أو تحويلها.',
    'Alama za mazoezi haziwezi kutumika kununua au kuhamishwa.',
    'Les scores dʼentraînement ne peuvent être dépensés ni transférés.'
  ),
  'Practice stake': tr(
    'የልምምድ ውርርድ መጠን',
    'Hanga sharaddii shaakalaa',
    'መጠን ውርርድ ልምምድ',
    'Lacagta sharadka tababarka',
    'مبلغ رهان التدريب',
    'Kiasi cha dau la mazoezi',
    'Mise dʼentraînement'
  ),
  'Practice · this tab': tr(
    'ልምምድ · በዚህ ትር',
    'Shaakala · caancala kana',
    'ልምምድ · እዚ ትር',
    'Tababar · qaybtan',
    'تدريب · هذا التبويب',
    'Mazoezi · kichupo hiki',
    'Entraînement · cet onglet'
  ),
  'Predict the dealer’s final total.': tr(
    'የአከፋፋዩን የመጨረሻ ድምር ይገምቱ።',
    'Idaʼama xumuraa qoodaa kaardii tilmaami.',
    'ናይ ኣከፋፋሊ ናይ መወዳእታ ድምር ገምት።',
    'Saadaali wadarta kama dambaysta ah ee qaybiyaha.',
    'توقّع المجموع النهائي للموزع.',
    'Tabiri jumla ya mwisho ya mgawaji.',
    'Prédisez le total final du croupier.'
  ),
  'Predict this seat’s result against the dealer.': tr(
    'የዚህን መቀመጫ ውጤት ከአከፋፋዩ ጋር ይገምቱ።',
    'Buʼaa teessoo kanaa qoodaa irratti tilmaami.',
    'ናይዚ መቐመጢ ውጽኢት ኣንጻር ኣከፋፋሊ ገምት።',
    'Saadaali natiijada kursigan ee ka dhanka ah qaybiyaha.',
    'توقّع نتيجة هذا المقعد أمام الموزع.',
    'Tabiri matokeo ya kiti hiki dhidi ya mgawaji.',
    'Prédisez le résultat de cette place face au croupier.'
  ),
  'Preparing racecourse…': tr(
    'የውድድር መንገድ በማዘጋጀት ላይ…',
    'Daandii fiigichaa qopheessaa jira…',
    'መንገዲ ውድድር የዳሉ ኣሎ…',
    'Waddada tartanka waa la diyaarinayaa…',
    'جارٍ تجهيز المضمار…',
    'Inaandaa uwanja wa mbio…',
    'Préparation de la piste…'
  ),
  'Preparing the racecourse…': tr(
    'የውድድሩን መንገድ በማዘጋጀት ላይ…',
    'Daandii fiigichaa qopheessaa jira…',
    'ነቲ መንገዲ ውድድር የዳሉ ኣሎ…',
    'Waddada tartanka waa la diyaarinayaa…',
    'جارٍ تجهيز المضمار…',
    'Inaandaa uwanja wa mbio…',
    'Préparation de la piste…'
  ),
  'Preparing the stadium…': tr(
    'ስታዲየሙን በማዘጋጀት ላይ…',
    'Istaadiyeemii qopheessaa jira…',
    'ስታድዩም የዳሉ ኣሎ…',
    'Garoonka waa la diyaarinayaa…',
    'جارٍ تجهيز الملعب…',
    'Inaandaa uwanja…',
    'Préparation du stade…'
  ),
  'Previous featured result': tr(
    'ቀዳሚው ተመራጭ ውጤት',
    'Buʼaa filatame darbe',
    'ዝሓለፈ ዝተመርጸ ውጽኢት',
    'Natiijadii hore ee la xushay',
    'النتيجة المميزة السابقة',
    'Matokeo yaliyoangaziwa awali',
    'Résultat précédent à lʼaffiche'
  ),
  'Previous round': tr(
    'ቀዳሚው ዙር',
    'Marsaa darbe',
    'ዝሓለፈ ዙር',
    'Wareeggii hore',
    'الجولة السابقة',
    'Raundi iliyopita',
    'Manche précédente'
  ),
  'Price locked': tr(
    'ማባዣው ተቆልፏል',
    'Gatiin cufameera',
    'ዋጋ ተቖሊፉ',
    'Qiimaha waa la xidhay',
    'المعامل مثبت',
    'Bei imefungwa',
    'Cote verrouillée'
  ),
  'Provider games are temporarily unavailable.': tr(
    'የአቅራቢው ጨዋታዎች ለጊዜው አይገኙም።',
    'Taphoonni dhiyeessaa yeroo muraasaaf hin argaman.',
    'ጸወታታት ኣቕራቢ ንግዚኡ ኣይርከቡን።',
    'Ciyaaraha bixiyaha si ku-meel-gaar ah looma heli karo.',
    'ألعاب المزوّد غير متاحة مؤقتًا.',
    'Michezo ya mtoa huduma haipatikani kwa muda.',
    'Les jeux du fournisseur sont temporairement indisponibles.'
  ),
  'Public practice returns · last 24 hours': tr(
    'ይፋዊ የልምምድ ተመላሾች · ያለፉት 24 ሰዓታት',
    'Deebii shaakalaa ifaa · saʼaatii 24 darban',
    'ህዝባዊ ተመላሲ ልምምድ · ዝሓለፉ 24 ሰዓታት',
    'Soo-noqoshada tababarka ee guud · 24-kii saac ee la soo dhaafay',
    'عوائد التدريب العامة · آخر 24 ساعة',
    'Malipo ya mazoezi ya umma · saa 24 zilizopita',
    'Retours dʼentraînement publics · dernières 24 heures'
  ),
  'Public practice tickets': tr(
    'ይፋዊ የልምምድ ትኬቶች',
    'Tikeetota shaakalaa ifaa',
    'ህዝባዊ ትኬታት ልምምድ',
    'Tigidhada tababarka ee guud',
    'تذاكر التدريب العامة',
    'Tiketi za mazoezi za umma',
    'Tickets dʼentraînement publics'
  ),
  'Public practice tickets for {roundId}': tr(
    'ለ{roundId} ይፋዊ የልምምድ ትኬቶች',
    'Tikeetota shaakalaa ifaa kan {roundId}',
    'ህዝባዊ ትኬታት ልምምድ ን{roundId}',
    'Tigidhada tababarka ee guud ee {roundId}',
    'تذاكر التدريب العامة للجولة {roundId}',
    'Tiketi za mazoezi za umma za {roundId}',
    'Tickets dʼentraînement publics de {roundId}'
  ),
  'Public top returns': tr(
    'ይፋዊ ከፍተኛ ተመላሾች',
    'Deebiiwwan olaanaa ifaa',
    'ህዝባዊ ልዑላት ተመላሲታት',
    'Soo-noqoshada ugu sarreysa ee guud',
    'أعلى العوائد العامة',
    'Malipo ya juu ya umma',
    'Meilleurs retours publics'
  ),
  'Quick pick 5': tr(
    'ፈጣን ምርጫ 5',
    'Filannoo ariifataa 5',
    'ቅልጡፍ ምርጫ 5',
    'Doorasho degdeg ah 5',
    'اختيار سريع لـ5',
    'Chaguo la haraka la 5',
    'Choix rapide de 5'
  ),
  'Quick pick {value}': tr(
    'ፈጣን ምርጫ {value}',
    'Filannoo ariifataa {value}',
    'ቅልጡፍ ምርጫ {value}',
    'Doorasho degdeg ah {value}',
    'اختيار سريع لـ{value}',
    'Chaguo la haraka la {value}',
    'Choix rapide de {value}'
  ),
  'Quick targets': tr(
    'ፈጣን ዒላማዎች',
    'Galmoota ariifataa',
    'ቅልጡፋት ዕላማታት',
    'Bartilmaameedyo degdeg ah',
    'أهداف سريعة',
    'Malengo ya haraka',
    'Cibles rapides'
  ),
  'RACING CLUB': tr(
    'የውድድር ክለብ',
    'KILABII FIIGICHAA',
    'ክለብ ውድድር',
    'NAADIGA TARTANKA',
    'نادي السباق',
    'KLABU YA MBIO',
    'CLUB DE COURSE'
  ),
  'READY FOR TAKEOFF': tr(
    'ለመብረር ዝግጁ',
    'BALALIʼUUF QOPHAAʼE',
    'ንምብራር ድሉው',
    'DIYAAR U AH DUULIMAADKA',
    'جاهز للإقلاع',
    'TAYARI KWA KUPAA',
    'PRÊT AU DÉCOLLAGE'
  ),
  'READY FOR THE RISE': tr(
    'ለመነሳት ዝግጁ',
    'OL KAʼUUF QOPHAAʼE',
    'ንምዕራግ ድሉው',
    'DIYAAR U AH KOR U KACA',
    'جاهز للصعود',
    'TAYARI KWA KUPANDA',
    'PRÊT À MONTER'
  ),
  'READY TO DRAW': tr(
    'ለዕጣ ዝግጁ',
    'BAASUUF QOPHAAʼE',
    'ንዕጫ ድሉው',
    'DIYAAR U AH SOO SAARISTA',
    'جاهز للسحب',
    'TAYARI KWA DROO',
    'PRÊT POUR LE TIRAGE'
  ),
  'READY TO PLAY': tr(
    'ለመጫወት ዝግጁ',
    'TAPHACHUUF QOPHAAʼE',
    'ንምጽዋት ድሉው',
    'DIYAAR U AH CIYAARTA',
    'جاهز للعب',
    'TAYARI KUCHEZA',
    'PRÊT À JOUER'
  ),
  'RECENT FINISHES': tr(
    'የቅርብ ጊዜ አጨራረሶች',
    'XUMURAWWAN DHIYOO',
    'ናይ ቀረባ መዛዘሚታት',
    'DHAMMAADYADII DHOWAA',
    'النهايات الأخيرة',
    'MATOKEO YA MWISHO YA KARIBUNI',
    'ARRIVÉES RÉCENTES'
  ),
  RESULT: tr('ውጤት', 'BUʼAA', 'ውጽኢት', 'NATIIJO', 'النتيجة', 'MATOKEO', 'RÉSULTAT'),
  REVEALING: tr(
    'በማሳየት ላይ',
    'MULʼISAA JIRA',
    'ይገልጽ ኣሎ',
    'WAA LA MUUJINAYAA',
    'جارٍ الكشف',
    'INAONYESHA',
    'RÉVÉLATION'
  ),
  ROLLING: tr(
    'በመንከባለል ላይ',
    'GANGALACHAA JIRA',
    'ይንከባለል ኣሎ',
    'WUU ROGMANAYAA',
    'جارٍ الرمي',
    'ZINAZUNGUKA',
    'LANCER EN COURS'
  ),
  'ROUND COMPLETE': tr(
    'ዙሩ ተጠናቋል',
    'MARSAAN XUMURAMEERA',
    'ዙር ተዛዚሙ',
    'WAREEGGU WUU DHAMMAADAY',
    'اكتملت الجولة',
    'RAUNDI IMEKAMILIKA',
    'MANCHE TERMINÉE'
  ),
  'ROUND RUNNING': tr(
    'ዙሩ እየተካሄደ ነው',
    'MARSAAN ADEEMAA JIRA',
    'ዙር ይካየድ ኣሎ',
    'WAREEGGU WUU SOCDAA',
    'الجولة جارية',
    'RAUNDI INAENDELEA',
    'MANCHE EN COURS'
  ),
  'Race field': tr(
    'የውድድር ተሳታፊዎች',
    'Hirmaattota fiigichaa',
    'ተሳተፍቲ ውድድር',
    'Ka qaybgalayaasha tartanka',
    'المشاركون في السباق',
    'Washiriki wa mbio',
    'Participants à la course'
  ),
  'Race finishes': tr(
    'ውድድሩ ያበቃል',
    'Fiigichi ni xumurama',
    'ውድድር ይዛዘም',
    'Tartanku wuu dhammaanayaa',
    'ينتهي السباق',
    'Mbio zinaisha',
    'Fin de la course'
  ),
  'Race running': tr(
    'ውድድሩ በሂደት ላይ ነው',
    'Fiigichi adeemaa jira',
    'ውድድር ይካየድ ኣሎ',
    'Tartanku wuu socdaa',
    'السباق جارٍ',
    'Mbio zinaendelea',
    'Course en cours'
  ),
  'Race status': tr(
    'የውድድር ሁኔታ',
    'Haala fiigichaa',
    'ኩነታት ውድድር',
    'Xaaladda tartanka',
    'حالة السباق',
    'Hali ya mbio',
    'État de la course'
  ),
  Racecourse: tr(
    'የውድድር መንገድ',
    'Daandii fiigichaa',
    'መንገዲ ውድድር',
    'Waddada tartanka',
    'المضمار',
    'Uwanja wa mbio',
    'Piste de course'
  ),
  'Racing practice': tr(
    'የውድድር ልምምድ',
    'Shaakala fiigichaa',
    'ልምምድ ውድድር',
    'Tababarka tartanka',
    'تدريب السباق',
    'Mazoezi ya mbio',
    'Entraînement de course'
  ),
  Rebet: tr(
    'እንደገና ተወራረድ',
    'Deebiʼii sharadi',
    'ዳግማይ ተወራረድ',
    'Mar kale sharad',
    'إعادة الرهان',
    'Weka dau tena',
    'Rejouer le pari'
  ),
  'Recent Lucky Six draws': tr(
    'የቅርብ ጊዜ ዕድለኛ ስድስት ዕጣዎች',
    'Baafamoota Jaʼa Milkaaʼaa dhiyoo',
    'ናይ ቀረባ ዕጫታት ዕድለኛ ሽዱሽተ',
    'Soo saaristii dhowayd ee Lixda Nasiibka',
    'سحوبات الستة المحظوظة الأخيرة',
    'Droo za karibuni za Sita za Bahati',
    'Tirages récents des Six chanceux'
  ),
  'Recent draws': tr(
    'የቅርብ ጊዜ ዕጣዎች',
    'Baafamoota dhiyoo',
    'ናይ ቀረባ ዕጫታት',
    'Soo saaristii dhowayd',
    'السحوبات الأخيرة',
    'Droo za karibuni',
    'Tirages récents'
  ),
  'Recent draws ↗': tr(
    'የቅርብ ጊዜ ዕጣዎች ↗',
    'Baafamoota dhiyoo ↗',
    'ናይ ቀረባ ዕጫታት ↗',
    'Soo saaristii dhowayd ↗',
    'السحوبات الأخيرة ↗',
    'Droo za karibuni ↗',
    'Tirages récents ↗'
  ),
  'Recent results': tr(
    'የቅርብ ጊዜ ውጤቶች',
    'Buʼaawwan dhiyoo',
    'ናይ ቀረባ ውጽኢታት',
    'Natiijooyinkii dhowaa',
    'النتائج الأخيرة',
    'Matokeo ya karibuni',
    'Résultats récents'
  ),
  'Recent rolls': tr(
    'የቅርብ ጊዜ የዳይስ ውጤቶች',
    'Darbannoowwan dhiyoo',
    'ናይ ቀረባ ድርብያታት ዳይስ',
    'Tuuristii dhowayd',
    'الرميات الأخيرة',
    'Matokeo ya kete ya karibuni',
    'Lancers récents'
  ),
  'Recent rounds': tr(
    'የቅርብ ጊዜ ዙሮች',
    'Marsaalee dhiyoo',
    'ናይ ቀረባ ዙራት',
    'Wareegyadii dhowaa',
    'الجولات الأخيرة',
    'Raundi za karibuni',
    'Manches récentes'
  ),
  'Recent test wallet activity': tr(
    'የቅርብ ጊዜ የሙከራ ቦርሳ እንቅስቃሴ',
    'Sochii boorsaa yaalii dhiyoo',
    'ናይ ቀረባ ንጥፈት ቦርሳ ፈተነ',
    'Dhaqdhaqaaqii dhowaa ee boorsada tijaabada',
    'نشاط محفظة الاختبار الأخير',
    'Shughuli za karibuni za pochi ya majaribio',
    'Activité récente du portefeuille de test'
  ),
  'Recent tickets': tr(
    'የቅርብ ጊዜ ትኬቶች',
    'Tikeetota dhiyoo',
    'ናይ ቀረባ ትኬታት',
    'Tigidhadii dhowaa',
    'التذاكر الأخيرة',
    'Tiketi za karibuni',
    'Tickets récents'
  ),
  Reconnecting: tr(
    'ዳግም በማገናኘት ላይ',
    'Deebiʼee walqunnamaa jira',
    'ዳግማይ ይራኸብ ኣሎ',
    'Dib ayaa loo xirmayaa',
    'جارٍ إعادة الاتصال',
    'Inaunganisha tena',
    'Reconnexion'
  ),
  'Red / black, odd / even, low / high': tr(
    'ቀይ / ጥቁር፣ ነጠላ / ጥንድ፣ ዝቅተኛ / ከፍተኛ',
    'Diimaa / gurraacha, qara / guutuu, gadi / ol',
    'ቀይሕ / ጸሊም፣ ንጽል / ጽምዲ፣ ትሑት / ልዑል',
    'Casaan / madow, kisi / dhaban, hoose / sare',
    'أحمر / أسود، فردي / زوجي، منخفض / مرتفع',
    'Nyekundu / nyeusi, witiri / shufwa, chini / juu',
    'Rouge / noir, impair / pair, bas / haut'
  ),
  'Reduced motion': tr(
    'የተቀነሰ እንቅስቃሴ',
    'Sochii xiqqaa',
    'ዝተነከየ ምንቅስቓስ',
    'Dhaqdhaqaaq la dhimay',
    'حركة مخففة',
    'Mwendo uliopunguzwa',
    'Mouvements réduits'
  ),
  Refresh: tr('አድስ', 'Haaromsi', 'ኣሐድስ', 'Cusboonaysii', 'تحديث', 'Onyesha upya', 'Actualiser'),
  'Refresh balance': tr(
    'ቀሪ ገንዘቡን አድስ',
    'Haftee haaromsi',
    'ተረፍ ሕሳብ ኣሐድስ',
    'Cusboonaysii hadhaaga',
    'تحديث الرصيد',
    'Onyesha salio upya',
    'Actualiser le solde'
  ),
  'Released balls': tr(
    'የወጡ ኳሶች',
    'Kubbaawwan baafaman',
    'ዝወጻ ኩዕሶታት',
    'Kubbadaha la soo saaray',
    'الكرات المعلنة',
    'Mipira iliyotolewa',
    'Boules publiées'
  ),
  'Released goals': tr(
    'የታወቁ ጎሎች',
    'Galchawwan maxxanfaman',
    'ዝተገልጹ ሸቶታት',
    'Goolasha la shaaciyey',
    'الأهداف المعلنة',
    'Mabao yaliyotangazwa',
    'Buts publiés'
  ),
  'Released match details': tr(
    'የታወቁ የጨዋታ ዝርዝሮች',
    'Balʼina taphaa maxxanfame',
    'ዝተገልጸ ዝርዝር ጸወታ',
    'Faahfaahinta kulanka ee la shaaciyey',
    'تفاصيل المباراة المعلنة',
    'Maelezo ya mechi yaliyotangazwa',
    'Détails du match publiés'
  ),
  'Request only · no timestamp receipt included': tr(
    'ጥያቄ ብቻ · የጊዜ ማህተም ደረሰኝ አልተካተተም',
    'Gaaffii qofa · nagaheen mallattoo yeroo hin dabalamin',
    'ሕቶ ጥራይ · ቅብሊት ማሕተም ግዜ ኣይተኻተተን',
    'Codsi keliya · rasiid calaamad waqti ah kuma jiro',
    'طلب فقط · لا يتضمن إيصال طابع زمني',
    'Ombi pekee · hakuna risiti ya muhuri wa muda',
    'Demande seule · sans reçu dʼhorodatage'
  ),
  'Reset practice': tr(
    'ልምምዱን ዳግም ያስጀምሩ',
    'Shaakala deebisii jalqabi',
    'ልምምድ ዳግማይ ጀምር',
    'Dib u bilow tababarka',
    'إعادة ضبط التدريب',
    'Anza mazoezi upya',
    'Réinitialiser lʼentraînement'
  ),
  'Result verification': tr(
    'የውጤት ማረጋገጫ',
    'Mirkaneessa buʼaa',
    'መረጋገጺ ውጽኢት',
    'Xaqiijinta natiijada',
    'التحقق من النتيجة',
    'Uthibitishaji wa matokeo',
    'Vérification du résultat'
  ),
  'Retry loading': tr(
    'መጫንን እንደገና ይሞክሩ',
    'Feʼuu irra deebiʼii yaali',
    'ምጽዓን ዳግማይ ፈትን',
    'Mar kale isku day soo gelinta',
    'إعادة محاولة التحميل',
    'Jaribu kupakia tena',
    'Réessayer le chargement'
  ),
  'Retry same ticket': tr(
    'ያንኑ ትኬት እንደገና ይሞክሩ',
    'Tikeetii sanuma irra deebiʼii yaali',
    'ነቲ ተመሳሳሊ ትኬት ዳግማይ ፈትን',
    'Mar kale isku day isla tigidhka',
    'أعد محاولة التذكرة نفسها',
    'Jaribu tiketi ileile tena',
    'Réessayer le même ticket'
  ),
  'Retry saved guess': tr(
    'የተቀመጠውን ግምት እንደገና ይሞክሩ',
    'Tilmaama kuufame irra deebiʼii yaali',
    'ዝተዓቀበ ግምት ዳግማይ ፈትን',
    'Mar kale isku day qiyaasta kaydsan',
    'أعد محاولة التخمين المحفوظ',
    'Jaribu kadirio lililohifadhiwa tena',
    'Réessayer le nombre enregistré'
  ),
  'Retry saved ticket': tr(
    'የተቀመጠውን ትኬት እንደገና ይሞክሩ',
    'Tikeetii kuufame irra deebiʼii yaali',
    'ዝተዓቀበ ትኬት ዳግማይ ፈትን',
    'Mar kale isku day tigidhka kaydsan',
    'أعد محاولة التذكرة المحفوظة',
    'Jaribu tiketi iliyohifadhiwa tena',
    'Réessayer le ticket enregistré'
  ),
  'Retry saved ticket · {stake} ETB': tr(
    'የተቀመጠውን ትኬት እንደገና ይሞክሩ · {stake} ETB',
    'Tikeetii kuufame irra deebiʼii yaali · {stake} ETB',
    'ዝተዓቀበ ትኬት ዳግማይ ፈትን · {stake} ETB',
    'Mar kale isku day tigidhka kaydsan · {stake} ETB',
    'أعد محاولة التذكرة المحفوظة · {stake} ETB',
    'Jaribu tiketi iliyohifadhiwa tena · {stake} ETB',
    'Réessayer le ticket enregistré · {stake} ETB'
  ),
  'Retry unconfirmed bet': tr(
    'ያልተረጋገጠውን ውርርድ እንደገና ይሞክሩ',
    'Sharaddii hin mirkanoofne irra deebiʼii yaali',
    'ዘይተረጋገጸ ውርርድ ዳግማይ ፈትን',
    'Mar kale isku day sharadka aan la xaqiijin',
    'أعد محاولة الرهان غير المؤكد',
    'Jaribu dau lisilothibitishwa tena',
    'Réessayer le pari non confirmé'
  ),
  'Retry unconfirmed ticket': tr(
    'ያልተረጋገጠውን ትኬት እንደገና ይሞክሩ',
    'Tikeetii hin mirkanoofne irra deebiʼii yaali',
    'ዘይተረጋገጸ ትኬት ዳግማይ ፈትን',
    'Mar kale isku day tigidhka aan la xaqiijin',
    'أعد محاولة التذكرة غير المؤكدة',
    'Jaribu tiketi isiyothibitishwa tena',
    'Réessayer le ticket non confirmé'
  ),
  Return: tr('ተመላሽ', 'Deebii', 'ተመላሲ', 'Soo-noqosho', 'العائد', 'Malipo', 'Retour'),
  'Return if correct': tr(
    'ትክክል ከሆነ ተመላሽ',
    'Yoo sirrii taʼe deebii',
    'ቅኑዕ እንተኾይኑ ተመላሲ',
    'Soo-noqosho haddii ay sax tahay',
    'العائد عند صحة التوقع',
    'Malipo ikiwa sahihi',
    'Retour si correct'
  ),
  'Return on a win': tr(
    'ሲያሸንፉ ተመላሽ',
    'Yoo moʼate deebii',
    'እንተተዓዊትካ ተመላሲ',
    'Soo-noqoshada guusha',
    'العائد عند الفوز',
    'Malipo ukishinda',
    'Retour en cas de victoire'
  ),
  'Return pending': tr(
    'ተመላሽ በጥበቃ ላይ',
    'Deebiin eegaa jira',
    'ተመላሲ ይጽበ ኣሎ',
    'Soo-noqosho la sugayo',
    'العائد قيد الانتظار',
    'Malipo yanasubiri',
    'Retour en attente'
  ),
  'Return per match': tr(
    'ለእያንዳንዱ ተዛማጅ ተመላሽ',
    'Deebii walsimannaa tokkoof',
    'ንነፍሲ ወከፍ ዝተዛመደ ተመላሲ',
    'Soo-noqosho iswaafajin kasta',
    'العائد لكل مطابقة',
    'Malipo kwa kila inayolingana',
    'Retour par correspondance'
  ),
  'Return {payout} ETB': tr(
    'ተመላሽ {payout} ETB',
    'Deebii {payout} ETB',
    'ተመላሲ {payout} ETB',
    'Soo-noqosho {payout} ETB',
    'العائد {payout} ETB',
    'Malipo {payout} ETB',
    'Retour {payout} ETB'
  ),
  Returned: tr(
    'ተመልሷል',
    'Deebiʼeera',
    'ተመሊሱ',
    'Waa la celiyey',
    'تم الإرجاع',
    'Imerudishwa',
    'Retourné'
  ),
  'Returned {payout} practice ETB': tr(
    '{payout} የልምምድ ETB ተመልሷል',
    '{payout} ETB shaakalaa deebiʼeera',
    '{payout} ናይ ልምምድ ETB ተመሊሱ',
    '{payout} ETB tababar ayaa la celiyey',
    'أُعيد {payout} ETB تدريبي',
    'ETB {payout} za mazoezi zimerudishwa',
    '{payout} ETB dʼentraînement retournés'
  ),
  'Returns include your stake. 5–500 ETB per bet.': tr(
    'ተመላሾች የውርርድዎን መጠን ያካትታሉ። በአንድ ውርርድ 5–500 ETB።',
    'Deebiin maallaqa sharaddii kee dabalata. Sharaddii tokkoof 5–500 ETB.',
    'ተመላሲ መጠን ውርርድካ የካትት። ንሓደ ውርርድ 5–500 ETB።',
    'Soo-noqoshadu waxay ku jirtaa lacagtaadii sharadka. 5–500 ETB sharad kasta.',
    'تشمل العوائد مبلغ رهانك. 5–500 ETB لكل رهان.',
    'Malipo yanajumuisha dau lako. 5–500 ETB kwa kila dau.',
    'Les retours incluent votre mise. 5–500 ETB par pari.'
  ),
  'Revealed seed': tr(
    'የተገለጠ የዕጣ ዘር',
    'Sanyii tasaa mulʼifame',
    'ዝተገልጸ ዘርኢ ዕጫ',
    'Abuurka nasiibka ee la muujiyey',
    'البذرة المكشوفة',
    'Mbegu ya nasibu iliyoonyeshwa',
    'Graine révélée'
  ),
  'Revealed seed: {seed}': tr(
    'የተገለጠ የዕጣ ዘር፦ {seed}',
    'Sanyii tasaa mulʼifame: {seed}',
    'ዝተገልጸ ዘርኢ ዕጫ፦ {seed}',
    'Abuurka nasiibka ee la muujiyey: {seed}',
    'البذرة المكشوفة: {seed}',
    'Mbegu ya nasibu iliyoonyeshwa: {seed}',
    'Graine révélée : {seed}'
  ),
  'Review bet · {value} ETB': tr(
    'ውርርዱን ይከልሱ · {value} ETB',
    'Sharaddii irra deebiʼii ilaali · {value} ETB',
    'ውርርድ ፈትሽ · {value} ETB',
    'Dib u eeg sharadka · {value} ETB',
    'راجع الرهان · {value} ETB',
    'Kagua dau · {value} ETB',
    'Vérifier le pari · {value} ETB'
  ),
  'Review selection': tr(
    'ምርጫውን ይከልሱ',
    'Filannoo irra deebiʼii ilaali',
    'ምርጫ ፈትሽ',
    'Dib u eeg doorashada',
    'راجع الاختيار',
    'Kagua chaguo',
    'Vérifier la sélection'
  ),
};
export default catalogue;
