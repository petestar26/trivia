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
  'Dice practice is unavailable. No ticket can be placed.': tr(
    'የዳይስ ልምምድ አይገኝም። ትኬት ማስገባት አይቻልም።',
    'Shaakalli Daayisii hin argamu. Tikeetii galchuun hin dandaʼamu.',
    'ልምምድ ዳይስ ኣይርከብን። ትኬት ምምዝጋብ ኣይከኣልን።',
    'Tababarka laadhuuda lama heli karo. Tigidh lama gelin karo.',
    'تدريب النرد غير متاح. لا يمكن وضع تذكرة.',
    'Mazoezi ya Kete hayapatikani. Hakuna tiketi inayoweza kuwekwa.',
    'L’entraînement aux dés est indisponible. Aucun ticket ne peut être placé.'
  ),
  'Each 90-second round has 60 seconds to place bets.': tr(
    'እያንዳንዱ 90 ሰከንድ ዙር ለውርርድ 60 ሰከንዶች አሉት።',
    'Marsaan sekondii 90 hundi buusii galchuuf sekondii 60 qaba.',
    'ነፍሲ ወከፍ 90 ካልኢት ዙር ንውርርድ 60 ካልኢታት ኣለዎ።',
    'Wareeg kasta oo 90 ilbiriqsi ah wuxuu leeyahay 60 ilbiriqsi oo sharad la dhigo.',
    'لكل جولة مدتها 90 ثانية مهلة 60 ثانية لوضع الرهانات.',
    'Kila raundi ya sekunde 90 ina sekunde 60 za kuweka dau.',
    'Chaque manche de 90 secondes offre 60 secondes pour miser.'
  ),
  'Each account starts with 1,000 separate practice ETB. All returns include the stake and settle after the final ball. The mathematical return is 90% over repeated play; an individual round can return zero. No jackpots, automatic repeat bets, deposits or redeemable prizes.':
    tr(
      'እያንዳንዱ መለያ በተለየ 1,000 የልምምድ ETB ይጀምራል። ሁሉም ተመላሾች ውርርዱን ያካትታሉ፣ ከመጨረሻው ኳስ በኋላም ይከፈላሉ። ሒሳባዊ ተመላሹ በተደጋጋሚ ጨዋታ 90% ነው፤ አንድ ዙር ዜሮ ሊመልስ ይችላል። ጃክፖት፣ ራስ-ሰር ተደጋጋሚ ውርርድ፣ ተቀማጭ ወይም ሊቀየሩ የሚችሉ ሽልማቶች የሉም።',
      'Herregni hundi ETB shaakalaa adda taʼe 1,000 irraa jalqaba. Deebiin hundi buusii dabalatee kubbaa dhumaa booda kaffalama. Deebiin herregaa tapha irra deddeebiʼamu irratti 90%; marsaan tokko zeeroo deebisuu dandaʼa. Jaakpootii, buusii ofumaan deebiʼu, maallaqa galchuu ykn badhaasa maallaqatti jijjiiramu hin qabu.',
      'ነፍሲ ወከፍ መለያ ብዝተፈለየ 1,000 ETB ልምምድ ይጅምር። ኩሎም ተመላሲታት ውርርድ ይሓውሱ፣ ድሕሪ መወዳእታ ኩዕሶ ይኽፈሉ። ሒሳባዊ ተመላሲ ኣብ ተደጋጋሚ ጸወታ 90% እዩ፤ ሓደ ዙር ዜሮ ክመልስ ይኽእል። ጃክፖት፣ ርእሰ-ሰር ተደጋጋሚ ውርርድ፣ ተቐማጢ ወይ ዝልወጥ ሽልማት የለን።',
      'Koonto kastaa waxay ku bilaabataa 1,000 ETB tababar oo gaar ah. Soo-noqosho kastaa sharadka way ku jirtaa waxaana la bixiyaa kubbadda ugu dambaysa ka dib. Soo-noqoshada xisaabeed waa 90% marka marar badan la ciyaaro; hal wareeg wuxuu soo celin karaa eber. Ma jiraan jaakbooto, sharad is-celiya, dhigaallo ama abaalmarin la sarifan karo.',
      'يبدأ كل حساب برصيد تدريبي منفصل قدره 1,000 ETB. تشمل العوائد الرهان وتُسوّى بعد الكرة الأخيرة. العائد الحسابي 90% عبر اللعب المتكرر؛ وقد تعيد جولة منفردة صفرًا. لا جوائز كبرى أو تكرار تلقائي للرهانات أو إيداعات أو جوائز قابلة للاستبدال.',
      'Kila akaunti huanza na ETB 1,000 tofauti za mazoezi. Marejesho yote yanajumuisha dau na hulipwa baada ya mpira wa mwisho. Marejesho ya kihesabu ni 90% kwa kucheza mara nyingi; raundi moja inaweza kurudisha sifuri. Hakuna jackpot, kurudia dau kiotomatiki, amana au zawadi zinazoweza kukombolewa.',
      'Chaque compte commence avec 1 000 ETB d’entraînement distincts. Tous les retours incluent la mise et sont réglés après la dernière boule. Le retour mathématique est de 90 % sur des jeux répétés ; une manche peut rapporter zéro. Aucun jackpot, répétition automatique, dépôt ou prix échangeable.'
    ),
  'Each bet has its own selections and total. All bets use the same Spin result.': tr(
    'እያንዳንዱ ውርርድ የራሱ ምርጫዎች እና ድምር አሉት። ሁሉም ውርርዶች ተመሳሳይ የሽክርክሪት ውጤት ይጠቀማሉ።',
    'Buusiin hundi filannoowwanii fi waliigala mataa isaa qaba. Buusiiwwan hundi buʼaa naannaʼaa tokko fayyadamu.',
    'ነፍሲ ወከፍ ውርርድ ናቱ ምርጫታትን ድምርን ኣለዎ። ኩሎም ውርርዳት ተመሳሳሊ ውጽኢት ምዝዋር ይጥቀሙ።',
    'Sharad kastaa wuxuu leeyahay doorashooyin iyo wadar u gaar ah. Sharad kasta wuxuu isticmaalaa isla natiijada wareejinta.',
    'لكل رهان اختياراته وإجماليه. تستخدم جميع الرهانات نتيجة الدوران نفسها.',
    'Kila dau lina machaguo na jumla yake. Dau zote hutumia matokeo yale yale ya mzunguko.',
    'Chaque mise a ses sélections et son total. Toutes utilisent le même résultat de rotation.'
  ),
  'Each number 0–36 has a 1/37 chance. A 40 ETB exact-number win returns 1,332; sector 222; dozen 111; outside 74. Returns include stake. Zero loses outside selections.':
    tr(
      'እያንዳንዱ 0–36 ቁጥር 1/37 ዕድል አለው። በ 40 ETB ትክክለኛ ቁጥር ማሸነፍ 1,332፣ ክፍል 222፣ ደርዘን 111፣ ውጫዊ 74 ይመልሳል። ተመላሾች ውርርዱን ያካትታሉ። ዜሮ ውጫዊ ምርጫዎችን ያስሸንፋል።',
      'Lakkoofsi 0–36 hundi carraa 1/37 qaba. Moʼannaan lakkoofsa sirrii 40 ETB deebii 1,332; kutaa 222; kudha-lama 111; alaa 74. Deebiin buusii dabalata. Zeeroon filannoo alaa moʼa.',
      'ነፍሲ ወከፍ 0–36 ቁጽሪ 1/37 ዕድል ኣለዎ። ብ 40 ETB ትኽክለኛ ቁጽሪ ምዕዋት 1,332፣ ክፍሊ 222፣ ደርዘን 111፣ ደጋዊ 74 ይመልስ። ተመላሲታት ውርርድ ይሓውሱ። ዜሮ ደጋዊ ምርጫታት የስዕር።',
      'Lambar kasta 0–36 wuxuu leeyahay fursad 1/37. Guul 40 ETB ah oo lambar sax ah waxay soo celisaa 1,332; qayb 222; darsin 111; dibedda 74. Soo-noqoshadu sharadka way ku jirtaa. Eber wuxuu lumiyaa doorashooyinka dibedda.',
      'لكل رقم 0–36 احتمال 1/37. رهان 40 ETB فائز على رقم دقيق يعيد 1,332؛ القطاع 222؛ الدزينة 111؛ الخارجي 74. تشمل العوائد الرهان. الصفر يُخسر الاختيارات الخارجية.',
      'Kila nambari 0–36 ina nafasi ya 1/37. Ushindi wa 40 ETB wa nambari kamili hurudisha 1,332; sekta 222; dazeni 111; nje 74. Marejesho yanajumuisha dau. Sifuri hupoteza machaguo ya nje.',
      'Chaque numéro 0–36 a une chance de 1/37. Une mise gagnante de 40 ETB rapporte 1 332 sur un numéro exact ; 222 sur un secteur ; 111 sur une douzaine ; 74 à l’extérieur. Mise incluse. Zéro fait perdre les sélections extérieures.'
    ),
  'Each number has a 20/80 chance of being drawn. A 25% chance × 3.6× total return gives 90% theoretical return and a 10% expected house edge over repeated play; this is not a guarantee for an individual draw.':
    tr(
      'እያንዳንዱ ቁጥር የመውጣት 20/80 ዕድል አለው። 25% ዕድል × 3.6× ጠቅላላ ተመላሽ በተደጋጋሚ ጨዋታ 90% ንድፈ ሐሳባዊ ተመላሽ እና 10% የሚጠበቅ የመድረክ ቁጥራዊ ብልጫ ይሰጣል፤ ይህ ለአንድ ዕጣ ዋስትና አይደለም።',
      'Lakkoofsi hundi carraa baʼuu 20/80 qaba. Carraa 25% × deebii waliigalaa 3.6× jechuun tapha irra deddeebiʼamu irratti deebii tiyoorii 90% fi caalmaa waltajjii eegamu 10%; carraa baʼuu tokkoof wabii miti.',
      'ነፍሲ ወከፍ ቁጽሪ ናይ ምውጻእ 20/80 ዕድል ኣለዎ። 25% ዕድል × 3.6× ጠቕላላ ተመላሲ ኣብ ተደጋጋሚ ጸወታ 90% ቲዮራዊ ተመላስን 10% ዝትጽበ ቁጽራዊ ብልጫ መድረኽን ይህብ፤ ንሓደ ዕጣ ውሕስነት ኣይኮነን።',
      'Lambar kastaa wuxuu leeyahay fursad 20/80 oo lagu soo saaro. Fursad 25% × soo-noqosho guud 3.6× waxay bixisaa 90% soo-noqosho aragtiyeed iyo 10% faaʼiido xisaabeed oo madasha laga filayo marka marar badan la ciyaaro; ma aha dammaanad hal isku-aad.',
      'لكل رقم احتمال سحب 20/80. احتمال 25% × عائد إجمالي 3.6× يعطي عائدًا نظريًا 90% وأفضلية متوقعة للمنصة 10% عبر اللعب المتكرر؛ وهذا ليس ضمانًا لسحب منفرد.',
      'Kila nambari ina nafasi ya 20/80 ya kutolewa. Nafasi 25% × jumla ya marejesho 3.6× hutoa marejesho ya kinadharia 90% na faida ya kitakwimu ya jukwaa 10% kwa michezo mingi; si hakikisho kwa droo moja.',
      'Chaque numéro a une chance de 20/80 d’être tiré. 25 % de chance × 3,6× de retour total donne 90 % de retour théorique et 10 % d’avantage attendu pour la plateforme sur des jeux répétés ; ce n’est pas une garantie pour un tirage.'
    ),
  'Each round lasts 2 minutes 40 seconds. A first card is visible immediately. The second card arrives at 40 seconds; a third arrives at 80 seconds for hands below 17. Betting closes at 120 seconds, when the remaining cards and results appear.':
    tr(
      'እያንዳንዱ ዙር 2 ደቂቃ 40 ሰከንድ ይቆያል። የመጀመሪያ ካርድ ወዲያውኑ ይታያል። ሁለተኛው በ 40 ሰከንድ፣ ከ 17 በታች ላሉ እጆች ሦስተኛው በ 80 ሰከንድ ይመጣል። ውርርድ በ 120 ሰከንድ ይዘጋል፣ ቀሪ ካርዶች እና ውጤቶችም ይታያሉ።',
      'Marsaan hundi daqiiqaa 2 sekondii 40 tura. Kaardiin jalqabaa battalumatti mulʼata. Lammaffaan sekondii 40 irratti; harka 17 gadiif sadaffaan sekondii 80 irratti dhufa. Buusiin sekondii 120 irratti cufama, yeroo kaardii hafanii fi buʼaan mulʼatan.',
      'ነፍሲ ወከፍ ዙር 2 ደቒቕ 40 ካልኢት ይጸንሕ። ቀዳማይ ካርድ ብቕጽበት ይርአ። ካልኣይ ኣብ 40 ካልኢት፣ ካብ 17 ንታሕቲ ንዘለዉ ኣእዳው ሳልሳይ ኣብ 80 ካልኢት ይመጽእ። ውርርድ ኣብ 120 ካልኢት ይዕጾ፣ ዝተረፉ ካርድታትን ውጽኢታትን ይርኣዩ።',
      'Wareeg kasta wuxuu socdaa 2 daqiiqo 40 ilbiriqsi. Kaarka koowaad isla markiiba wuu muuqdaa. Kaarka labaad wuxuu yimaadaa 40 ilbiriqsi; kan saddexaad 80 ilbiriqsi gacmaha ka hooseeya 17. Sharadku wuxuu xirmaa 120 ilbiriqsi, markaas oo kaararka haray iyo natiijooyinku muuqdaan.',
      'تستغرق كل جولة دقيقتين و 40 ثانية. تظهر الورقة الأولى فورًا. تصل الثانية عند 40 ثانية؛ والثالثة عند 80 ثانية للأيدي دون 17. تُغلق الرهانات عند 120 ثانية، وتظهر الأوراق المتبقية والنتائج.',
      'Kila raundi huchukua dakika 2 sekunde 40. Kadi ya kwanza huonekana mara moja. Ya pili hufika sekunde 40; ya tatu sekunde 80 kwa mikono iliyo chini ya 17. Dau hufungwa sekunde 120, kadi zilizobaki na matokeo zikionekana.',
      'Chaque manche dure 2 minutes 40 secondes. Une première carte est visible immédiatement. La deuxième arrive à 40 secondes ; une troisième à 80 secondes pour les mains sous 17. Les mises ferment à 120 secondes, quand les cartes restantes et les résultats apparaissent.'
    ),
  'Each round lasts one minute. During the first 30 seconds, choose an integer from 1 to 100 and select Place guess. You can place one guess per round and cannot change it after acceptance. Entries close for the final 30 seconds, when everyone sees the same random target. A delayed connection may cause a guess to arrive too late; server time decides acceptance. Your score follows the distance bands above. An exact match has a 1 in 100 chance. Numbers near the ends of the range have fewer nearby targets; proximity scores are not equally likely for every guess.':
    tr(
      'እያንዳንዱ ዙር አንድ ደቂቃ ይቆያል። በመጀመሪያዎቹ 30 ሰከንዶች ከ 1 እስከ 100 ሙሉ ቁጥር መርጠው ግምት አስገባ ይምረጡ። በዙር አንድ ግምት ብቻ ይፈቀዳል፣ ከተቀበለ በኋላ መቀየር አይቻልም። በመጨረሻዎቹ 30 ሰከንዶች ተሳትፎ ይዘጋል፣ ሁሉም ተመሳሳይ ዘፈቀዳዊ ዒላማ ያያሉ። የዘገየ ግንኙነት ግምትን ሊያዘገይ ይችላል፤ ተቀባይነትን የአገልጋዩ ሰዓት ይወስናል። ነጥብዎ ከላይ ያሉትን የርቀት ክልሎች ይከተላል። ትክክለኛ መመሳሰል ከ 100 ውስጥ 1 ዕድል አለው። በክልሉ ጫፎች ያሉ ቁጥሮች ቅርብ ዒላማዎች ያንሳሉ፤ የቅርበት ነጥብ ዕድል ለሁሉም ግምት እኩል አይደለም።',
      'Marsaan hundi daqiiqaa tokko tura. Sekondii 30 jalqabaa keessatti lakkoofsa guutuu 1 hanga 100 filadhu, Tilmaama galchi cuqaasi. Marsaa tokkoof tilmaama tokko qofa, fudhatama booda jijjiiruun hin dandaʼamu. Sekondii 30 dhumaa hirmaannaan cufama, hundi galma carraan filatame tokko argu. Walqunnamtiin harkifate tilmaama tursiisuu dandaʼa; yeroon sarvaraa fudhatama murteessa. Qabxiin kee daangaa fageenyaa armaan olii hordofa. Walitti sirriitti dhufuun carraa 100 keessaa 1 qaba. Lakkoofsi qarqara daangaa galma dhihoo xiqqaa qaba; carraan qabxii dhiheenyaa tilmaama hundaaf walqixa miti.',
      'ነፍሲ ወከፍ ዙር ሓደ ደቒቕ ይጸንሕ። ኣብ ቀዳሞት 30 ካልኢታት ካብ 1 ክሳብ 100 ምሉእ ቁጽሪ ምረጽ፣ ግምት ኣእቱ ጠውቕ። ኣብ ዙር ሓደ ግምት ጥራይ፣ ድሕሪ ምቕባሉ ኣይቅየርን። ኣብ መወዳእታ 30 ካልኢታት ተሳትፎ ይዕጾ፣ ኩሎም ሓደ ብዕድል ዝተመርጸ ዒላማ ይርእዩ። ዝደንጎየ ርክብ ግምት ከደናጉይ ይኽእል፤ ሰዓት ኣገልጋሊ ምቕባል ይውስን። ነጥብኻ ናይ ላዕሊ ክልላት ርሕቀት ይኽተል። ትኽክለኛ ምዝማድ ካብ 100 1 ዕድል ኣለዎ። ቁጽርታት ኣብ ወሰናት ውሑዳት ቀረባ ዒላማታት ኣለዎም፤ ዕድል ነጥቢ ቅርበት ንኹሉ ግምት ማዕረ ኣይኮነን።',
      'Wareeg kasta hal daqiiqo ayuu socdaa. 30-ka ilbiriqsi ee hore dooro tiro dhan 1 ilaa 100 oo dooro Geli qiyaas. Hal qiyaas ayaa loo oggol yahay wareeg kasta, mana beddeli kartid marka la aqbalo. Ka-qaybgalka wuxuu xirmaa 30-ka ilbiriqsi ee dambe, qof walbana wuxuu arkaa isla bartilmaameed nasiib ah. Xiriir dib u dhacay qiyaasta wuu daahin karaa; waqtiga seerfarka ayaa goʼaamiya aqbalidda. Dhibcahaagu waxay raacaan qaybaha masaafada ee kore. Is-waafajin sax ah waxay leedahay fursad 1 ka mid ah 100. Lambarada ku dhow geesaha xadka waxay leeyihiin bartilmaameedyo dhow oo ka yar; dhibcaha u-dhowaanshaha fursaddoodu qiyaas kasta isku mid ma aha.',
      'تستغرق كل جولة دقيقة. خلال أول 30 ثانية، اختر عددًا صحيحًا من 1 إلى 100 واضغط وضع التخمين. لك تخمين واحد في الجولة ولا يمكن تغييره بعد القبول. تُغلق المشاركات في آخر 30 ثانية، ويرى الجميع الهدف العشوائي نفسه. قد يؤخر الاتصال وصول التخمين؛ وقت الخادم يحدد القبول. تتبع نتيجتك نطاقات المسافة أعلاه. المطابقة الدقيقة احتمالها 1 من 100. الأرقام القريبة من طرفي النطاق لها أهداف مجاورة أقل؛ فرص نقاط القرب ليست متساوية لكل تخمين.',
      'Kila raundi huchukua dakika moja. Katika sekunde 30 za kwanza, chagua nambari kamili 1 hadi 100 na uchague Weka makisio. Una makisio moja kwa raundi na huwezi kubadilisha baada ya kukubaliwa. Ushiriki hufungwa sekunde 30 za mwisho, wote wakiona lengo lilelile la nasibu. Muunganisho unaochelewa unaweza kuchelewesha makisio; muda wa seva huamua kukubaliwa. Alama zako hufuata viwango vya umbali hapo juu. Kulingana kikamilifu kuna nafasi 1 kwa 100. Nambari karibu na miisho zina malengo machache ya karibu; nafasi za alama za ukaribu si sawa kwa kila makisio.',
      'Chaque manche dure une minute. Pendant les 30 premières secondes, choisissez un entier de 1 à 100 et sélectionnez Placer une estimation. Une seule estimation par manche, non modifiable après acceptation. Les participations ferment pendant les 30 dernières secondes ; tous voient la même cible aléatoire. Une connexion lente peut faire arriver l’estimation trop tard ; l’heure du serveur décide de l’acceptation. Votre score suit les tranches de distance ci-dessus. Une correspondance exacte a une chance sur 100. Les nombres près des extrémités ont moins de cibles proches ; les scores de proximité n’ont pas la même probabilité pour chaque estimation.'
    ),
  'Each round publishes a SHA-256 commitment before entry and reveals its seed after the crash. This checks that the revealed seed matches the earlier commitment; it is not an independent RNG certification.':
    tr(
      'እያንዳንዱ ዙር ከተሳትፎ በፊት SHA-256 ቅድመ ማረጋገጫ ያሳትማል፣ ከመውደቁ በኋላም መነሻ እሴቱን ይገልጣል። ይህ የተገለጠው እሴት ከቀደመው ማረጋገጫ ጋር መዛመዱን ይፈትሻል፤ ገለልተኛ የRNG ማረጋገጫ አይደለም።',
      'Marsaan hundi hirmaannaa dura ragaa duraa SHA-256 maxxansa, kufaatii booda sanyii isaa mulʼisa. Kun sanyiin mulʼate ragaa duraa wajjin wal simuu mirkaneessa; ragaa RNG qaama walabaatiin kenname miti.',
      'ነፍሲ ወከፍ ዙር ቅድሚ ተሳትፎ SHA-256 ቅድመ መረጋገጺ የሕትም፣ ድሕሪ ምውዳቕ መበገሲ ክብሩ ይገልጽ። እዚ ዝተገልጸ ክብሪ ምስ ቀዳማይ መረጋገጺ ምዝማዱ ይምርምር፤ ናጻ መረጋገጺ RNG ኣይኮነን።',
      'Wareeg kastaa wuxuu daabacaa xaqiijin hore oo SHA-256 ah ka hor gelitaanka, wuxuuna muujiyaa abuurkiisa dhicitaanka ka dib. Tani waxay hubisaa in abuurka la muujiyay la mid yahay xaqiijintii hore; ma aha shahaado RNG oo madax-bannaan.',
      'تنشر كل جولة التزام SHA-256 قبل المشاركة وتكشف بذرتها بعد الانهيار. يتحقق ذلك من مطابقة البذرة للالتزام السابق؛ وليس شهادة مستقلة لمولد الأرقام العشوائية RNG.',
      'Kila raundi huchapisha uthibitisho wa awali wa SHA-256 kabla ya kujiunga na kufichua mbegu yake baada ya kuanguka. Hii hukagua kama mbegu inalingana na uthibitisho wa awali; si uthibitisho huru wa RNG.',
      'Chaque manche publie un engagement SHA-256 avant les participations et révèle sa graine après le crash. Cela vérifie que la graine correspond à l’engagement initial ; ce n’est pas une certification indépendante du RNG.'
    ),
  'Enter a whole stake and a valid auto cash-out target.': tr(
    'ሙሉ ቁጥር የውርርድ መጠን እና ትክክለኛ ራስ-ሰር የጨዋታ መውጫ ዒላማ ያስገቡ።',
    'Buusii lakkoofsa guutuu fi galma ofumaan baʼuu sirrii galchi.',
    'ምሉእ ቁጽሪ ውርርድን ቅኑዕ ርእሰ-ሰር ዒላማ ምውጻእን ኣእቱ።',
    'Geli sharad tiro dhan ah iyo bartilmaameed bixitaan toos ah oo sax ah.',
    'أدخل مبلغ رهان صحيحًا بلا كسور وهدف خروج تلقائي صالحًا.',
    'Weka dau la nambari kamili na lengo halali la kutoka kiotomatiki.',
    'Saisissez une mise entière et une cible d’encaissement automatique valide.'
  ),
  'Entries are locked. The server is revealing the roll.': tr(
    'ተሳትፎዎች ተቆልፈዋል። አገልጋዩ የዳይስ ውጤቱን እየገለጠ ነው።',
    'Hirmaannaan cufameera. Sarvariin darbannaa mulʼisaa jira.',
    'ተሳትፎታት ተዓጽዮም። ኣገልጋሊ ውጽኢት ዳይስ ይገልጽ ኣሎ።',
    'Ka-qaybgalka waa la xiray. Seerfarku rogista ayuu muujinayaa.',
    'المشاركات مقفلة. يكشف الخادم الرمية.',
    'Ushiriki umefungwa. Seva inaonyesha mrusho.',
    'Les participations sont verrouillées. Le serveur révèle le lancer.'
  ),
  'Entry is closed. Wait for the next server-opened round.': tr(
    'ተሳትፎ ተዘግቷል። በአገልጋዩ የሚከፈተውን ቀጣይ ዙር ይጠብቁ።',
    'Hirmaannaan cufameera. Marsaa itti aanu sarvariin banu eegi.',
    'ተሳትፎ ተዓጽዩ። ኣገልጋሊ ዝኸፍቶ ቀጻሊ ዙር ተጸበ።',
    'Ka-qaybgalka wuu xirmay. Sug wareegga xiga ee seerfarku furo.',
    'المشاركة مغلقة. انتظر الجولة التالية التي يفتحها الخادم.',
    'Ushiriki umefungwa. Subiri raundi inayofuata kufunguliwa na seva.',
    'Les participations sont fermées. Attendez la prochaine manche ouverte par le serveur.'
  ),
  'Every finishing order is equally likely. Dog appearance and previous results do not predict the winner. Fixed odds target a 90% average gross return before rounding down to whole ETB. There is no jackpot, bonus round, cash-out or autoplay.':
    tr(
      'ሁሉም የመጨረሻ ቅደም ተከተሎች እኩል ዕድል አላቸው። የውሻ ገጽታ እና ያለፉ ውጤቶች አሸናፊውን አይተነብዩም። ቋሚ ኦድሶች ወደ ሙሉ ETB ወደታች ከማጠጋጋት በፊት 90% አማካይ ጠቅላላ ተመላሽ ያነጣጥራሉ። ጃክፖት፣ የቦነስ ዙር፣ ከጨዋታ ቀድሞ መውጣት ወይም አውቶፕሌይ የለም።',
      'Tartiibni xumuraa hundi carraa walqixa qaba. Bifti saree fi buʼaan darbe moʼataa hin tilmaaman. Oodsiin dhaabbataan ETB guutuutti gadi naanneffamuu dura deebii waliigalaa giddugaleessaa 90% irratti xiyyeeffata. Jaakpootii, marsaa dabalataa, tapha keessaa dursee baʼuu ykn tapha ofumaan hin qabu.',
      'ኩሎም ቅደም ተኸተላት መወዳእታ ማዕረ ዕድል ኣለዎም። መልክዕ ከልብን ዝሓለፉ ውጽኢታትን ተዓዋቲ ኣይግምቱን። ቀወምቲ ኦድስ ናብ ምሉእ ETB ንታሕቲ ቅድሚ ምጥግጋዕ 90% ማእከላይ ጠቕላላ ተመላሲ ዒላማ ኣለዎም። ጃክፖት፣ ቦነስ ዙር፣ ቅድሚ ግዜ ምውጻእ ወይ ርእሰ-ሰር ጸወታ የለን።',
      'Kala horreynta dhammaad kasta waxay leedahay fursad isku mid ah. Muuqaalka eeyga iyo natiijooyinkii hore ma saadaaliyaan guuleystaha. Saamiyada goʼan waxay beegsanayaan 90% celcelis soo-noqosho guud ka hor inta hoos loogu soo koobin ETB dhan. Ma jiro jaakboot, wareeg gunno, bixitaan hore ama ciyaar toos ah.',
      'كل ترتيب وصول متساوي الاحتمال. مظهر الكلب والنتائج السابقة لا يتنبآن بالفائز. تستهدف الأسعار الثابتة متوسط عائد إجمالي 90% قبل التقريب للأسفل إلى ETB صحيح. لا جائزة كبرى أو جولة إضافية أو خروج مبكر أو لعب تلقائي.',
      'Kila mpangilio wa kumaliza una nafasi sawa. Mwonekano wa mbwa na matokeo yaliyopita hayatabiri mshindi. Odds za kudumu zinalenga wastani wa marejesho ya jumla 90% kabla ya kuzungusha chini kuwa ETB kamili. Hakuna jackpot, raundi ya bonasi, kutoka mapema au uchezaji otomatiki.',
      'Chaque ordre d’arrivée a la même probabilité. L’apparence des chiens et les résultats passés ne prédisent pas le vainqueur. Les cotes fixes visent un retour brut moyen de 90 % avant arrondi inférieur à l’ETB entier. Aucun jackpot, manche bonus, encaissement anticipé ou jeu automatique.'
    ),
  'Every finishing order is equally likely. Horse appearance and previous results do not predict the winner. Fixed odds target a 90% average gross return before rounding down to whole ETB. There is no jackpot, bonus round, cash-out or autoplay.':
    tr(
      'ሁሉም የመጨረሻ ቅደም ተከተሎች እኩል ዕድል አላቸው። የፈረስ ገጽታ እና ያለፉ ውጤቶች አሸናፊውን አይተነብዩም። ቋሚ ኦድሶች ወደ ሙሉ ETB ወደታች ከማጠጋጋት በፊት 90% አማካይ ጠቅላላ ተመላሽ ያነጣጥራሉ። ጃክፖት፣ የቦነስ ዙር፣ ከጨዋታ ቀድሞ መውጣት ወይም አውቶፕሌይ የለም።',
      'Tartiibni xumuraa hundi carraa walqixa qaba. Bifti fardaa fi buʼaan darbe moʼataa hin tilmaaman. Oodsiin dhaabbataan ETB guutuutti gadi naanneffamuu dura deebii waliigalaa giddugaleessaa 90% irratti xiyyeeffata. Jaakpootii, marsaa dabalataa, tapha keessaa dursee baʼuu ykn tapha ofumaan hin qabu.',
      'ኩሎም ቅደም ተኸተላት መወዳእታ ማዕረ ዕድል ኣለዎም። መልክዕ ፈረስን ዝሓለፉ ውጽኢታትን ተዓዋቲ ኣይግምቱን። ቀወምቲ ኦድስ ናብ ምሉእ ETB ንታሕቲ ቅድሚ ምጥግጋዕ 90% ማእከላይ ጠቕላላ ተመላሲ ዒላማ ኣለዎም። ጃክፖት፣ ቦነስ ዙር፣ ቅድሚ ግዜ ምውጻእ ወይ ርእሰ-ሰር ጸወታ የለን።',
      'Kala horreynta dhammaad kasta waxay leedahay fursad isku mid ah. Muuqaalka faraska iyo natiijooyinkii hore ma saadaaliyaan guuleystaha. Saamiyada goʼan waxay beegsanayaan 90% celcelis soo-noqosho guud ka hor inta hoos loogu soo koobin ETB dhan. Ma jiro jaakboot, wareeg gunno, bixitaan hore ama ciyaar toos ah.',
      'كل ترتيب وصول متساوي الاحتمال. مظهر الحصان والنتائج السابقة لا يتنبآن بالفائز. تستهدف الأسعار الثابتة متوسط عائد إجمالي 90% قبل التقريب للأسفل إلى ETB صحيح. لا جائزة كبرى أو جولة إضافية أو خروج مبكر أو لعب تلقائي.',
      'Kila mpangilio wa kumaliza una nafasi sawa. Mwonekano wa farasi na matokeo yaliyopita hayatabiri mshindi. Odds za kudumu zinalenga wastani wa marejesho ya jumla 90% kabla ya kuzungusha chini kuwa ETB kamili. Hakuna jackpot, raundi ya bonasi, kutoka mapema au uchezaji otomatiki.',
      'Chaque ordre d’arrivée a la même probabilité. L’apparence des chevaux et les résultats passés ne prédisent pas le vainqueur. Les cotes fixes visent un retour brut moyen de 90 % avant arrondi inférieur à l’ETB entier. Aucun jackpot, manche bonus, encaissement anticipé ou jeu automatique.'
    ),
  'Follow numbered runner progress below and the official finishing order above.': tr(
    'ከታች የተቆጠሩ ተወዳዳሪዎችን ሂደት እና ከላይ የተረጋገጠውን የመጨረሻ ቅደም ተከተል ይከታተሉ።',
    'Adeemsa dorgomtoota lakkoofsa qabanii armaan gadii fi tartiiba xumuraa mirkanaaʼe armaan olii hordofi.',
    'ኣብ ታሕቲ ከይዲ ቁጽሪ ዘለዎም ተወዳደርቲ፣ ኣብ ላዕሊ ከኣ ዝተረጋገጸ ቅደም ተኸተል መወዳእታ ተኸታተል።',
    'Hoos kala soco horumarka tartamayaasha lambaraysan, kornana kala horreynta dhammaadka ee la xaqiijiyay.',
    'تابع تقدم المتسابقين المرقّمين أدناه وترتيب الوصول الرسمي أعلاه.',
    'Fuata maendeleo ya washiriki wenye nambari hapa chini na mpangilio rasmi wa kumaliza hapo juu.',
    'Suivez la progression des partants numérotés ci-dessous et l’ordre d’arrivée officiel ci-dessus.'
  ),
  'For number bets the amount applies to each number. Other markets use one amount per selection. Amounts are in steps of 5 ETB, with a total limit of 500 ETB per bet.':
    tr(
      'ለቁጥር ውርርዶች መጠኑ በእያንዳንዱ ቁጥር ይተገበራል። ሌሎች ገበያዎች በምርጫ አንድ መጠን ይጠቀማሉ። መጠኖች በ 5 ETB ደረጃዎች ናቸው፣ በውርርድ ጠቅላላ ገደብ 500 ETB ነው።',
      'Buusii lakkoofsaaf maallaqni lakkoofsa hundatti hojjeta. Gabaan biroo filannoo tokkoof maallaqa tokko fayyadama. Maallaqni tarkaanfii 5 ETB, daangaan waliigalaa buusii tokkoof 500 ETB.',
      'ንውርርድ ቁጽሪ መጠን ኣብ ነፍሲ ወከፍ ቁጽሪ ይትግበር። ካልኦት ዕዳጋታት ንሓደ ምርጫ ሓደ መጠን ይጥቀሙ። መጠናት ብ 5 ETB ደረጃታት፣ ጠቕላላ ደረት ንውርርድ 500 ETB እዩ።',
      'Sharadyada lambarada, qaddarku lambar kasta ayuu khuseeyaa. Suuqyada kale hal qaddar ayay u isticmaalaan doorasho kasta. Qaddarradu waa tallaabooyin 5 ETB ah, iyadoo xadka guud ee sharad kastaa yahay 500 ETB.',
      'في رهانات الأرقام، يُطبّق المبلغ على كل رقم. الأسواق الأخرى تستخدم مبلغًا واحدًا لكل اختيار. المبالغ بزيادات 5 ETB، بحد إجمالي 500 ETB لكل رهان.',
      'Kwa dau za nambari, kiasi hutumika kwa kila nambari. Masoko mengine hutumia kiasi kimoja kwa chaguo. Kiasi ni kwa hatua za 5 ETB, kikomo cha jumla 500 ETB kwa dau.',
      'Pour les mises sur numéros, le montant s’applique à chaque numéro. Les autres marchés utilisent un montant par sélection. Montants par paliers de 5 ETB, avec une limite totale de 500 ETB par mise.'
    ),
  'Free practice · No cash value · Salem’s original table rules': tr(
    'ነፃ ልምምድ · የገንዘብ ዋጋ የለውም · የሳሌም መሠረታዊ የጠረጴዛ ደንቦች',
    'Shaakala bilisaa · Gatii maallaqaa hin qabu · Seera minjaalaa Salem jalqabaa',
    'ነጻ ልምምድ · ዋጋ ገንዘብ የብሉን · ናይ ሳሌም መሰረታዊ ሕግታት ጠረጴዛ',
    'Tababar bilaash ah · Qiime lacag ma laha · Xeerarka miiska asalka ah ee Salem',
    'تدريب مجاني · بلا قيمة نقدية · قواعد طاولة سالم الأصلية',
    'Mazoezi bila malipo · Hakuna thamani ya pesa · Kanuni asili za meza ya Salem',
    'Entraînement gratuit · Aucune valeur monétaire · Règles de table originales de Salem'
  ),
  'Games are temporarily unavailable. Please try again shortly.': tr(
    'ጨዋታዎች ለጊዜው አይገኙም። እባክዎ ትንሽ ቆይተው ይሞክሩ።',
    'Taphoonni yeroo muraasaaf hin argaman. Xiqqoo booda irra deebiʼii yaali.',
    'ጸወታታት ንግዚኡ ኣይርከቡን። ቁሩብ ጸኒሕካ ፈትን።',
    'Ciyaaraha hadda lama heli karo. Fadlan wax yar ka dib isku day.',
    'الألعاب غير متاحة مؤقتًا. يرجى المحاولة بعد قليل.',
    'Michezo haipatikani kwa muda. Tafadhali jaribu tena baada ya muda mfupi.',
    'Les jeux sont temporairement indisponibles. Réessayez dans un instant.'
  ),
  'Gross multiples of the amount, including the stake. Fewer than six matches returns zero.': tr(
    'ውርርዱን ጨምሮ የመጠኑ ጠቅላላ ብዜቶች። ከስድስት ያነሱ ተዛማጆች ዜሮ ይመልሳሉ።',
    'Dachaa waliigalaa maallaqaa, buusii dabalatee. Walsimannaan jaʼaa gadi zeeroo deebisa.',
    'ውርርድ ሓዊሱ ጠቕላላ ብዜታት መጠን። ካብ ሽዱሽተ ዝውሕዱ ዝተዛመዱ ዜሮ ይመልሱ።',
    'Dhufashada guud ee qaddarka, oo sharadku ku jiro. Wax ka yar lix is-waafajin waxay soo celiyaan eber.',
    'مضاعفات إجمالية للمبلغ، شاملة الرهان. أقل من ست مطابقات يعيد صفرًا.',
    'Vizidisho vya jumla vya kiasi, vikijumuisha dau. Chini ya sita zinazolingana hurudisha sifuri.',
    'Multiples bruts du montant, mise incluse. Moins de six correspondances rapporte zéro.'
  ),
  'Highest confirmed ticket returns · practice ETB · includes stake': tr(
    'ከፍተኛ የተረጋገጡ የትኬት ተመላሾች · የልምምድ ETB · ውርርዱን ያካትታል',
    'Deebii tikeetii mirkanaaʼe olaanaa · ETB shaakalaa · buusii dabalata',
    'ዝለዓሉ ዝተረጋገጹ ተመላሲታት ትኬት · ETB ልምምድ · ውርርድ ይሓውስ',
    'Soo-noqoshada tigidhada la xaqiijiyay ee ugu sarreysa · ETB tababar · sharadku wuu ku jiraa',
    'أعلى عوائد التذاكر المؤكدة · ETB تدريبي · تشمل الرهان',
    'Marejesho makubwa ya tiketi zilizothibitishwa · ETB ya mazoezi · dau limejumuishwa',
    'Plus grands retours de tickets confirmés · ETB d’entraînement · mise incluse'
  ),
  'Includes your stake. A losing selection returns 0.': tr(
    'ውርርድዎን ያካትታል። የተሸነፈ ምርጫ 0 ይመልሳል።',
    'Buusii kee dabalata. Filannoon moʼame 0 deebisa.',
    'ውርርድካ ይሓውስ። ዝተሳዕረ ምርጫ 0 ይመልስ።',
    'Sharadkaagu wuu ku jiraa. Doorasho guuldarreysata waxay soo celisaa 0.',
    'يشمل رهانك. الاختيار الخاسر يعيد 0.',
    'Inajumuisha dau lako. Chaguo lililopoteza hurudisha 0.',
    'Inclut votre mise. Une sélection perdante rapporte 0.'
  ),
  'Includes your stake. Settles at showdown. Virtual ETB has no cash value.': tr(
    'ውርርድዎን ያካትታል። ካርዶች ሲገለጡ ይከፈላል። ምናባዊ ETB የገንዘብ ዋጋ የለውም።',
    'Buusii kee dabalata. Yeroo kaardiin mulʼatu kaffalama. ETB fakkeeffame gatii maallaqaa hin qabu.',
    'ውርርድካ ይሓውስ። ካርድታት ምስ ተገልጹ ይኽፈል። ምናባዊ ETB ዋጋ ገንዘብ የብሉን።',
    'Sharadkaagu wuu ku jiraa. Waxaa la bixiyaa marka kaararka la muujiyo. ETB dalwaddu qiime lacag dhab ah ma laha.',
    'يشمل رهانك. يُسوّى عند كشف الأوراق. ETB الافتراضي بلا قيمة نقدية.',
    'Inajumuisha dau lako. Hulipwa kadi zinapoonyeshwa. ETB pepe haina thamani ya pesa halisi.',
    'Inclut votre mise. Réglé à l’abattage. L’ETB virtuel n’a aucune valeur monétaire.'
  ),
  'Independent random targets · previous results cannot predict the next number': tr(
    'ገለልተኛ ዘፈቀዳዊ ዒላማዎች · ያለፉ ውጤቶች ቀጣዩን ቁጥር ሊተነብዩ አይችሉም',
    'Galma carraa walaba · buʼaan darbe lakkoofsa itti aanu tilmaamuu hin dandaʼu',
    'ናጻ ዘፈቀዳዊ ዒላማታት · ዝሓለፉ ውጽኢታት ቀጻሊ ቁጽሪ ክግምቱ ኣይክእሉን',
    'Bartilmaameedyo nasiib oo madax-bannaan · natiijooyinkii hore ma saadaalin karaan lambarka xiga',
    'أهداف عشوائية مستقلة · النتائج السابقة لا تتنبأ بالرقم التالي',
    'Malengo huru ya nasibu · matokeo yaliyopita hayawezi kutabiri nambari inayofuata',
    'Cibles aléatoires indépendantes · les résultats précédents ne prédisent pas le prochain numéro'
  ),
  'Keep up to ten independent bets. Choose and confirm each separately.': tr(
    'እስከ አስር ገለልተኛ ውርርዶች ይያዙ። እያንዳንዱን ለየብቻ ይምረጡ እና ያረጋግጡ።',
    'Hanga buusii walaba kudhan qabaadhu. Tokkoon tokkoon addaan filadhuu mirkaneessi.',
    'ክሳብ ዓሰርተ ናጻ ውርርዳት ሓዝ። ንነፍሲ ወከፍ በበይኑ ምረጽን ኣረጋግጽን።',
    'Hayso ilaa toban sharad oo gooni ah. Mid kasta si gaar ah u dooro una xaqiiji.',
    'احتفظ بما يصل إلى عشرة رهانات مستقلة. اختر وأكّد كلًا منها على حدة.',
    'Weka hadi dau kumi tofauti. Chagua na uthibitishe kila moja kando.',
    'Gardez jusqu’à dix mises indépendantes. Choisissez et confirmez chacune séparément.'
  ),
  'Keep up to ten independent confirmed bets per draw. Each bet has its own selection and amount.':
    tr(
      'በእያንዳንዱ ዕጣ እስከ አስር ገለልተኛ የተረጋገጡ ውርርዶች ይያዙ። እያንዳንዱ ውርርድ የራሱ ምርጫ እና መጠን አለው።',
      'Carraa baʼuu tokkoof hanga buusii mirkanaaʼe walaba kudhan qabaadhu. Buusiin hundi filannoo fi maallaqa mataa isaa qaba.',
      'ኣብ ነፍሲ ወከፍ ዕጣ ክሳብ ዓሰርተ ናጻ ዝተረጋገጹ ውርርዳት ሓዝ። ነፍሲ ወከፍ ውርርድ ናቱ ምርጫን መጠንን ኣለዎ።',
      'Hayso ilaa toban sharad oo gooni ah oo la xaqiijiyay isku-aad kasta. Sharad kastaa wuxuu leeyahay doorasho iyo qaddar u gaar ah.',
      'حتى عشرة رهانات مستقلة مؤكدة لكل سحب. لكل رهان اختياره ومبلغه.',
      'Weka hadi dau kumi tofauti zilizothibitishwa kwa droo. Kila dau lina chaguo na kiasi chake.',
      'Gardez jusqu’à dix mises indépendantes confirmées par tirage. Chaque mise a sa sélection et son montant.'
    ),
};
export default catalogue;
