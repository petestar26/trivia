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
  '. Check this saved request before choosing another number.': tr(
    '። ሌላ ቁጥር ከመምረጥዎ በፊት ይህን የተቀመጠ ጥያቄ ያረጋግጡ።',
    '. Lakkoofsa biraa filachuu dura gaaffii olkaaʼame kana ilaali.',
    '። ካልእ ቁጽሪ ቅድሚ ምምራጽካ ነዚ ዝተዓቀበ ሕቶ ኣረጋግጽ።',
    '. Hubi codsigan kaydsan ka hor inta aadan dooran lambar kale.',
    '. تحقّق من هذا الطلب المحفوظ قبل اختيار رقم آخر.',
    '. Kagua ombi hili lililohifadhiwa kabla ya kuchagua nambari nyingine.',
    '. Vérifiez cette demande enregistrée avant de choisir un autre numéro.'
  ),
  '45 seconds to join, followed by 10 seconds reveal time and 5 seconds result time. The server publishes the result; outages can delay rounds.':
    tr(
      'ለመሳተፍ 45 ሰከንዶች፣ ከዚያ ለመግለጥ 10 ሰከንዶች እና ውጤቱን ለማየት 5 ሰከንዶች። አገልጋዩ ውጤቱን ያሳትማል፤ መቋረጦች ዙሮችን ሊያዘገዩ ይችላሉ።',
      'Hirmaachuuf sekondii 45, achiis mulʼisuuf sekondii 10 fi buʼaaf sekondii 5. Sarvariin buʼaa maxxansa; addaan cituun marsaa tursiisuu dandaʼa.',
      'ንምስታፍ 45 ካልኢታት፣ ቀጺሉ ንምግላጽ 10 ካልኢታትን ንውጽኢት 5 ካልኢታትን። ኣገልጋሊ ውጽኢት የሕትም፤ ምቁራጽ ዙራት ከደናጉይ ይኽእል።',
      '45 ilbiriqsi oo lagu biiro, ka dib 10 ilbiriqsi oo muujin ah iyo 5 ilbiriqsi oo natiijo ah. Seerfarku natiijada ayuu soo saaraa; ciladuhu wareegyada way dib dhigi karaan.',
      '45 ثانية للانضمام، ثم 10 ثوانٍ للكشف و 5 ثوانٍ لعرض النتيجة. ينشر الخادم النتيجة؛ وقد تؤخر الأعطال الجولات.',
      'Sekunde 45 za kujiunga, kisha sekunde 10 za kuonyesha na sekunde 5 za matokeo. Seva huchapisha matokeo; kukatika kunaweza kuchelewesha raundi.',
      '45 secondes pour participer, puis 10 secondes de révélation et 5 secondes de résultat. Le serveur publie le résultat ; une panne peut retarder les manches.'
    ),
  '90% theoretical player return; 10% expected house edge before costs. Individual results vary.':
    tr(
      '90% ንድፈ ሐሳባዊ የተጫዋች ተመላሽ፤ ከወጪዎች በፊት 10% የሚጠበቅ የመድረኩ ቁጥራዊ ብልጫ። የእያንዳንዱ ውጤት ይለያያል።',
      'Deebii tiyoorii taphataa 90%; caalmaa waltajjii eegamu 10% baasii dura. Buʼaan dhuunfaa garaagarummaa qaba.',
      '90% ቲዮራዊ ተመላሲ ተጻዋታይ፤ ቅድሚ ወጻኢታት 10% ዝትጽበ ቁጽራዊ ብልጫ መድረኽ። ናይ ውልቀ ውጽኢታት ይፈላለዩ።',
      '90% soo-noqosho aragtiyeed oo ciyaartoyga ah; 10% faaʼiido xisaabeed oo madasha laga filayo ka hor kharashyada. Natiijooyinka qof walba way kala duwan yihiin.',
      'العائد النظري للاعب 90%؛ وأفضلية المنصة المتوقعة 10% قبل التكاليف. تختلف النتائج الفردية.',
      'Marejesho ya kinadharia kwa mchezaji ni 90%; faida ya kitakwimu inayotarajiwa ya jukwaa ni 10% kabla ya gharama. Matokeo binafsi hutofautiana.',
      'Retour théorique au joueur de 90 % ; avantage attendu de la plateforme de 10 % avant frais. Les résultats individuels varient.'
    ),
  '90% theoretical return over repeated play. These practice selections do not debit a balance or earn cash. Your saved tickets and the last 12 results survive refresh. No automatic repeat bets.':
    tr(
      'በተደጋጋሚ ጨዋታ 90% ንድፈ ሐሳባዊ ተመላሽ። እነዚህ የልምምድ ምርጫዎች ከሂሳብ አይቀንሱም ወይም ገንዘብ አያስገኙም። የተቀመጡ ትኬቶችዎ እና የመጨረሻ 12 ውጤቶች ገጹን ሲያድሱ ይቆያሉ። አውቶማቲክ ተደጋጋሚ ውርርድ የለም።',
      'Tapha irra deddeebiʼamu irratti deebii tiyoorii 90%. Filannoowwan shaakalaa kun haftee hin hirʼisan ykn maallaqa hin argamsiisan. Tikeetota olkaaʼamanii fi buʼaawwan 12 dhumaa haaromsa booda ni turu. Buusiin ofumaan irra hin deebiʼamu.',
      'ኣብ ተደጋጋሚ ጸወታ 90% ቲዮራዊ ተመላሲ። እዞም ምርጫታት ልምምድ ካብ ሒሳብ ኣይቅንሱን ገንዘብ እውን ኣየምጽኡን። ዝተዓቀቡ ትኬታትካን ናይ መወዳእታ 12 ውጽኢታትን ድሕሪ ምሕዳስ ይጸንሑ። ብርእሱ ዝድገም ውርርድ የለን።',
      '90% soo-noqosho aragtiyeed marka marar badan la ciyaaro. Doorashooyinkan tababarku haraag kama jaraan lacag dhab ahna ma kasbadaan. Tigidhada kaydsan iyo 12-kii natiijo ee u dambeeyay way sii jiraan marka la cusboonaysiiyo. Sharadku si toos ah isuma celiyo.',
      'عائد نظري 90% عبر اللعب المتكرر. لا تخصم اختيارات التدريب هذه من الرصيد ولا تكسب نقدًا. تبقى تذاكرك المحفوظة وآخر 12 نتيجة بعد تحديث الصفحة. لا تكرار تلقائي للرهانات.',
      'Marejesho ya kinadharia ya 90% kwa kucheza mara nyingi. Machaguo haya ya mazoezi hayapunguzi salio wala kupata pesa halisi. Tiketi zilizohifadhiwa na matokeo 12 ya mwisho hubaki ukisasisha ukurasa. Hakuna kurudia dau kiotomatiki.',
      'Retour théorique de 90 % sur des jeux répétés. Ces sélections d’entraînement ne débitent aucun solde et ne rapportent pas d’argent. Vos tickets enregistrés et les 12 derniers résultats sont conservés après actualisation. Aucune répétition automatique des mises.'
    ),
  'A bet is awaiting confirmation. Retry checks the same receipt.': tr(
    'ውርርድ ማረጋገጫን እየጠበቀ ነው። ዳግም መሞከር ያንኑ ደረሰኝ ይፈትሻል።',
    'Buusiin mirkaneessa eegaa jira. Irra deebiʼuun nagahee isuma ilaala.',
    'ውርርድ ምርግጋጽ ይጽበ ኣሎ። ዳግም ምፍታን ነቲ ተመሳሳሊ ቅብሊት ይምርምር።',
    'Sharad ayaa sugaya xaqiijin. Dib-u-tijaabintu waxay hubisaa isla rasiidkii.',
    'رهان بانتظار التأكيد. إعادة المحاولة تتحقق من الإيصال نفسه.',
    'Dau linasubiri uthibitisho. Kujaribu tena hukagua risiti ileile.',
    'Une mise attend confirmation. Réessayer vérifie le même reçu.'
  ),
  'A fresh six-deck shoe is used each round, without replacement. Prices are estimates from simulations of the visible cards, rounded down and capped at 200×. The 21 market excludes a two-card natural Blackjack.':
    tr(
      'በእያንዳንዱ ዙር አዲስ ስድስት የካርድ ጥቅሎች ይጠቀማሉ፤ የወጡ ካርዶች አይመለሱም። ዋጋዎቹ ከሚታዩ ካርዶች ማስመሰያ የተገመቱ፣ ወደታች የተጠጋጉ እና እስከ 200× የተገደቡ ናቸው። የ 21 ገበያ በመጀመሪያ ሁለት ካርዶች የሚገኝ ብላክጃክን አያካትትም።',
      'Marsaa hunda kuusaan kaardii paakkii jaʼaa haaraan fayyada; kaardiin baʼe hin deebiʼu. Gatiin tilmaama fakkeessuu kaardii mulʼatu irraa, gara gadiitti naanneffamee hanga 200× daangeffama. Gabaan 21 Blackjack uumamaa kaardii lamaan hin hammatu.',
      'ኣብ ነፍሲ ወከፍ ዙር ሓድሽ ሽዱሽተ ጥቕላላት ካርድ ይጥቀሙ፤ ዝወጹ ካርድታት ኣይምለሱን። ዋጋታት ካብ ምምሳል ዝርኣዩ ካርድታት ዝተገመቱ፣ ንታሕቲ ዝተጠጋገዑን ክሳብ 200× ዝተወሰኑን እዮም። ዕዳጋ 21 ብቐዳሞት ክልተ ካርድታት ዝርከብ ብላክጃክ ኣየካትትን።',
      'Wareeg kasta waxaa la isticmaalaa lix xirmo kaarar cusub, kaarka baxayna dib looma celiyo. Qiimayaashu waa qiyaaso ka yimid tijaabooyin kaararka muuqda, hoos loo soo koobay oo ugu badnaan 200× ah. Suuqa 21 kuma jiro Blackjack-ka dabiiciga ah ee labada kaar.',
      'تُستخدم ست مجموعات أوراق جديدة في كل جولة، دون إعادة الأوراق المسحوبة. الأسعار تقديرات من محاكاة الأوراق الظاهرة، مقربة للأسفل وبحد أقصى 200×. سوق 21 يستثني بلاك جاك الطبيعي المكوّن من ورقتين.',
      'Kila raundi hutumia vifurushi sita vipya vya kadi bila kurudisha kadi zilizotolewa. Bei ni makadirio ya uigaji wa kadi zinazoonekana, zikizungushwa chini na kuwekwa kikomo cha 200×. Soko la 21 halijumuishi Blackjack ya asili ya kadi mbili.',
      'Chaque manche utilise six jeux de cartes neufs, sans remise. Les cotes sont estimées par simulation des cartes visibles, arrondies vers le bas et plafonnées à 200×. Le marché 21 exclut le Blackjack naturel à deux cartes.'
    ),
  'A return includes the stake. If the crash happens first, that ticket returns zero. Matching the crash multiplier also loses.':
    tr(
      'ተመላሽ ውርርዱን ያካትታል። መውደቁ ቀድሞ ከሆነ ትኬቱ ዜሮ ይመልሳል። ከመውደቂያ አባዥ ጋር እኩል መሆንም ያስሸንፋል።',
      'Deebiin buusii ni dabalata. Yoo kufaatiin dura taʼe, tikeetiin sun zeeroo deebisa. Baayʼisaa kufaatii wajjin walqixxaachuunis ni moʼama.',
      'ተመላሲ ውርርድ ይሓውስ። ምውዳቕ ቅድሚኡ እንተኾይኑ ትኬት ዜሮ ይመልስ። ምስ ረቛሒ ምውዳቕ ማዕረ ምዃን እውን የስዕር።',
      'Soo-noqoshadu sharadka way ku jirtaa. Haddii dhicitaanku hor dhaco, tigidhku eber ayuu soo celiyaa. La mid noqoshada isku-dhufashada dhicitaanka sidoo kale waa guuldarro.',
      'العائد يشمل مبلغ الرهان. إذا وقع الانهيار أولًا، تعيد التذكرة صفرًا. مساواة مضاعف الانهيار تؤدي أيضًا إلى الخسارة.',
      'Marejesho yanajumuisha dau. Ikiwa kuanguka kutatokea kwanza, tiketi hurudisha sifuri. Kulingana na kizidishi cha kuanguka pia hupoteza.',
      'Le retour inclut la mise. Si le crash arrive d’abord, le ticket rapporte zéro. Égaler exactement le multiplicateur du crash fait également perdre.'
    ),
  'A simulated race with equal-chance runners. Previous results do not predict the next finish. Practice ETB have no monetary value.':
    tr(
      'እኩል ዕድል ያላቸው ተወዳዳሪዎች የሚሳተፉበት ማስመሰያ ውድድር። ያለፉ ውጤቶች ቀጣዩን አጨራረስ አይተነብዩም። የልምምድ ETB የገንዘብ ዋጋ የላቸውም።',
      'Fiigicha fakkeeffame dorgomtoota carraa walqixaa qaban waliin. Buʼaan darbe xumura itti aanu hin tilmaamu. ETB shaakalaa gatii maallaqaa hin qabu.',
      'ዝተመሰለ ውድድር ምስ ማዕረ ዕድል ዘለዎም ተወዳደርቲ። ዝሓለፉ ውጽኢታት ቀጻሊ ኣወዳድኣ ኣይግምቱን። ETB ልምምድ ዋጋ ገንዘብ የብሉን።',
      'Tartan la matalay oo tartamayaashu fursad isku mid ah leeyihiin. Natiijooyinkii hore ma saadaaliyaan dhammaadka xiga. ETB tababarku qiime lacag dhab ah ma laha.',
      'سباق محاكى بمتسابقين متساويي الفرص. النتائج السابقة لا تتنبأ بالنهاية التالية. ETB التدريبي بلا قيمة نقدية.',
      'Mbio za kuiga zenye washiriki wenye nafasi sawa. Matokeo yaliyopita hayatabiri mwisho unaofuata. ETB ya mazoezi haina thamani ya pesa halisi.',
      'Une course simulée entre partants ayant les mêmes chances. Les résultats passés ne prédisent pas la prochaine arrivée. Les ETB d’entraînement n’ont aucune valeur monétaire.'
    ),
  'All bets share one server-generated number. Returns include winning stakes; zero loses every group bet. Selections use multiples of 40 Coins.':
    tr(
      'ሁሉም ውርርዶች በአገልጋዩ የተፈጠረ አንድ ቁጥር ይጋራሉ። ተመላሾች አሸናፊ ውርርዶችን ያካትታሉ፤ ዜሮ ሁሉንም የቡድን ውርርዶች ያስሸንፋል። ምርጫዎች የ 40 ሳንቲሞች ብዜቶችን ይጠቀማሉ።',
      'Buusiiwwan hundi lakkoofsa sarvariin uume tokko waliin qooddatu. Deebiin buusii moʼate ni dabalata; zeeroon buusii garee hunda moʼa. Filannoowwan dachaa Saantima 40 fayyadamu.',
      'ኩሎም ውርርዳት ሓደ ብኣገልጋሊ ዝተፈጥረ ቁጽሪ ይካፈሉ። ተመላሲታት ተዓወትቲ ውርርዳት ይሓውሱ፤ ዜሮ ንኹሎም ውርርዳት ጉጅለ የስዕር። ምርጫታት ብዜት 40 ሳንቲም ይጥቀሙ።',
      'Dhammaan sharadyadu waxay wadaagaan hal lambar oo seerfarku sameeyay. Soo-noqoshadu sharadyada guuleystay way ku jiraan; eber wuxuu lumiyaa sharad kasta oo kooxeed. Doorashooyinku waxay isticmaalaan dhufashada 40 qadaadiic.',
      'تشترك جميع الرهانات في رقم واحد يولده الخادم. تشمل العوائد مبالغ الرهانات الفائزة؛ والصفر يُخسر كل رهانات المجموعات. تستخدم الاختيارات مضاعفات 40 عملة.',
      'Dau zote hushiriki nambari moja inayotolewa na seva. Marejesho yanajumuisha dau zilizoshinda; sifuri hupoteza kila dau la kundi. Machaguo hutumia vizidisho vya Sarafu 40.',
      'Toutes les mises partagent un même numéro généré par le serveur. Les retours incluent les mises gagnantes ; zéro fait perdre toutes les mises de groupe. Les sélections utilisent des multiples de 40 pièces.'
    ),
  'All hands stand on 17, including soft 17. Aces count as 1 or 11; picture cards count as 10. Blackjack is an Ace and any ten-value card on the first two cards and beats a multi-card 21. A busted seat loses even when the dealer busts. Equal surviving hands draw.':
    tr(
      'ሁሉም እጆች በ 17 ይቆማሉ፣ ኤስ 11 የሚቆጠርበትን 17 ጨምሮ። ኤሶች 1 ወይም 11፣ የሥዕል ካርዶች 10 ይቆጠራሉ። ብላክጃክ በመጀመሪያ ሁለት ካርዶች ኤስ እና ማንኛውም የ 10 ዋጋ ካርድ ሲኖር ነው፤ በብዙ ካርዶች የተገኘ 21 ን ያሸንፋል። ከ 21 ያለፈ መቀመጫ አከፋፋዩም ቢያልፍ ይሸነፋል። ያላለፉ እኩል እጆች አቻ ይሆናሉ።',
      'Harki hundi 17 irratti dhaabbata,17 Aasiin 11 taʼus dabalatee. Aasiin 1 ykn 11; kaardii suuraa 10. Blackjack kaardii jalqabaa lama keessaa Aasii fi kaardii gatii 10 dha;21 kaardii hedduun argame ni moʼa. Bakki 21 darbe yoo qoodaanis darbe ni moʼama. Harki hin darbine walqixa taanaan walqixa xumurama.',
      'ኩሎም ኣእዳው ኣብ 17 ይቖሙ፣ ኤስ 11 ዝቑጸረሉ 17 እውን። ኤስ 1 ወይ 11፣ ስእላዊ ካርድታት 10 ይቑጸሩ። ብላክጃክ ኣብ ቀዳሞት ክልተ ካርድታት ኤስን ግምት 10 ዘለዎ ካርድን እዩ፤ ብብዙሓት ካርድታት ዝተረኽበ 21 ይስዕር። ካብ 21 ዝሓለፈ መቐመጢ ኣከፋፋሊ እውን እንተሓሊፉ ይስዓር። ዘይሓለፉ ማዕረ ኣእዳው ማዕረ ይኾኑ።',
      'Gacan kastaa 17 ayay ku istaagtaa, oo ay ku jirto 17 uu Aasku 11 yahay. Aasku 1 ama 11 ayuu yahay; kaararka sawirku 10. Blackjack waa Aas iyo kaar kasta oo 10 ah labada kaar ee hore, wuxuuna ka adkaadaa 21 kaarar badan leh. Kursi ka badan 21 wuu lumiyaa xitaa haddii qaybiyuhu ka bato 21. Gacmo isku mid ah oo aan dhaafin waa barbaro.',
      'تقف جميع الأيدي عند 17، بما فيها 17 المرنة. الآس يساوي 1 أو 11؛ والأوراق المصورة 10. بلاك جاك هو آس وورقة بقيمة عشرة ضمن أول ورقتين، ويتفوق على 21 بأكثر من ورقتين. المقعد المتجاوز 21 يخسر حتى إن تجاوز الموزّع. الأيدي المتساوية غير المتجاوزة تتعادل.',
      'Mikono yote husimama 17, ikiwemo 17 yenye ace inayohesabiwa 11. Ace ni 1 au 11; kadi za picha ni 10. Blackjack ni ace na kadi yenye thamani 10 katika kadi mbili za kwanza, na hushinda 21 ya kadi nyingi. Kiti kilichozidi 21 hupoteza hata muuzaji akizidi 21. Mikono sawa isiyozidi hutoka sare.',
      'Toutes les mains s’arrêtent à 17, y compris un 17 souple. Les as valent 1 ou 11 ; les figures 10. Un Blackjack est un as et une carte de valeur dix parmi les deux premières cartes ; il bat un 21 à plusieurs cartes. Un siège qui dépasse 21 perd même si le croupier dépasse aussi. Des mains égales non dépassées font match nul.'
    ),
  'Amount steps are 5 ETB, up to 500 ETB total per bet. All colors uses 5–60 ETB per line, costing 40–480 ETB total. Every return settles after the final ball.':
    tr(
      'መጠኑ በ 5 ETB ደረጃዎች እስከ 500 ETB በእያንዳንዱ ውርርድ ይደርሳል። ሁሉም ቀለሞች በመስመር 5–60 ETB፣ በጠቅላላ 40–480 ETB ያስከፍላሉ። ሁሉም ተመላሽ ከመጨረሻው ኳስ በኋላ ይከፈላል።',
      'Maallaqni tarkaanfii 5 ETB, buusii tokkoof waliigala hanga 500 ETB. Halluu hundaaf sarara tokko 5–60 ETB, waliigala 40–480 ETB. Deebiin hundi kubbaa dhumaa booda kaffalama.',
      'መጠን ብ 5 ETB ደረጃታት ክሳብ 500 ETB ንሓደ ውርርድ። ኩሎም ሕብርታት ንሓደ መስመር 5–60 ETB፣ ጠቕላላ 40–480 ETB የኽፍሉ። ኩሉ ተመላሲ ድሕሪ መወዳእታ ኩዕሶ ይኽፈል።',
      'Qaddarku 5 ETB ayuu u kordhaa, ilaa 500 ETB wadarta sharad kasta. Dhammaan midabbadu waxay isticmaalaan 5–60 ETB sadar kasta, wadartuna 40–480 ETB. Soo-noqosho kasta waxaa la bixiyaa kubbadda ugu dambaysa ka dib.',
      'المبالغ بزيادات 5 ETB، حتى 500 ETB إجمالًا لكل رهان. خيار كل الألوان يستخدم 5–60 ETB لكل سطر، بإجمالي 40–480 ETB. تُسوّى جميع العوائد بعد الكرة الأخيرة.',
      'Kiasi huongezeka kwa 5 ETB hadi jumla ya 500 ETB kwa dau. Rangi zote hutumia 5–60 ETB kwa mstari, jumla 40–480 ETB. Kila marejesho hulipwa baada ya mpira wa mwisho.',
      'Les montants progressent par 5 ETB, jusqu’à 500 ETB par mise. Toutes les couleurs utilise 5–60 ETB par ligne, soit 40–480 ETB au total. Chaque retour est réglé après la dernière boule.'
    ),
  'An accepted ticket locks its amount and target. Changing a draft or tapping a past result never places a ticket.':
    tr(
      'የተቀበለ ትኬት መጠኑን እና ዒላማውን ይቆልፋል። ረቂቅ መቀየር ወይም ያለፈ ውጤት መንካት ትኬት አያስገባም።',
      'Tikeetiin fudhatame maallaqaa fi galma isaa cufa. Wixinee jijjiiruun ykn buʼaa darbe tuquun tikeetii hin galchu.',
      'ዝተቐበለ ትኬት መጠኑን ዒላማኡን ይዕጾ። ረቂቕ ምቕያር ወይ ዝሓለፈ ውጽኢት ምጥዋቕ ትኬት ኣይምዝግብን።',
      'Tigidh la aqbalay qaddarkiisa iyo bartilmaameedkiisa waa la xiraa. Beddelidda qabyo ama taabashada natiijo hore tigidh ma geliso.',
      'تُثبّت التذكرة المقبولة مبلغها وهدفها. تعديل المسودة أو الضغط على نتيجة سابقة لا يضع تذكرة أبدًا.',
      'Tiketi iliyokubaliwa hufunga kiasi na lengo lake. Kubadilisha rasimu au kugusa matokeo ya zamani hakuweki tiketi.',
      'Un ticket accepté verrouille son montant et sa cible. Modifier un brouillon ou toucher un ancien résultat ne place jamais de ticket.'
    ),
  'Autoplay requires an auto cash-out target and runs for up to ten entries per panel. It stops on a hidden tab, refresh, connection loss or an error. Stopping autoplay does not cancel an accepted ticket.':
    tr(
      'አውቶፕሌይ ራስ-ሰር የጨዋታ መውጫ ዒላማ ይፈልጋል፣ በእያንዳንዱ ፓነል እስከ አስር ተሳትፎዎች ይሠራል። ትር ሲደበቅ፣ ገጽ ሲታደስ፣ ግንኙነት ሲቋረጥ ወይም ስህተት ሲከሰት ይቆማል። አውቶፕሌይን ማቆም የተቀበለ ትኬትን አይሰርዝም።',
      'Taphi ofumaan galma ofumaan tapha keessaa baʼuu barbaada; paanaalii tokkoof hanga hirmaannaa kudhan adeema. Caancalli dhokate, haaromsi, walqunnamtiin bade ykn dogoggorri yoo jiraate ni dhaabbata. Tapha ofumaan dhaabuun tikeetii fudhatame hin haqu.',
      'ርእሰ-ሰር ጸወታ ርእሰ-ሰር ዒላማ ምውጻእ ካብ ጸወታ ይደሊ፤ ኣብ ነፍሲ ወከፍ ፓነል ክሳብ ዓሰርተ ተሳትፎታት ይሰርሕ። ትር ምስ ተሓብአ፣ ገጽ ምስ ተሓደሰ፣ ርክብ ምስ ተቛረጸ ወይ ጌጋ ምስ ኣጋጠመ ይቖም። ምቁራጹ ዝተቐበለ ትኬት ኣይስርዝን።',
      'Ciyaarista tooska ahi waxay u baahan tahay bartilmaameed bixitaan toos ah, waxayna guddi kasta socotaa ilaa toban ka-qaybgal. Way joogsataa marka tabku qarsoomo, bogga la cusboonaysiiyo, xiriirku lumo ama cilad timaaddo. Joojinteedu ma tirtirto tigidh la aqbalay.',
      'يتطلب اللعب التلقائي هدف خروج تلقائي ويعمل حتى عشر مشاركات لكل لوحة. يتوقف عند إخفاء التبويب أو تحديث الصفحة أو فقد الاتصال أو حدوث خطأ. إيقافه لا يلغي تذكرة مقبولة.',
      'Uchezaji otomatiki unahitaji lengo la kutoka kiotomatiki na huendelea hadi ushiriki kumi kwa kila paneli. Husimama kichupo kikifichwa, ukurasa ukisasishwa, muunganisho ukipotea au hitilafu ikitokea. Kuisimamisha hakufuti tiketi iliyokubaliwa.',
      'Le jeu automatique exige une cible d’encaissement automatique et effectue jusqu’à dix participations par panneau. Il s’arrête si l’onglet est masqué, après actualisation, perte de connexion ou erreur. L’arrêter n’annule pas un ticket accepté.'
    ),
  'Bet {slot} · Up to {maxTickets} tickets per round · Each ticket is confirmed separately': tr(
    'ውርርድ {slot} · በዙር እስከ {maxTickets} ትኬቶች · እያንዳንዱ ትኬት ለየብቻ ይረጋገጣል',
    'Buusii {slot} · Marsaa tokkoof hanga tikeetii {maxTickets} · Tikeetiin hundi addaan mirkanaaʼa',
    'ውርርድ {slot} · ኣብ ሓደ ዙር ክሳብ {maxTickets} ትኬታት · ነፍሲ ወከፍ ትኬት በበይኑ ይረጋገጽ',
    'Sharad {slot} · Ilaa {maxTickets} tigidh wareeg kasta · Tigidh kasta goonidiisa ayaa loo xaqiijiyaa',
    'الرهان {slot} · حتى {maxTickets} تذكرة لكل جولة · تُؤكّد كل تذكرة على حدة',
    'Dau {slot} · Hadi tiketi {maxTickets} kwa raundi · Kila tiketi inathibitishwa kando',
    'Mise {slot} · Jusqu’à {maxTickets} tickets par manche · Chaque ticket est confirmé séparément'
  ),
  'Browser storage is unavailable. This practice session will reset if you refresh.': tr(
    'የአሳሽ ማከማቻ አይገኝም። ገጹን ካደሱ ይህ የልምምድ ክፍለ ጊዜ እንደገና ይጀምራል።',
    'Kuusaan biraawzaraa hin argamu. Yoo haaromsite shaakalli kun jalqabatti deebiʼa.',
    'መኽዘን መርበብ ኣይርከብን። ገጽ እንተሓዲስካ እዚ ክፍለግዜ ልምምድ ካብ መጀመርታ ይጅምር።',
    'Kaydka biraawsarka lama heli karo. Fadhigan tababarka ah dib ayuu u bilaabmayaa haddii aad cusboonaysiiso.',
    'تخزين المتصفح غير متاح. ستُعاد جلسة التدريب من البداية إذا حدّثت الصفحة.',
    'Hifadhi ya kivinjari haipatikani. Kipindi hiki cha mazoezi kitaanza upya ukisasisha ukurasa.',
    'Le stockage du navigateur est indisponible. Cette session d’entraînement sera réinitialisée si vous actualisez.'
  ),
  'Cannot load game availability. New wagers are disabled.': tr(
    'የጨዋታ ተገኝነትን መጫን አልተቻለም። አዲስ ውርርዶች ተሰናክለዋል።',
    'Argamuu taphaa feʼuun hin dandaʼamne. Buusii haaraan dhaabbateera.',
    'ርኽበት ጸወታ ምጽዓን ኣይተኻእለን። ሓደስቲ ውርርዳት ተዓጊቶም።',
    'Helitaanka ciyaarta lama soo dejin karo. Sharadyo cusub waa la joojiyay.',
    'تعذر تحميل توفر اللعبة. الرهانات الجديدة معطلة.',
    'Imeshindikana kupakia upatikanaji wa mchezo. Dau mpya zimezimwa.',
    'Impossible de charger la disponibilité du jeu. Les nouvelles mises sont désactivées.'
  ),
  'Cannot load your balance. New wagers are disabled.': tr(
    'ቀሪ ሂሳብዎን መጫን አልተቻለም። አዲስ ውርርዶች ተሰናክለዋል።',
    'Haftee kee feʼuun hin dandaʼamne. Buusii haaraan dhaabbateera.',
    'ሒሳብካ ምጽዓን ኣይተኻእለን። ሓደስቲ ውርርዳት ተዓጊቶም።',
    'Haraagaaga lama soo dejin karo. Sharadyo cusub waa la joojiyay.',
    'تعذر تحميل رصيدك. الرهانات الجديدة معطلة.',
    'Imeshindikana kupakia salio lako. Dau mpya zimezimwa.',
    'Impossible de charger votre solde. Les nouvelles mises sont désactivées.'
  ),
  'Cash out during the rise, or set an automatic target before the round starts.': tr(
    'በመጨመር ላይ እያለ ከጨዋታው ይውጡ፣ ወይም ዙሩ ከመጀመሩ በፊት ራስ-ሰር ዒላማ ያዘጋጁ።',
    'Yeroo olkaʼaa jiru tapha keessaa baʼi, ykn marsaan jalqabuu dura galma ofumaan kaaʼi.',
    'ኣብ ምውሳኽ ከሎ ካብ ጸወታ ውጻእ፣ ወይ ዙር ቅድሚ ምጅማሩ ርእሰ-ሰር ዒላማ ኣዳሉ።',
    'Ka bax inta uu korayo, ama dhig bartilmaameed toos ah ka hor inta wareeggu bilaaban.',
    'اخرج أثناء الارتفاع، أو حدّد هدفًا تلقائيًا قبل بدء الجولة.',
    'Toka wakati kinapanda, au weka lengo la kiotomatiki kabla ya raundi kuanza.',
    'Encaissez pendant la montée ou fixez une cible automatique avant le début de la manche.'
  ),
  'Casino practice is not available for this account.': tr(
    'የካሲኖ ልምምድ ለዚህ መለያ አይገኝም።',
    'Shaakalli kaasinoo herrega kanaaf hin argamu.',
    'ልምምድ ካዚኖ ነዚ መለያ ኣይርከብን።',
    'Tababarka kasiinada koontadan uma furna.',
    'تدريب الكازينو غير متاح لهذا الحساب.',
    'Mazoezi ya kasino hayapatikani kwa akaunti hii.',
    'L’entraînement au casino n’est pas disponible pour ce compte.'
  ),
  'Casino practice is temporarily paused. Please try again later.': tr(
    'የካሲኖ ልምምድ ለጊዜው ቆሟል። እባክዎ ቆይተው ይሞክሩ።',
    'Shaakalli kaasinoo yeroo muraasaaf dhaabbateera. Booda irra deebiʼii yaali.',
    'ልምምድ ካዚኖ ንግዚኡ ተቛሪጹ። ጸኒሕካ ደጊምካ ፈትን።',
    'Tababarka kasiinada si ku-meel-gaar ah ayuu u joogsaday. Fadlan mar dambe isku day.',
    'تدريب الكازينو متوقف مؤقتًا. يرجى المحاولة لاحقًا.',
    'Mazoezi ya kasino yamesitishwa kwa muda. Tafadhali jaribu tena baadaye.',
    'L’entraînement au casino est temporairement suspendu. Réessayez plus tard.'
  ),
};
export default catalogue;
