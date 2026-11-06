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
  '+ Add bet': tr(
    '+ ውርርድ ያክሉ',
    '+ Sharaddii dabali',
    '+ ውርርድ ወስኽ',
    '+ Ku dar sharad',
    '+ أضف رهانًا',
    '+ Ongeza dau',
    '+ Ajouter un pari'
  ),
  ', drawn': tr(
    '፣ የወጣ',
    ', baafame',
    '፣ ዝወጸ',
    ', la soo saaray',
    '، مسحوب',
    ', imetolewa',
    ', tiré'
  ),
  ', match': tr(
    '፣ የተዛመደ',
    ', walsime',
    '፣ ዝተዛመደ',
    ', is waafaqay',
    '، مطابق',
    ', inalingana',
    ', correspondant'
  ),
  '/ 18 balls': tr(
    '/ 18 ኳሶች',
    '/ kubbaawwan 18',
    '/ 18 ኩዕሶታት',
    '/ 18 kubbadood',
    '/ 18 كرة',
    '/ mipira 18',
    '/ 18 boules'
  ),
  '/ 35 balls': tr(
    '/ 35 ኳሶች',
    '/ kubbaawwan 35',
    '/ 35 ኩዕሶታት',
    '/ 35 kubbadood',
    '/ 35 كرة',
    '/ mipira 35',
    '/ 35 boules'
  ),
  '/ CHALLENGE': tr(
    '/ ውድድር',
    '/ DORGOMMII',
    '/ ውድድር',
    '/ TARTAN',
    '/ التحدي',
    '/ CHANGAMOTO',
    '/ DÉFI'
  ),
  '10 seconds to reveal': tr(
    'ውጤቱ ለመታየት 10 ሰከንዶች',
    'Mulʼisuuf sekondii 10',
    'ንምግላጽ 10 ካልኢታት',
    '10 ilbiriqsi ilaa muujinta',
    '10 ثوانٍ للكشف',
    'Sekunde 10 hadi kuonyesha',
    '10 secondes avant révélation'
  ),
  '10% expected house edge': tr(
    '10% የሚጠበቅ የመድረኩ ጥቅም',
    'Faayidaa mana taphaa eegamu 10%',
    '10% ዝጽበ ብልጫ መድረኽ',
    '10% faaʼiido la filayo oo madasha ah',
    'أفضلية متوقعة للمنصة 10%',
    'Faida tarajiwa ya jukwaa 10%',
    'Avantage attendu de la plateforme : 10%'
  ),
  '18 balls.': tr(
    '18 ኳሶች።',
    'Kubbaawwan 18.',
    '18 ኩዕሶታት።',
    '18 kubbadood.',
    '18 كرة.',
    'Mipira 18.',
    '18 boules.'
  ),
  '20 balls · 80 numbers': tr(
    '20 ኳሶች · 80 ቁጥሮች',
    'Kubbaawwan 20 · lakkoofsota 80',
    '20 ኩዕሶታት · 80 ቁጽርታት',
    '20 kubbadood · 80 lambar',
    '20 كرة · 80 رقمًا',
    'Mipira 20 · namba 80',
    '20 boules · 80 numéros'
  ),
  '2m 40s rounds': tr(
    'የ2 ደቂቃ 40 ሰከንድ ዙሮች',
    'Marsaa daqiiqaa 2 sekondii 40',
    'ዙራት 2 ደቓይቕ 40 ካልኢታት',
    'Wareegyo 2 daqiiqo 40 ilbiriqsi ah',
    'جولات مدتها 2 دقيقة و40 ثانية',
    'Raundi za dakika 2 sekunde 40',
    'Manches de 2 min 40 s'
  ),
  '3.6× per match': tr(
    'ለእያንዳንዱ ተዛማጅ 3.6×',
    'Walsimannaa tokkoof 3.6×',
    'ንነፍሲ ወከፍ ዝተዛመደ 3.6×',
    '3.6× iswaafajin kasta',
    '3.6× لكل مطابقة',
    '3.6× kwa kila inayolingana',
    '3.6× par correspondance'
  ),
  '3.6× return per matching number': tr(
    'ለእያንዳንዱ የተዛመደ ቁጥር 3.6× ተመላሽ',
    'Lakkoofsa walsimu tokkoof deebii 3.6×',
    'ንነፍሲ ወከፍ ዝተዛመደ ቁጽሪ 3.6× ተመላሲ',
    '3.6× soo-noqosho lambar kasta oo is waafaqa',
    'عائد 3.6× لكل رقم مطابق',
    'Malipo ya 3.6× kwa kila namba inayolingana',
    'Retour de 3.6× par numéro correspondant'
  ),
  '35 of 48 · Free practice': tr(
    'ከ48 ውስጥ 35 · ነፃ ልምምድ',
    '48 keessaa 35 · shaakala bilisaa',
    'ካብ 48፣ 35 · ነጻ ልምምድ',
    '35 ka mid ah 48 · Tababar bilaash ah',
    '35 من 48 · تدريب مجاني',
    '35 kati ya 48 · Mazoezi ya bure',
    '35 sur 48 · Entraînement gratuit'
  ),
  '35–490 ETB · steps of 35': tr(
    '35–490 ETB · በ35 ጭማሪ',
    '35–490 ETB · daballii 35',
    '35–490 ETB · ብ35 ወሰኽ',
    '35–490 ETB · koror 35 ah',
    '35–490 ETB · بزيادات 35',
    '35–490 ETB · hatua za 35',
    '35–490 ETB · par pas de 35'
  ),
  '45 seconds to enter': tr(
    'ለመሳተፍ 45 ሰከንዶች',
    'Hirmaachuuf sekondii 45',
    'ንምስታፍ 45 ካልኢታት',
    '45 ilbiriqsi si aad u gasho',
    '45 ثانية للمشاركة',
    'Sekunde 45 za kujiunga',
    '45 secondes pour participer'
  ),
  '48-number board': tr(
    'የ48 ቁጥሮች ሰሌዳ',
    'Gabatee lakkoofsota 48',
    'ሰሌዳ 48 ቁጽርታት',
    'Loox 48 lambar ah',
    'لوحة من 48 رقمًا',
    'Ubao wa namba 48',
    'Grille de 48 numéros'
  ),
  '5 seconds for results': tr(
    'ለውጤቶች 5 ሰከንዶች',
    'Buʼaaf sekondii 5',
    'ንውጽኢት 5 ካልኢታት',
    '5 ilbiriqsi oo natiijooyinka ah',
    '5 ثوانٍ للنتائج',
    'Sekunde 5 za matokeo',
    '5 secondes pour les résultats'
  ),
  '6-deck shoe': tr(
    '6 ፓኬት የካርድ ማከማቻ',
    'Kuusaa kaardii paakkii 6',
    'መትሓዚ 6 ፓኬት ካርታ',
    'Kayd ka kooban 6 xirmo kaarar',
    'حافظة تضم 6 مجموعات بطاقات',
    'Hifadhi ya vifurushi 6 vya kadi',
    'Sabot de 6 jeux'
  ),
  '72 possibilities.': tr(
    '72 አማራጮች።',
    'Filannoowwan 72.',
    '72 ኣማራጺታት።',
    '72 suurtagalnimo.',
    '72 احتمالًا.',
    'Uwezekano 72.',
    '72 possibilités.'
  ),
  '72-number board': tr(
    'የ72 ቁጥሮች ሰሌዳ',
    'Gabatee lakkoofsota 72',
    'ሰሌዳ 72 ቁጽርታት',
    'Loox 72 lambar ah',
    'لوحة من 72 رقمًا',
    'Ubao wa namba 72',
    'Grille de 72 numéros'
  ),
  '90% theoretical return': tr(
    '90% ቲዎሬቲካዊ ተመላሽ',
    'Deebii tiyoorii 90%',
    '90% ናይ ክልሰ ሓሳብ ተመላሲ',
    '90% soo-noqosho aragtiyeed',
    'عائد نظري 90%',
    'Marejesho ya kinadharia 90%',
    'Retour théorique de 90%'
  ),
  'A total of 7 or higher wins.': tr(
    'የ7 ወይም ከዚያ በላይ ድምር ያሸንፋል።',
    'Idaʼamni 7 yookaan isaa ol moʼata.',
    'ድምር 7 ወይ ልዕሊኡ ይዕወት።',
    'Wadar 7 ama ka badan ayaa guuleysata.',
    'يفوز مجموع 7 أو أكثر.',
    'Jumla ya 7 au zaidi hushinda.',
    'Un total de 7 ou plus gagne.'
  ),
  'ACCOUNT BALANCE': tr(
    'የሂሳብ ቀሪ ገንዘብ',
    'HAFTEE HERREGAA',
    'ተረፍ ሕሳብ',
    'HADHAAGA AKOONKA',
    'رصيد الحساب',
    'SALIO LA AKAUNTI',
    'SOLDE DU COMPTE'
  ),
  'ALL HANDS STAND ON 17': tr(
    'ሁሉም እጆች በ17 ይቆማሉ',
    'HARKI HUNDI 17 IRRATTI DHAABBATA',
    'ኩሎም ኣእዳው ኣብ 17 ይደዉ',
    'GACMAHA OO DHAN WAXAY JOOGSADAAN 17',
    'كل الأيدي تتوقف عند 17',
    'MIKONO YOTE HUSIMAMA KWA 17',
    'TOUTES LES MAINS RESTENT À 17'
  ),
  'AT THE STARTING GATE': tr(
    'በመነሻ በሩ',
    'KARRA KAʼUMSAA IRRATTI',
    'ኣብ መበገሲ ኣፍደገ',
    'ALBAABKA BILOWGA',
    'عند بوابة الانطلاق',
    'KWENYE LANGO LA KUANZIA',
    'À LA GRILLE DE DÉPART'
  ),
  'Above the clouds. Choose your moment.': tr(
    'ከደመናዎች በላይ። ጊዜዎን ይምረጡ።',
    'Duumessa ol. Yeroo kee filadhu.',
    'ልዕሊ ደበናታት። ግዜኻ ምረጽ።',
    'Daruuraha korkooda. Dooro waqtigaaga.',
    'فوق السحاب. اختر لحظتك.',
    'Juu ya mawingu. Chagua wakati wako.',
    'Au-dessus des nuages. Choisissez votre instant.'
  ),
  'Activity unavailable. Reconnecting…': tr(
    'እንቅስቃሴ አይገኝም። ዳግም በማገናኘት ላይ…',
    'Sochiin hin argamu. Deebiʼee walqunnamaa jira…',
    'ንጥፈት ኣይርከብን። ዳግማይ ይራኸብ ኣሎ…',
    'Dhaqdhaqaaq lama heli karo. Dib ayaa loo xirmayaa…',
    'النشاط غير متاح. جارٍ إعادة الاتصال…',
    'Shughuli hazipatikani. Inaunganisha tena…',
    'Activité indisponible. Reconnexion…'
  ),
  'Activity view': tr(
    'የእንቅስቃሴ እይታ',
    'Mulʼata sochii',
    'ርእይቶ ንጥፈት',
    'Muuqaalka dhaqdhaqaaqa',
    'عرض النشاط',
    'Mwonekano wa shughuli',
    'Vue de lʼactivité'
  ),
  'Add bet': tr(
    'ውርርድ ያክሉ',
    'Sharaddii dabali',
    'ውርርድ ወስኽ',
    'Ku dar sharad',
    'أضف رهانًا',
    'Ongeza dau',
    'Ajouter un pari'
  ),
  'Additional fee': tr(
    'ተጨማሪ ክፍያ',
    'Kaffaltii dabalataa',
    'ተወሳኺ ክፍሊት',
    'Khidmad dheeraad ah',
    'رسوم إضافية',
    'Ada ya ziada',
    'Frais supplémentaires'
  ),
  Aerial: tr(
    'ከላይ ያለ እይታ',
    'Mulʼata gubbaa',
    'ካብ ላዕሊ',
    'Korka',
    'من الأعلى',
    'Kutoka juu',
    'Vue aérienne'
  ),
  'All 18 balls': tr(
    'ሁሉም 18 ኳሶች',
    'Kubbaawwan 18 hunda',
    'ኩለን 18 ኩዕሶታት',
    'Dhammaan 18-ka kubbadood',
    'الكرات الـ18 كلها',
    'Mipira yote 18',
    'Les 18 boules'
  ),
  'All 18 drawn balls count.': tr(
    'የወጡት 18ቱም ኳሶች ይቆጠራሉ።',
    'Kubbaawwan 18 baafaman hundi ni lakkaaʼamu.',
    'ኩለን 18 ዝወጻ ኩዕሶታት ይቑጸራ።',
    'Dhammaan 18-ka kubbadood ee la soo saaray waa la xisaabiyaa.',
    'تُحتسب الكرات الـ18 المسحوبة كلها.',
    'Mipira yote 18 iliyotolewa huhesabiwa.',
    'Les 18 boules tirées comptent.'
  ),
  'All results': tr(
    'ሁሉም ውጤቶች',
    'Buʼaawwan hunda',
    'ኩሎም ውጽኢታት',
    'Dhammaan natiijooyinka',
    'كل النتائج',
    'Matokeo yote',
    'Tous les résultats'
  ),
  'Animate previews': tr(
    'ቅድመ እይታዎችን ያንቀሳቅሱ',
    'Dursanii ilaaluu sochoosi',
    'ቅድመ ርእይቶ ኣንቀሳቕስ',
    'Dhaqaaji muuqaallada hordhaca',
    'تحريك المعاينات',
    'Huisha maonyesho ya awali',
    'Animer les aperçus'
  ),
  'Archive ready to save': tr(
    'ማህደሩ ለማስቀመጥ ዝግጁ ነው',
    'Kuusaan olkaaʼuuf qophaaʼeera',
    'መዝገብ ንምዕቃብ ድሉው እዩ',
    'Kaydku waa diyaar in la keydiyo',
    'الأرشيف جاهز للحفظ',
    'Kumbukumbu iko tayari kuhifadhiwa',
    'Archive prête à enregistrer'
  ),
  'At the starting gate': tr(
    'በመነሻ በሩ',
    'Karra kaʼumsaa irratti',
    'ኣብ መበገሲ ኣፍደገ',
    'Albaabka bilowga',
    'عند بوابة الانطلاق',
    'Kwenye lango la kuanzia',
    'À la grille de départ'
  ),
  'Auto cash-out': tr(
    'ራስ-ሰር መውጣት',
    'Ofumaan kaffaltii fudhachuu',
    'ርእሰ-ሰር ምውጻእ',
    'Lacag-bixitaan toos ah',
    'صرف تلقائي',
    'Kuchukua malipo kiotomatiki',
    'Encaissement automatique'
  ),
  'Auto cash-out multiplier': tr(
    'የራስ-ሰር መውጫ ማባዣ',
    'Baayʼisaa ofumaan kaffaltii fudhachuu',
    'መባዝሒ ርእሰ-ሰር መውጽኢ',
    'Isku-dhufteha lacag-bixitaanka tooska ah',
    'مضاعف الصرف التلقائي',
    'Kizidishi cha kuchukua malipo kiotomatiki',
    'Multiplicateur dʼencaissement automatique'
  ),
  'Auto cash-out targets': tr(
    'የራስ-ሰር መውጫ ዒላማዎች',
    'Galmoota ofumaan kaffaltii fudhachuu',
    'ዕላማታት ርእሰ-ሰር መውጽኢ',
    'Bartilmaameedyada lacag-bixitaanka tooska ah',
    'أهداف الصرف التلقائي',
    'Malengo ya kuchukua malipo kiotomatiki',
    'Cibles dʼencaissement automatique'
  ),
  'Awaiting official result': tr(
    'ኦፊሴላዊውን ውጤት በመጠበቅ ላይ',
    'Buʼaa mirkanaaʼe eegaa jira',
    'ወግዓዊ ውጽኢት ይጽበ ኣሎ',
    'La sugayo natiijada rasmiga ah',
    'بانتظار النتيجة الرسمية',
    'Inasubiri matokeo rasmi',
    'En attente du résultat officiel'
  ),
  'Awaiting race result': tr(
    'የውድድሩን ውጤት በመጠበቅ ላይ',
    'Buʼaa fiigichaa eegaa jira',
    'ውጽኢት ውድድር ይጽበ ኣሎ',
    'La sugayo natiijada tartanka',
    'بانتظار نتيجة السباق',
    'Inasubiri matokeo ya mbio',
    'En attente du résultat de la course'
  ),
  'Awaiting the published result': tr(
    'የሚታወጀውን ውጤት በመጠበቅ ላይ',
    'Buʼaa maxxanfamu eegaa jira',
    'ዝእወጅ ውጽኢት ይጽበ ኣሎ',
    'La sugayo natiijada la shaacinayo',
    'بانتظار النتيجة المنشورة',
    'Inasubiri matokeo yatakayochapishwa',
    'En attente du résultat publié'
  ),
  'BET {slot} SELECTION': tr(
    'የውርርድ {slot} ምርጫ',
    'FILANNOO SHARADDII {slot}',
    'ምርጫ ውርርድ {slot}',
    'DOORASHADA SHARADKA {slot}',
    'اختيار الرهان {slot}',
    'CHAGUO LA DAU {slot}',
    'SÉLECTION DU PARI {slot}'
  ),
  'BETTING OPEN': tr(
    'ውርርድ ክፍት ነው',
    'SHARADDIIN BANAMEERA',
    'ውርርድ ክፉት እዩ',
    'SHARADKU WAA FURAN YAHAY',
    'الرهان مفتوح',
    'DAU ZIMEFUNGULIWA',
    'PARIS OUVERTS'
  ),
  BJ: tr('ብጃ', 'BJ', 'ብጃ', 'BJ', 'بلاك جاك', 'BJ', 'BJ'),
  BLACKJACK: tr(
    'ብላክጃክ',
    'BILAAKJAAKII',
    'ብላክጃክ',
    'BLACKJACK',
    'بلاك جاك',
    'BLACKJACK',
    'BLACKJACK'
  ),
  BUST: tr(
    'ከ21 አልፏል',
    '21 CAALE',
    'ካብ 21 ሓሊፉ',
    '21 WAA LA DHAAFAY',
    'تجاوز 21',
    'IMEZIDI 21',
    'DÉPASSÉ'
  ),
  'Back to Games': tr(
    'ወደ ጨዋታዎች ተመለስ',
    'Gara taphootaatti deebiʼi',
    'ናብ ጸወታታት ተመለስ',
    'Ku noqo ciyaaraha',
    'العودة إلى الألعاب',
    'Rudi kwenye michezo',
    'Retour aux jeux'
  ),
  'Back to casino': tr(
    'ወደ ካዚኖ ተመለስ',
    'Gara kaazinootti deebiʼi',
    'ናብ ካዚኖ ተመለስ',
    'Ku noqo kaasiinada',
    'العودة إلى الكازينو',
    'Rudi kwenye kasino',
    'Retour au casino'
  ),
  'Back to current': tr(
    'ወደ አሁኑ ተመለስ',
    'Gara kan ammaatti deebiʼi',
    'ናብ እዋናዊ ተመለስ',
    'Ku noqo kan hadda',
    'العودة إلى الحالي',
    'Rudi kwenye ya sasa',
    'Retour à lʼactuel'
  ),
  'Back to games': tr(
    'ወደ ጨዋታዎች ተመለስ',
    'Gara taphootaatti deebiʼi',
    'ናብ ጸወታታት ተመለስ',
    'Ku noqo ciyaaraha',
    'العودة إلى الألعاب',
    'Rudi kwenye michezo',
    'Retour aux jeux'
  ),
  'Back to our games': tr(
    'ወደ ጨዋታዎቻችን ተመለስ',
    'Gara taphoota keenyaatti deebiʼi',
    'ናብ ጸወታታትና ተመለስ',
    'Ku noqo ciyaaraheenna',
    'العودة إلى ألعابنا',
    'Rudi kwenye michezo yetu',
    'Retour à nos jeux'
  ),
  'Ball reveal': tr(
    'ኳሱን ማሳየት',
    'Kubbaa mulʼisuu',
    'ምግላጽ ኩዕሶ',
    'Muujinta kubbadda',
    'كشف الكرة',
    'Kuonyesha mpira',
    'Révélation de la boule'
  ),
  'Ball {length}: {value} · {name}': tr(
    'ኳስ {length}፦ {value} · {name}',
    'Kubbaa {length}: {value} · {name}',
    'ኩዕሶ {length}፦ {value} · {name}',
    'Kubbad {length}: {value} · {name}',
    'الكرة {length}: {value} · {name}',
    'Mpira {length}: {value} · {name}',
    'Boule {length} : {value} · {name}'
  ),
  'Ball {value}': tr(
    'ኳስ {value}',
    'Kubbaa {value}',
    'ኩዕሶ {value}',
    'Kubbad {value}',
    'الكرة {value}',
    'Mpira {value}',
    'Boule {value}'
  ),
  'Ball {value}: waiting': tr(
    'ኳስ {value}፦ በመጠበቅ ላይ',
    'Kubbaa {value}: eegaa jira',
    'ኩዕሶ {value}፦ ይጽበ ኣሎ',
    'Kubbad {value}: la sugayo',
    'الكرة {value}: قيد الانتظار',
    'Mpira {value}: unasubiri',
    'Boule {value} : en attente'
  ),
  'Ball {value}: {n}': tr(
    'ኳስ {value}፦ {n}',
    'Kubbaa {value}: {n}',
    'ኩዕሶ {value}፦ {n}',
    'Kubbad {value}: {n}',
    'الكرة {value}: {n}',
    'Mpira {value}: {n}',
    'Boule {value} : {n}'
  ),
  'Below seven · no return': tr(
    'ከሰባት በታች · ተመላሽ የለም',
    'Torba gadi · deebiin hin jiru',
    'ትሕቲ ሸውዓተ · ተመላሲ የለን',
    'Toddoba ka hooseeya · soo-noqosho ma jirto',
    'أقل من سبعة · بلا عائد',
    'Chini ya saba · hakuna malipo',
    'Moins de sept · aucun retour'
  ),
  Bet: tr('ውርርድ', 'Sharaddii', 'ውርርድ', 'Sharad', 'رهان', 'Dau', 'Pari'),
  'Bet amount': tr(
    'የውርርድ መጠን',
    'Hanga sharaddii',
    'መጠን ውርርድ',
    'Qadarka sharadka',
    'مبلغ الرهان',
    'Kiasi cha dau',
    'Montant du pari'
  ),
  'Bet amount per number': tr(
    'ለእያንዳንዱ ቁጥር የውርርድ መጠን',
    'Hanga sharaddii lakkoofsa tokkoof',
    'መጠን ውርርድ ንነፍሲ ወከፍ ቁጽሪ',
    'Qadarka sharadka lambar kasta',
    'مبلغ الرهان لكل رقم',
    'Kiasi cha dau kwa kila namba',
    'Montant du pari par numéro'
  ),
  'Bet amount · ETB': tr(
    'የውርርድ መጠን · ETB',
    'Hanga sharaddii · ETB',
    'መጠን ውርርድ · ETB',
    'Qadarka sharadka · ETB',
    'مبلغ الرهان · ETB',
    'Kiasi cha dau · ETB',
    'Montant du pari · ETB'
  ),
  'Bet market': tr(
    'የውርርድ ገበያ',
    'Gabaa sharaddii',
    'ዕዳጋ ውርርድ',
    'Suuqa sharadka',
    'سوق الرهان',
    'Soko la dau',
    'Marché du pari'
  ),
  'Bet on {label}': tr(
    'በ{label} ላይ ይወራረዱ',
    '{label} irratti sharadi',
    'ኣብ {label} ተወራረድ',
    'Ku sharad {label}',
    'راهن على {label}',
    'Weka dau kwa {label}',
    'Parier sur {label}'
  ),
  'Bet tabs': tr(
    'የውርርድ ትሮች',
    'Caancaloota sharaddii',
    'ትራት ውርርድ',
    'Qaybaha sharadka',
    'تبويبات الرهان',
    'Vichupo vya dau',
    'Onglets de pari'
  ),
  'Bet type': tr(
    'የውርርድ ዓይነት',
    'Gosa sharaddii',
    'ዓይነት ውርርድ',
    'Nooca sharadka',
    'نوع الرهان',
    'Aina ya dau',
    'Type de pari'
  ),
  'Bet {n}': tr(
    'ውርርድ {n}',
    'Sharaddii {n}',
    'ውርርድ {n}',
    'Sharad {n}',
    'الرهان {n}',
    'Dau {n}',
    'Pari {n}'
  ),
  'Bet {slot}': tr(
    'ውርርድ {slot}',
    'Sharaddii {slot}',
    'ውርርድ {slot}',
    'Sharad {slot}',
    'الرهان {slot}',
    'Dau {slot}',
    'Pari {slot}'
  ),
  'Bet {slot} confirmed': tr(
    'ውርርድ {slot} ተረጋግጧል',
    'Sharaddiin {slot} mirkanaaʼeera',
    'ውርርድ {slot} ተረጋጊጹ',
    'Sharadka {slot} waa la xaqiijiyey',
    'تم تأكيد الرهان {slot}',
    'Dau {slot} limethibitishwa',
    'Pari {slot} confirmé'
  ),
  'Bet {slot} controls': tr(
    'የውርርድ {slot} መቆጣጠሪያዎች',
    'Toʼannoowwan sharaddii {slot}',
    'መቆጻጸሪታት ውርርድ {slot}',
    'Xakamaynta sharadka {slot}',
    'عناصر التحكم بالرهان {slot}',
    'Vidhibiti vya dau {slot}',
    'Commandes du pari {slot}'
  ),
  'Bet {slot} receipt': tr(
    'የውርርድ {slot} ደረሰኝ',
    'Nagahee sharaddii {slot}',
    'ቅብሊት ውርርድ {slot}',
    'Rasiidka sharadka {slot}',
    'إيصال الرهان {slot}',
    'Risiti ya dau {slot}',
    'Reçu du pari {slot}'
  ),
  'Bet {slot} result': tr(
    'የውርርድ {slot} ውጤት',
    'Buʼaa sharaddii {slot}',
    'ውጽኢት ውርርድ {slot}',
    'Natiijada sharadka {slot}',
    'نتيجة الرهان {slot}',
    'Matokeo ya dau {slot}',
    'Résultat du pari {slot}'
  ),
  'Bet {slot} summary': tr(
    'የውርርድ {slot} ማጠቃለያ',
    'Cuunfaa sharaddii {slot}',
    'ጽማቝ ውርርድ {slot}',
    'Soo koobidda sharadka {slot}',
    'ملخص الرهان {slot}',
    'Muhtasari wa dau {slot}',
    'Résumé du pari {slot}'
  ),
  'Bet {slot} · Choose selections': tr(
    'ውርርድ {slot} · ምርጫዎችዎን ይምረጡ',
    'Sharaddii {slot} · Filannoowwan filadhu',
    'ውርርድ {slot} · ምርጫታት ምረጽ',
    'Sharad {slot} · Samee doorashooyin',
    'الرهان {slot} · حدّد الاختيارات',
    'Dau {slot} · Chagua machaguo',
    'Pari {slot} · Choisissez vos sélections'
  ),
  'Bet {slot} · Confirmed selections': tr(
    'ውርርድ {slot} · የተረጋገጡ ምርጫዎች',
    'Sharaddii {slot} · Filannoowwan mirkanaaʼan',
    'ውርርድ {slot} · ዝተረጋገጹ ምርጫታት',
    'Sharad {slot} · Doorashooyin la xaqiijiyey',
    'الرهان {slot} · اختيارات مؤكدة',
    'Dau {slot} · Machaguo yaliyothibitishwa',
    'Pari {slot} · Sélections confirmées'
  ),
  'Bet {slot} · Stake {stake} ETB · {value}': tr(
    'ውርርድ {slot} · የውርርድ ገንዘብ {stake} ETB · {value}',
    'Sharaddii {slot} · Maallaqa {stake} ETB · {value}',
    'ውርርድ {slot} · መጠን {stake} ETB · {value}',
    'Sharad {slot} · Lacagta {stake} ETB · {value}',
    'الرهان {slot} · المبلغ {stake} ETB · {value}',
    'Dau {slot} · Kiasi {stake} ETB · {value}',
    'Pari {slot} · Mise {stake} ETB · {value}'
  ),
  'Bet {slot} · {value} · {value2}': tr(
    'ውርርድ {slot} · {value} · {value2}',
    'Sharaddii {slot} · {value} · {value2}',
    'ውርርድ {slot} · {value} · {value2}',
    'Sharad {slot} · {value} · {value2}',
    'الرهان {slot} · {value} · {value2}',
    'Dau {slot} · {value} · {value2}',
    'Pari {slot} · {value} · {value2}'
  ),
  'Bet:': tr('ውርርድ፦', 'Sharaddii:', 'ውርርድ፦', 'Sharad:', 'الرهان:', 'Dau:', 'Pari :'),
  'Bets are closed': tr(
    'ውርርዶች ተዘግተዋል',
    'Sharaddiin cufameera',
    'ውርርድ ተዓጽዩ',
    'Sharadku wuu xiran yahay',
    'أُغلقت الرهانات',
    'Dau zimefungwa',
    'Les paris sont fermés'
  ),
  'Bets open': tr(
    'ውርርዶች ክፍት ናቸው',
    'Sharaddiin banaa dha',
    'ውርርድ ክፉት እዩ',
    'Sharadku waa furan yahay',
    'الرهانات مفتوحة',
    'Dau zimefunguliwa',
    'Paris ouverts'
  ),
  'Betting closes in': tr(
    'ውርርድ የሚዘጋበት ቀሪ ጊዜ',
    'Sharaddiin kan cufamu',
    'ውርርድ ንምዕጻው ዝተረፈ',
    'Sharadku wuxuu xirmayaa',
    'تُغلق الرهانات خلال',
    'Dau zinafungwa baada ya',
    'Fermeture des paris dans'
  ),
  'Betting cutoff': tr(
    'የውርርድ መዝጊያ ጊዜ',
    'Yeroo sharaddiin cufamu',
    'ግዜ መዕጸዊ ውርርድ',
    'Waqtiga xiritaanka sharadka',
    'موعد إغلاق الرهان',
    'Muda wa mwisho wa dau',
    'Clôture des paris'
  ),
  Black: tr('ጥቁር', 'Gurraacha', 'ጸሊም', 'Madow', 'أسود', 'Nyeusi', 'Noir'),
  'Blackjack table': tr(
    'የብላክጃክ ጠረጴዛ',
    'Minjaala Bilaakjaakii',
    'ጠረጴዛ ብላክጃክ',
    'Miiska Blackjack',
    'طاولة البلاك جاك',
    'Meza ya Blackjack',
    'Table de blackjack'
  ),
  Bust: tr(
    'ከ21 አልፏል',
    '21 caale',
    'ካብ 21 ሓሊፉ',
    '21 waa la dhaafay',
    'تجاوز 21',
    'Imezidi 21',
    'Dépassé'
  ),
  'CLUB FOOTBALL · FREE PRACTICE': tr(
    'የክለብ እግር ኳስ · ነፃ ልምምድ',
    'KUBBAA MIILAA KILABII · SHAAKALA BILISAA',
    'ኩዕሶ እግሪ ክለብ · ነጻ ልምምድ',
    'KUBADDA CAGTA NAADIYADA · TABABAR BILAASH AH',
    'كرة قدم الأندية · تدريب مجاني',
    'MPIRA WA MIGUU WA VILABU · MAZOEZI YA BURE',
    'FOOTBALL DE CLUB · ENTRAÎNEMENT GRATUIT'
  ),
  'COMPLETED ROUND': tr(
    'የተጠናቀቀ ዙር',
    'MARSAA XUMURAME',
    'ዝተዛዘመ ዙር',
    'WAREEG DHAMMAADAY',
    'جولة مكتملة',
    'RAUNDI ILIYOKAMILIKA',
    'MANCHE TERMINÉE'
  ),
  'CONFIRMED SELECTION': tr(
    'የተረጋገጠ ምርጫ',
    'FILANNOO MIRKANAAʼE',
    'ዝተረጋገጸ ምርጫ',
    'DOORASHO LA XAQIIJIYEY',
    'اختيار مؤكد',
    'CHAGUO LILILOTHIBITISHWA',
    'SÉLECTION CONFIRMÉE'
  ),
  CRASH: tr('ክራሽ', 'KUFAATII', 'ክራሽ', 'BURBUR', 'انهيار', 'KUANGUKA', 'CRASH'),
  CRASHED: tr('ወድቋል', 'KUFEERA', 'ወዲቑ', 'WUU BURBURAY', 'انهار', 'IMEANGUKA', 'ÉCRASÉ'),
  'Camera view': tr(
    'የካሜራ እይታ',
    'Mulʼata kaameraa',
    'ርእይቶ ካሜራ',
    'Muuqaalka kamaradda',
    'زاوية الكاميرا',
    'Mwonekano wa kamera',
    'Vue de caméra'
  ),
  'Cash out before the crash.': tr(
    'ከክራሹ በፊት ይውጡ።',
    'Osoo hin kufin kaffaltii fudhadhu.',
    'ቅድሚ ክራሽ ውጻእ።',
    'Lacagta qaado ka hor burburka.',
    'اصرف قبل الانهيار.',
    'Chukua malipo kabla ya kuanguka.',
    'Encaissez avant le crash.'
  ),
  'Cash out before the curve stops': tr(
    'መስመሩ ከመቆሙ በፊት ይውጡ',
    'Osoo sararri hin dhaabbatin kaffaltii fudhadhu',
    'ቅድሚ እቲ መስመር ምድዋዩ ውጻእ',
    'Lacagta qaado ka hor inta khadku joogsan',
    'اصرف قبل توقف المنحنى',
    'Chukua malipo kabla mkunjo haujasimama',
    'Encaissez avant lʼarrêt de la courbe'
  ),
  'Cash-out': tr(
    'መውጣት',
    'Kaffaltii fudhachuu',
    'ምውጻእ',
    'Lacag-bixitaan',
    'صرف',
    'Kuchukua malipo',
    'Encaissement'
  ),
  'Cashed out': tr(
    'ወጥቷል',
    'Kaffaltiin fudhatameera',
    'ወጺኡ',
    'Lacagtii waa la qaatay',
    'تم الصرف',
    'Malipo yamechukuliwa',
    'Encaissé'
  ),
  'Casino game lobby': tr(
    'የካዚኖ ጨዋታዎች አዳራሽ',
    'Galma taphoota kaazinoo',
    'ኣዳራሽ ጸወታታት ካዚኖ',
    'Hoolka ciyaaraha kaasiinada',
    'ردهة ألعاب الكازينو',
    'Ukumbi wa michezo ya kasino',
    'Salon des jeux de casino'
  ),
  Challenge: tr('ውድድር', 'Dorgommii', 'ውድድር', 'Tartan', 'تحدٍّ', 'Changamoto', 'Défi'),
  'Check again': tr(
    'እንደገና ያረጋግጡ',
    'Ammas mirkaneessi',
    'ዳግማይ ኣረጋግጽ',
    'Mar kale hubi',
    'تحقق مجددًا',
    'Angalia tena',
    'Vérifier à nouveau'
  ),
};

export default catalogue;
