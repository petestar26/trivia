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
  'The server saves one roll. Refreshing never starts a new round.': tr(
    'አገልጋዩ አንድ የዳይስ ውጤት ያስቀምጣል። ገጹን ማደስ አዲስ ዙር አያስጀምርም።',
    'Sarvariin darbannaa tokko olkaaʼa. Haaromsuun marsaa haaraa hin jalqabsiisu.',
    'ኣገልጋሊ ሓደ ውጽኢት ዳይስ ይዕቅብ። ምሕዳስ ሓድሽ ዙር ኣየጀምርን።',
    'Seerfarku hal rogis ayuu kaydiyaa. Cusboonaysiintu wareeg cusub ma bilowdo.',
    'يحفظ الخادم رمية واحدة. تحديث الصفحة لا يبدأ جولة جديدة أبدًا.',
    'Seva huhifadhi mrusho mmoja. Kusasisha hakuanzi raundi mpya.',
    'Le serveur enregistre un lancer. Actualiser ne commence jamais une nouvelle manche.'
  ),
  'The stage or price changed. Close this review and select a current price.': tr(
    'ደረጃው ወይም ዋጋው ተቀይሯል። ይህን ግምገማ ይዝጉ እና የአሁኑን ዋጋ ይምረጡ።',
    'Sadarkaan ykn gatiin jijjiirameera. Ilaalcha kana cufii gatii ammaa filadhu.',
    'ደረጃ ወይ ዋጋ ተቐይሩ። ነዚ ግምገማ ዕጾ፣ ናይ ሕጂ ዋጋ ምረጽ።',
    'Marxaladda ama qiimuhu way is beddeleen. Xir dib-u-eegistan oo dooro qiimaha hadda.',
    'تغيّرت المرحلة أو السعر. أغلق هذه المراجعة واختر سعرًا حاليًا.',
    'Hatua au bei imebadilika. Funga ukaguzi huu na uchague bei ya sasa.',
    'L’étape ou la cote a changé. Fermez cette vérification et sélectionnez une cote actuelle.'
  ),
  'The target gross return for a fixed auto cash-out is approximately 90%, before whole-credit rounding. It is a long-run mathematical expectation, not a promise for a session. Manual timing and rounding affect returns. There is no additional practice fee or PVP mode.':
    tr(
      'ለቋሚ ራስ-ሰር መውጫ የታለመው ጠቅላላ ተመላሽ ወደ ሙሉ ክሬዲት ከማጠጋጋት በፊት ወደ 90% ነው። ይህ የረጅም ጊዜ ሒሳባዊ ግምት እንጂ ለአንድ ክፍለ ጊዜ ቃል ኪዳን አይደለም። በእጅ የመውጫ ጊዜ እና ማጠጋጋት ተመላሾችን ይነካሉ። ተጨማሪ የልምምድ ክፍያ ወይም PVP ሁነታ የለም።',
      'Deebiin waliigalaa galmeeffame baʼuu ofumaan dhaabbataaf naannoo 90%, qabxii guutuutti naanneffamuu dura. Kun eegumsa herregaa yeroo dheeraa, waadaa yeroo taphaa tokkoo miti. Yeroo harkaan baʼuu fi naanneffamuun deebii irratti dhiibbaa qabu. Kaffaltii shaakalaa dabalataa ykn haala PVP hin qabu.',
      'ንቐዋሚ ርእሰ-ሰር ምውጻእ ዝተዓለመ ጠቕላላ ተመላሲ ናብ ምሉእ ክሬዲት ቅድሚ ምጥግጋዕ ኣስታት 90% እዩ። ናይ ነዊሕ ግዜ ሒሳባዊ ትጽቢት እዩ፣ ንሓደ ክፍለግዜ ቃል ኪዳን ኣይኮነን። ብኢድ ዝምረጽ ግዜን ምጥግጋዕን ንተመላሲ ይጸልዉ። ተወሳኺ ክፍሊት ልምምድ ወይ ሁነታ PVP የለን።',
      'Soo-noqoshada guud ee bartilmaameedka bixitaanka tooska ah ee goʼan waa qiyaastii 90%, ka hor soo-koobidda dhibco dhan. Waa filasho xisaabeed oo muddada dheer ah, ma aha ballanqaad hal fadhi. Waqtiga gacanta iyo soo-koobiddu waxay saameeyaan soo-noqoshada. Ma jiro khidmad tababar oo dheeraad ah ama qaab PVP.',
      'العائد الإجمالي المستهدف للخروج التلقائي الثابت نحو 90% قبل التقريب إلى أرصدة صحيحة. هو توقع رياضي طويل المدى، لا وعد لجلسة واحدة. يؤثر التوقيت اليدوي والتقريب في العوائد. لا رسوم تدريب إضافية أو وضع PVP.',
      'Marejesho ya jumla yanayolengwa kwa kutoka kiotomatiki katika lengo thabiti ni takriban 90% kabla ya kuzungusha kuwa vitengo kamili. Ni matarajio ya kihesabu ya muda mrefu, si ahadi ya kipindi kimoja. Muda wa kutoka mwenyewe na kuzungusha huathiri marejesho. Hakuna ada ya ziada ya mazoezi au hali ya PVP.',
      'Le retour brut visé pour une cible automatique fixe est d’environ 90 %, avant arrondi aux crédits entiers. C’est une espérance mathématique à long terme, pas une promesse par session. Le timing manuel et les arrondis influencent les retours. Aucun frais d’entraînement supplémentaire ni mode PVP.'
    ),
  'The target is selected by the server’s cryptographic random generator after the entry window closes. If the server is delayed, results remain pending until confirmed. This is not a precommitted, independently verifiable draw. The animation only presents the saved result. Retrying a saved guess returns that same result. Scores are for this game only and have no cash value.':
    tr(
      'ዒላማው የተሳትፎ ጊዜ ከተዘጋ በኋላ በአገልጋዩ ክሪፕቶግራፊያዊ ዘፈቀዳዊ ጀነሬተር ይመረጣል። አገልጋዩ ከዘገየ ውጤቶች እስኪረጋገጡ ድረስ ይጠብቃሉ። ይህ ቀድሞ ቃል የተገባበት፣ በገለልተኛ ሁኔታ ሊረጋገጥ የሚችል ዕጣ አይደለም። እንቅስቃሴው የተቀመጠውን ውጤት ብቻ ያቀርባል። የተቀመጠ ግምት እንደገና መሞከር ያንኑ ውጤት ይመልሳል። ነጥቦች ለዚህ ጨዋታ ብቻ ናቸው፣ የገንዘብ ዋጋም የላቸውም።',
      'Galmi hirmaannaan cufamee booda uumamaa carraa kiriptoogiraafii sarvaraatiin filatama. Sarvariin yoo harkifate buʼaan hanga mirkanaaʼutti eega. Kun carraa dursee waadaa galame kan walabaan mirkanaaʼu miti. Sochiin buʼaa olkaaʼame qofa agarsiisa. Tilmaama olkaaʼame irra deebiʼuun buʼaa isuma deebisa. Qabxiin tapha kanaaf qofa, gatii maallaqaa hin qabu.',
      'ዒላማ መስኮት ተሳትፎ ድሕሪ ምዕጻዉ ብክሪፕቶግራፊያዊ ዘፈቀዳዊ መፍረዪ ኣገልጋሊ ይምረጽ። ኣገልጋሊ እንተደንጒዩ ውጽኢታት ክሳብ ዝረጋገጹ ይጽበዩ። እዚ ኣቐዲሙ ዝተወፈየ፣ ብናጻ ክረጋገጽ ዝኽእል ዕጣ ኣይኮነን። እንቅስቓሴ ዝተዓቀበ ውጽኢት ጥራይ የቕርብ። ዝተዓቀበ ግምት ዳግም ምፍታን ተመሳሳሊ ውጽኢት ይመልስ። ነጥብታት ነዚ ጸወታ ጥራይ እዮም፣ ዋጋ ገንዘብ የብሎምን።',
      'Bartilmaameedka waxaa doorta soo-saaraha nasiibka ee sirta amniga ee seerfarka ka dib xidhitaanka gelitaanka. Haddii seerfarku dib u dhaco, natiijooyinku way sugayaan ilaa la xaqiijiyo. Kani ma aha isku-aad horay loo goʼaamiyay oo si madax-bannaan loo xaqiijin karo. Dhaqdhaqaaqu wuxuu soo bandhigaa natiijada kaydsan oo keliya. Dib-u-tijaabinta qiyaas kaydsan waxay soo celisaa isla natiijadii. Dhibcuhu ciyaartan keliya ayay u yihiin qiime lacag ahna ma laha.',
      'يختار مولّد الخادم العشوائي المشفّر الهدف بعد إغلاق المشاركة. عند تأخر الخادم تبقى النتائج معلّقة حتى التأكيد. هذا ليس سحبًا ذا التزام مسبق يمكن التحقق منه مستقلًا. الحركة تعرض النتيجة المحفوظة فقط. إعادة محاولة تخمين محفوظ تعيد النتيجة نفسها. النقاط لهذه اللعبة فقط وبلا قيمة نقدية.',
      'Lengo huchaguliwa na jenereta ya nasibu ya kriptografia ya seva baada ya ushiriki kufungwa. Seva ikichelewa, matokeo husubiri uthibitisho. Hii si droo iliyoahidiwa mapema inayoweza kuthibitishwa kwa kujitegemea. Uhuishaji huonyesha matokeo yaliyohifadhiwa pekee. Kujaribu tena makisio yaliyohifadhiwa hurudisha matokeo yale yale. Alama ni za mchezo huu tu na hazina thamani ya pesa.',
      'La cible est choisie par le générateur aléatoire cryptographique du serveur après fermeture des participations. En cas de retard, les résultats restent en attente de confirmation. Ce tirage n’est pas préengagé ni vérifiable indépendamment. L’animation présente seulement le résultat enregistré. Réessayer une estimation enregistrée renvoie ce même résultat. Les scores ne valent que pour ce jeu, sans valeur monétaire.'
    ),
  'The terms and receipt hash agree. The seed and beacon are not yet revealed.': tr(
    'ውሎቹ እና የደረሰኙ ሃሽ ተዛምደዋል። መነሻ እሴቱ እና ዘፈቀዳዊ ምልክቱ ገና አልተገለጡም።',
    'Haalawwan fi haashiin nagahee wal simu. Sanyii fi mallattoon carraa ammallee hin mulʼanne.',
    'ውዕላትን ሃሽ ቅብሊትን ይዛመዱ። መበገሲ ክብርን ዘፈቀዳዊ ምልክትን ገና ኣይተገልጹን።',
    'Shuruudaha iyo hash-ka rasiidku way is waafaqaan. Abuurka iyo calaamadda nasiibka weli lama muujin.',
    'الشروط وتجزئة الإيصال متطابقة. لم تُكشف البذرة والمنارة بعد.',
    'Masharti na hashi ya risiti vinalingana. Mbegu na ishara bado hazijafichuliwa.',
    'Les conditions et le hachage du reçu concordent. La graine et la balise ne sont pas encore révélées.'
  ),
  'There are 36 equally likely pairs of dice; 21 have a total of 7 or higher. Each 35 ETB stake returns 54 on a win and zero otherwise. (21 ÷ 36) × (54 ÷ 35) = 90% theoretical gross return over repeated play. The 10% expected edge is built into the return, with no additional ticket fee.':
    tr(
      '36 እኩል ዕድል ያላቸው የዳይስ ጥንዶች አሉ፤ 21 ድምራቸው 7 ወይም ከዚያ በላይ ነው። እያንዳንዱ 35 ETB ውርርድ ሲያሸንፍ 54፣ ካልሆነ ዜሮ ይመልሳል። (21 ÷ 36) × (54 ÷ 35) = 90% ንድፈ ሐሳባዊ ጠቅላላ ተመላሽ በተደጋጋሚ ጨዋታ። የሚጠበቀው 10% ብልጫ በተመላሹ ውስጥ አለ፣ ተጨማሪ የትኬት ክፍያ የለም።',
      'Cimdi daayisii carraa walqixa qabu 36 jira; 21 idaʼama 7 ykn isaa olii qabu. Buusiin 35 ETB hundi yoo moʼate 54, yoo hin taane zeeroo deebisa. (21 ÷ 36) × (54 ÷ 35) = deebii waliigalaa tiyoorii 90% tapha irra deddeebiʼamu irratti. Caalmaan eegamu 10% deebii keessatti hammatame, kaffaltiin tikeetii dabalataa hin jiru.',
      '36 ማዕረ ዕድል ዘለዎም ጽምዲ ዳይስ ኣለዉ፤ 21 ድምሮም 7 ወይ ልዕሊኡ እዩ። ነፍሲ ወከፍ 35 ETB ውርርድ እንተተዓዊቱ 54፣ እንተዘይኮይኑ ዜሮ ይመልስ። (21 ÷ 36) × (54 ÷ 35) = 90% ቲዮራዊ ጠቕላላ ተመላሲ ኣብ ተደጋጋሚ ጸወታ። ዝትጽበ 10% ብልጫ ኣብ ተመላሲ ተሓዊሱ፣ ተወሳኺ ክፍሊት ትኬት የለን።',
      'Waxaa jira 36 lammaane laadhuu oo fursad isku mid ah leh; 21 waxay leeyihiin wadar 7 ama ka badan. Sharad kasta 35 ETB wuxuu soo celiyaa 54 haddii uu guuleysto, haddii kale eber. (21 ÷ 36) × (54 ÷ 35) = 90% soo-noqosho guud aragtiyeed marka marar badan la ciyaaro. Faaʼiidada la filayo 10% waxay ku dhex jirtaa soo-noqoshada, khidmad tigidh oo dheeraad ahna ma jirto.',
      'هناك 36 زوج نرد متساوي الاحتمال؛ 21 منها مجموعها 7 أو أكثر. كل رهان 35 ETB يعيد 54 عند الفوز وصفرًا خلاف ذلك. (21 ÷ 36) × (54 ÷ 35) = عائد إجمالي نظري 90% عبر اللعب المتكرر. الأفضلية المتوقعة 10% مدمجة في العائد، دون رسم تذكرة إضافي.',
      'Kuna jozi 36 za kete zenye nafasi sawa; 21 zina jumla ya 7 au zaidi. Kila dau la 35 ETB hurudisha 54 likishinda, vinginevyo sifuri. (21 ÷ 36) × (54 ÷ 35) = marejesho ya jumla ya kinadharia 90% kwa kucheza mara nyingi. Faida inayotarajiwa 10% imo katika marejesho, bila ada ya ziada ya tiketi.',
      'Il existe 36 paires de dés équiprobables ; 21 totalisent 7 ou plus. Chaque mise de 35 ETB rapporte 54 en cas de victoire, sinon zéro. (21 ÷ 36) × (54 ÷ 35) = 90 % de retour brut théorique sur des jeux répétés. L’avantage attendu de 10 % est intégré au retour, sans frais de ticket supplémentaires.'
    ),
  'These rules have been updated. Refresh the page to continue. No new ticket can be confirmed until you do.':
    tr(
      'እነዚህ ደንቦች ተዘምነዋል። ለመቀጠል ገጹን ያድሱ። እስከዚያ ድረስ አዲስ ትኬት ማረጋገጥ አይቻልም።',
      'Seerotni kun haaromfamanii jiru. Itti fufuuf fuula haaromsi. Hanga sanaatti tikeetii haaraa mirkaneessuun hin dandaʼamu.',
      'እዞም ሕግታት ተሓዲሶም። ንምቕጻል ገጽ ኣሐድስ። ክሳብኡ ሓድሽ ትኬት ምርግጋጽ ኣይከኣልን።',
      'Xeerarkan waa la cusboonaysiiyay. Cusboonaysii bogga si aad u sii waddo. Tigidh cusub lama xaqiijin karo ilaa aad sidaas samayso.',
      'تم تحديث هذه القواعد. حدّث الصفحة للمتابعة. لا يمكن تأكيد تذكرة جديدة حتى تفعل ذلك.',
      'Kanuni hizi zimesasishwa. Sasisha ukurasa kuendelea. Hakuna tiketi mpya inayoweza kuthibitishwa hadi ufanye hivyo.',
      'Ces règles ont été actualisées. Actualisez la page pour continuer. Aucun nouveau ticket ne peut être confirmé avant cela.'
    ),
  'This Keno table is currently unavailable. Please return to the casino.': tr(
    'ይህ የኬኖ ጠረጴዛ በአሁኑ ጊዜ አይገኝም። እባክዎ ወደ ካሲኖ ይመለሱ።',
    'Minjaalli Keno kun amma hin argamu. Gara kaasinootti deebiʼi.',
    'እዚ ጠረጴዛ ኬኖ ኣብዚ ሕጂ ኣይርከብን። ናብ ካዚኖ ተመለስ።',
    'Miiskan Keno hadda lama heli karo. Fadlan ku noqo kasiinada.',
    'طاولة كينو هذه غير متاحة حاليًا. يرجى العودة إلى الكازينو.',
    'Meza hii ya Keno haipatikani sasa. Tafadhali rudi kwenye kasino.',
    'Cette table Keno est actuellement indisponible. Retournez au casino.'
  ),
  'This game is being prepared. Explore our available games while you wait.': tr(
    'ይህ ጨዋታ እየተዘጋጀ ነው። እስኪጠብቁ ድረስ ያሉንን ጨዋታዎች ያስሱ።',
    'Taphi kun qophaaʼaa jira. Yeroo eegdu taphoota jiran ilaali.',
    'እዚ ጸወታ ይዳሎ ኣሎ። እናተጸበኻ ዘለዉና ጸወታታት ዳህስስ።',
    'Ciyaartan waa la diyaarinayaa. Sahami ciyaaraha diyaar ah inta aad sugayso.',
    'هذه اللعبة قيد التحضير. استكشف الألعاب المتاحة أثناء الانتظار.',
    'Mchezo huu unaandaliwa. Gundua michezo iliyopo unaposubiri.',
    'Ce jeu est en préparation. Explorez nos jeux disponibles en attendant.'
  ),
  'This is Salem’s original practice game. No deposits, cash prizes, insurance, splits, double-downs, or automatic repeat bets.':
    tr(
      'ይህ የሳሌም ኦሪጅናል የልምምድ ጨዋታ ነው። ተቀማጭ፣ የገንዘብ ሽልማት፣ ኢንሹራንስ፣ እጅ መክፈል፣ ውርርድ ማጠፍ ወይም ራስ-ሰር ተደጋጋሚ ውርርድ የለም።',
      'Kun tapha shaakalaa Salem jalqabaa dha. Maallaqa galchuu, badhaasa maallaqaa, inshuraansii, harka qooduu, buusii dachaan dabalu ykn buusii ofumaan deebiʼu hin qabu.',
      'እዚ ኦሪጅናል ጸወታ ልምምድ ሳሌም እዩ። ተቐማጢ፣ ሽልማት ገንዘብ፣ መድሕን፣ ኢድ ምክፋል፣ ውርርድ ዕጽፊ ምግባር ወይ ርእሰ-ሰር ተደጋጋሚ ውርርድ የለን።',
      'Tani waa ciyaarta tababarka asalka ah ee Salem. Ma jiraan dhigaallo, abaalmarin lacag ah, caymis, kala-qaybin gacanta, laba-jibbaar sharad ama sharad is-celiya.',
      'هذه لعبة تدريب أصلية من سالم. لا إيداعات أو جوائز نقدية أو تأمين أو تقسيم أيدٍ أو مضاعفة رهان أو تكرار تلقائي.',
      'Huu ni mchezo asili wa mazoezi wa Salem. Hakuna amana, zawadi za pesa, bima, kugawa mikono, kuongeza dau mara mbili au kurudia dau kiotomatiki.',
      'Jeu d’entraînement original de Salem. Aucun dépôt, prix en argent, assurance, partage de main, doublement ou répétition automatique des mises.'
    ),
  'This local practice session resumes after a refresh in this tab. Shared server draws and cash play are not available here.':
    tr(
      'ይህ በመሣሪያዎ ላይ ያለ የልምምድ ክፍለ ጊዜ በዚህ ትር ገጹን ካደሱ በኋላ ይቀጥላል። የጋራ የአገልጋይ ዕጣዎች እና በገንዘብ መጫወት እዚህ የሉም።',
      'Shaakalli meeshaa kanaa caancala kana keessatti haaromsa booda itti fufa. Carraan sarvaraa waliinii fi taphi maallaqaa asitti hin argaman.',
      'እዚ ኣብ መሳርሒኻ ዘሎ ክፍለግዜ ልምምድ ኣብዚ ትር ድሕሪ ምሕዳስ ይቕጽል። ሓባራዊ ዕጣታት ኣገልጋሊን ጸወታ ገንዘብን ኣብዚ የለዉን።',
      'Fadhigan tababarka qalabka wuxuu sii socdaa marka tabkan la cusboonaysiiyo. Isku-aadyada seerfarka la wadaago iyo ciyaar lacag dhab ah halkan kama jiraan.',
      'تُستأنف جلسة التدريب المحلية بعد تحديث هذا التبويب. لا سحوبات خادم مشتركة أو لعب نقدي هنا.',
      'Kipindi hiki cha mazoezi kwenye kifaa huendelea baada ya kusasisha kichupo hiki. Droo za pamoja za seva na mchezo wa fedha hazipatikani hapa.',
      'Cette session d’entraînement locale reprend après actualisation dans cet onglet. Les tirages partagés sur serveur et le jeu en argent ne sont pas disponibles ici.'
    ),
  'This round has left recent history. Close this view and select another result.': tr(
    'ይህ ዙር ከቅርብ ታሪክ ወጥቷል። ይህን እይታ ይዝጉ እና ሌላ ውጤት ይምረጡ።',
    'Marsaan kun seenaa dhihoo keessaa baʼeera. Ilaalcha kana cufii buʼaa biraa filadhu.',
    'እዚ ዙር ካብ ናይ ቀረባ ታሪኽ ወጺኡ። ነዚ ምርኢት ዕጾ፣ ካልእ ውጽኢት ምረጽ።',
    'Wareeggani wuxuu ka baxay taariikhda dhow. Xir muuqaalkan oo dooro natiijo kale.',
    'خرجت هذه الجولة من السجل الأخير. أغلق العرض واختر نتيجة أخرى.',
    'Raundi hii haipo tena kwenye historia ya karibuni. Funga mwonekano huu na uchague matokeo mengine.',
    'Cette manche n’est plus dans l’historique récent. Fermez cette vue et choisissez un autre résultat.'
  ),
  'This selection cannot be changed after confirmation.': tr(
    'ይህ ምርጫ ከማረጋገጫ በኋላ ሊቀየር አይችልም።',
    'Filannoon kun mirkaneessa booda hin jijjiiramu.',
    'እዚ ምርጫ ድሕሪ ምርግጋጽ ኣይቅየርን።',
    'Doorashadan lama beddeli karo xaqiijinta ka dib.',
    'لا يمكن تعديل هذا الاختيار بعد التأكيد.',
    'Chaguo hili haliwezi kubadilishwa baada ya kuthibitishwa.',
    'Cette sélection ne peut pas être modifiée après confirmation.'
  ),
  'Two dice. One shared result. A new round every minute.': tr(
    'ሁለት ዳይሶች። አንድ የጋራ ውጤት። በየደቂቃው አዲስ ዙር።',
    'Daayisii lama. Buʼaa waliinii tokko. Daqiiqaa daqiiqaan marsaa haaraa.',
    'ክልተ ዳይስ። ሓደ ሓባራዊ ውጽኢት። ኣብ ነፍሲ ወከፍ ደቒቕ ሓድሽ ዙር።',
    'Laba laadhuu. Hal natiijo la wadaago. Wareeg cusub daqiiqad kasta.',
    'نردان. نتيجة مشتركة واحدة. جولة جديدة كل دقيقة.',
    'Kete mbili. Matokeo moja ya pamoja. Raundi mpya kila dakika.',
    'Deux dés. Un résultat partagé. Une nouvelle manche chaque minute.'
  ),
  'Type an amount and confirm. Tickets are never placed automatically.': tr(
    'መጠን ያስገቡ እና ያረጋግጡ። ትኬቶች በራስ-ሰር አይገቡም።',
    'Maallaqa barreessi, mirkaneessi. Tikeetiin ofumaan hin galfamu.',
    'መጠን ጽሓፍን ኣረጋግጽን። ትኬታት ብርእሶም ኣይምዝገቡን።',
    'Qor qaddar oo xaqiiji. Tigidhyo si toos ah looma geliyo.',
    'أدخل مبلغًا وأكّد. لا توضع التذاكر تلقائيًا أبدًا.',
    'Andika kiasi na uthibitishe. Tiketi haziwekwi kiotomatiki.',
    'Saisissez un montant et confirmez. Les tickets ne sont jamais placés automatiquement.'
  ),
  'Up to 10 entries using this amount and target. Start before confirming a ticket. Stops on error, disconnection, hidden tab or refresh. Confirmed tickets stay active.':
    tr(
      'በዚህ መጠን እና ዒላማ እስከ 10 ተሳትፎዎች። ትኬት ከማረጋገጥዎ በፊት ያስጀምሩ። ስህተት፣ ግንኙነት መቋረጥ፣ ትር መደበቅ ወይም ገጽ ማደስ ሲኖር ይቆማል። የተረጋገጡ ትኬቶች ንቁ ይቆያሉ።',
      'Maallaqaa fi galma kanaan hanga hirmaannaa 10. Tikeetii mirkaneessuu dura jalqabi. Dogoggora, walqunnamtii dhabuu, caancala dhokachuu ykn haaromsa irratti dhaabbata. Tikeetiin mirkanaaʼe hojii irra tura.',
      'በዚ መጠንን ዒላማን ክሳብ 10 ተሳትፎታት። ትኬት ቅድሚ ምርግጋጽካ ጀምር። ጌጋ፣ ምቁራጽ ርክብ፣ ምሕባእ ትር ወይ ምሕዳስ ምስ ኣጋጠመ ይቖም። ዝተረጋገጹ ትኬታት ንጡፋት ይጸንሑ።',
      'Ilaa 10 ka-qaybgal adigoo isticmaalaya qaddarkan iyo bartilmaameedkan. Bilow ka hor xaqiijinta tigidh. Wuxuu joogsadaa cilad, xiriir goʼa, tab qarsoon ama cusboonaysiin. Tigidhada la xaqiijiyay way sii firfircoon yihiin.',
      'حتى 10 مشاركات بهذا المبلغ والهدف. ابدأ قبل تأكيد التذكرة. يتوقف عند خطأ أو انقطاع أو إخفاء التبويب أو تحديثه. تبقى التذاكر المؤكدة نشطة.',
      'Hadi ushiriki 10 kwa kiasi na lengo hili. Anza kabla ya kuthibitisha tiketi. Husimama kwa hitilafu, kukatika, kichupo kufichwa au kusasishwa. Tiketi zilizothibitishwa hubaki hai.',
      'Jusqu’à 10 participations avec ce montant et cette cible. Démarrez avant de confirmer un ticket. Arrêt sur erreur, déconnexion, onglet masqué ou actualisation. Les tickets confirmés restent actifs.'
    ),
  'Up to two independent tickets per round. Each bet has its own cash-out and autoplay controls.':
    tr(
      'በዙር እስከ ሁለት ገለልተኛ ትኬቶች። እያንዳንዱ ውርርድ የራሱ የጨዋታ መውጫ እና የአውቶፕሌይ መቆጣጠሪያዎች አሉት።',
      'Marsaa tokkoof hanga tikeetii walaba lama. Buusiin hundi toʼannoo baʼuu fi tapha ofumaan mataa isaa qaba.',
      'ኣብ ዙር ክሳብ ክልተ ናጻ ትኬታት። ነፍሲ ወከፍ ውርርድ ናቱ መቆጻጸሪ ምውጻእን ርእሰ-ሰር ጸወታን ኣለዎ።',
      'Ilaa laba tigidh oo gooni ah wareeg kasta. Sharad kastaa wuxuu leeyahay xakamaynta bixitaanka iyo ciyaarista tooska ah ee u gaar ah.',
      'حتى تذكرتين مستقلتين لكل جولة. لكل رهان تحكمه الخاص بالخروج واللعب التلقائي.',
      'Hadi tiketi mbili tofauti kwa raundi. Kila dau lina vidhibiti vyake vya kutoka na uchezaji otomatiki.',
      'Jusqu’à deux tickets indépendants par manche. Chaque mise a ses commandes d’encaissement et de jeu automatique.'
    ),
  'Up to {maxTickets} independent bets per round. Use steps of 40 ETB, with at most 480 practice ETB per ticket. Each tap adds the entered amount to that selection. Confirmed bets cannot be changed.':
    tr(
      'በዙር እስከ {maxTickets} ገለልተኛ ውርርዶች። በ 40 ETB ደረጃዎች፣ በትኬት እስከ 480 የልምምድ ETB ይጠቀሙ። እያንዳንዱ መንካት ያስገቡትን መጠን በዚያ ምርጫ ላይ ይጨምራል። የተረጋገጡ ውርርዶች አይቀየሩም።',
      'Marsaa tokkoof hanga buusii walaba {maxTickets}. Tarkaanfii 40 ETB fayyadami, tikeetii tokkoof olʼaanaa 480 ETB shaakalaa. Tuqaan hundi maallaqa galchite filannoo sanatti dabala. Buusiin mirkanaaʼe hin jijjiiramu.',
      'ኣብ ዙር ክሳብ {maxTickets} ናጻ ውርርዳት። ብ 40 ETB ደረጃታት፣ ንትኬት ክሳብ 480 ETB ልምምድ ተጠቐም። ነፍሲ ወከፍ ምጥዋቕ ዘእተኻዮ መጠን ኣብቲ ምርጫ ይውስኽ። ዝተረጋገጹ ውርርዳት ኣይቅየሩን።',
      'Ilaa {maxTickets} sharad oo gooni ah wareeg kasta. Isticmaal tallaabooyin 40 ETB, ugu badnaan 480 ETB tababar tigidh kasta. Taabasho kastaa waxay qaddarka la geliyay ku dartaa doorashadaas. Sharadyo la xaqiijiyay lama beddeli karo.',
      'حتى {maxTickets} رهان مستقل لكل جولة. استخدم زيادات 40 ETB، بحد أقصى 480 ETB تدريبي لكل تذكرة. كل ضغطة تضيف المبلغ المدخل إلى الاختيار. لا يمكن تعديل الرهانات المؤكدة.',
      'Hadi dau {maxTickets} tofauti kwa raundi. Tumia hatua za 40 ETB, hadi 480 ETB ya mazoezi kwa tiketi. Kila mguso huongeza kiasi ulichoingiza kwenye chaguo hilo. Dau zilizothibitishwa hazibadilishwi.',
      'Jusqu’à {maxTickets} mises indépendantes par manche. Utilisez des paliers de 40 ETB, au maximum 480 ETB d’entraînement par ticket. Chaque pression ajoute le montant saisi à la sélection. Les mises confirmées sont non modifiables.'
    ),
  'Use steps of 5, within your practice balance and the 480-credit ticket limit.': tr(
    'በ 5 ደረጃዎች፣ በልምምድ ሂሳብዎ እና በ 480 ክሬዲት የትኬት ገደብ ውስጥ ይጠቀሙ።',
    'Tarkaanfii 5 fayyadami, haftee shaakala kee fi daangaa tikeetii qabxii 480 keessatti.',
    'ብ 5 ደረጃታት፣ ኣብ ውሽጢ ሒሳብ ልምምድካን ደረት ትኬት 480 ክሬዲትን ተጠቐም።',
    'Isticmaal tallaabooyin 5 ah, gudaha haraaga tababarkaaga iyo xadka 480 dhibcood ee tigidhka.',
    'استخدم زيادات 5 ضمن رصيدك التدريبي وحد التذكرة البالغ 480 رصيدًا.',
    'Tumia hatua za 5, ndani ya salio la mazoezi na kikomo cha tiketi cha vitengo 480.',
    'Utilisez des paliers de 5, dans la limite du solde d’entraînement et des 480 crédits par ticket.'
  ),
  'Watch the 45-second race. Winning returns include your stake and are credited automatically.':
    tr(
      'የ 45 ሰከንዱን ውድድር ይመልከቱ። አሸናፊ ተመላሾች ውርርድዎን ያካትታሉ፣ በራስ-ሰርም ወደ ሂሳብ ይገባሉ።',
      'Fiigicha sekondii 45 ilaali. Deebiin moʼannaa buusii kee dabalatee ofumaan herregatti gala.',
      'ናይ 45 ካልኢት ውድድር ርአ። ተዓወትቲ ተመላሲታት ውርርድካ ይሓውሱ፣ ብርእሶም ናብ ሒሳብ ይኣትዉ።',
      'Daawo tartanka 45 ilbiriqsi ah. Soo-noqoshada guushu sharadkaaga way ku jirtaa si toos ahna koontada ayaa loogu daraa.',
      'شاهد سباق 45 ثانية. تشمل العوائد الفائزة رهانك وتُضاف تلقائيًا إلى الرصيد.',
      'Tazama mbio za sekunde 45. Marejesho ya ushindi yanajumuisha dau lako na huongezwa kiotomatiki.',
      'Regardez la course de 45 secondes. Les retours gagnants incluent votre mise et sont crédités automatiquement.'
    ),
  'You can still confirm a previously submitted round below.': tr(
    'ከታች ቀድሞ ያስገቡትን ዙር አሁንም ማረጋገጥ ይችላሉ።',
    'Marsaa duraan galchite armaan gaditti ammallee mirkaneessuu dandeessa.',
    'ኣብ ታሕቲ ኣቐዲምካ ዘእተኻዮ ዙር ገና ከተረጋግጽ ትኽእል።',
    'Weli waxaad hoos ka xaqiijin kartaa wareeg hore loo gudbiyay.',
    'لا يزال بإمكانك تأكيد جولة أرسلتها سابقًا أدناه.',
    'Bado unaweza kuthibitisha raundi uliyowasilisha awali hapa chini.',
    'Vous pouvez encore confirmer ci-dessous une manche déjà envoyée.'
  ),
  'You did not enter this round. Choose a number in the next round.': tr(
    'በዚህ ዙር አልተሳተፉም። በቀጣዩ ዙር ቁጥር ይምረጡ።',
    'Marsaa kana keessatti hin hirmaanne. Marsaa itti aanu keessatti lakkoofsa filadhu.',
    'ኣብዚ ዙር ኣይተሳተፍካን። ኣብ ቀጻሊ ዙር ቁጽሪ ምረጽ።',
    'Wareeggan kama aadan qaybgelin. Wareegga xiga dooro lambar.',
    'لم تشارك في هذه الجولة. اختر رقمًا في الجولة التالية.',
    'Hukushiriki raundi hii. Chagua nambari kwenye raundi inayofuata.',
    'Vous n’avez pas participé à cette manche. Choisissez un numéro à la prochaine.'
  ),
  'You start with 1,000 separate practice ETB. Six-number lines have a theoretical gross return of about 92.18%; other markets have different returns. A round may return zero. Most color refunds every bet on that market when two or more colors tie for the lead.':
    tr(
      'በተለየ 1,000 የልምምድ ETB ይጀምራሉ። የስድስት ቁጥር መስመሮች ወደ 92.18% ንድፈ ሐሳባዊ ጠቅላላ ተመላሽ አላቸው፤ ሌሎች ገበያዎች የተለዩ ተመላሾች አላቸው። ዙር ዜሮ ሊመልስ ይችላል። ብዙ ቀለም ገበያ ሁለት ወይም ከዚያ በላይ ቀለሞች በመሪነት አቻ ሲሆኑ በዚያ ገበያ ያሉ ሁሉንም ውርርዶች ይመልሳል።',
      'ETB shaakalaa addaa 1,000 irraa jalqabda. Sararri lakkoofsa jaʼaa deebii waliigalaa tiyoorii naannoo 92.18% qaba; gabaan biroo deebii adda addaa qaba. Marsaan zeeroo deebisuu dandaʼa. Gabaan Halluu baayʼee yoo halluu lama ykn isaa ol dursa irratti walqixa taʼan buusii gabaa sanaa hunda deebisa.',
      'ብዝተፈለየ 1,000 ETB ልምምድ ትጅምር። መስመራት ሽዱሽተ ቁጽሪ ኣስታት 92.18% ቲዮራዊ ጠቕላላ ተመላሲ ኣለዎም፤ ካልኦት ዕዳጋታት ዝተፈላለዩ ተመላሲታት ኣለዎም። ዙር ዜሮ ክመልስ ይኽእል። ዝበዝሐ ሕብሪ ክልተ ወይ ልዕሊኡ ሕብርታት ኣብ መሪሕነት ማዕረ እንተኾይኖም ኩሉ ውርርድ እቲ ዕዳጋ ይመልስ።',
      'Waxaad ku bilaabaysaa 1,000 ETB tababar oo gaar ah. Sadarrada lixda lambar waxay leeyihiin soo-noqosho guud aragtiyeed qiyaastii 92.18%; suuqyada kale waxay leeyihiin soo-noqoshooyin kala duwan. Wareeggu eber wuu soo celin karaa. Suuqa Midabka ugu badan wuxuu soo celiyaa sharad kasta oo suuqaas ah haddii laba ama ka badan midab ay hoggaanka ku barbaroobaan.',
      'تبدأ بـ 1,000 ETB تدريبي منفصل. لأسطر الستة أرقام عائد إجمالي نظري نحو 92.18%؛ وللأسواق الأخرى عوائد مختلفة. قد تعيد الجولة صفرًا. سوق اللون الأكثر يعيد كل رهاناته إذا تعادل لونان أو أكثر في الصدارة.',
      'Unaanza na ETB 1,000 tofauti za mazoezi. Mistari ya nambari sita ina marejesho ya jumla ya kinadharia takriban 92.18%; masoko mengine yana marejesho tofauti. Raundi inaweza kurudisha sifuri. Soko la Rangi nyingi hurudisha kila dau lake rangi mbili au zaidi zikifungana kuongoza.',
      'Vous commencez avec 1 000 ETB d’entraînement distincts. Les lignes de six numéros ont un retour brut théorique d’environ 92,18 % ; les autres marchés ont des retours différents. Une manche peut rapporter zéro. Couleur majoritaire rembourse toutes les mises de ce marché si au moins deux couleurs sont à égalité en tête.'
    ),
  'Your confirmed results will appear here after your first guess.': tr(
    'ከመጀመሪያው ግምትዎ በኋላ የተረጋገጡ ውጤቶችዎ እዚህ ይታያሉ።',
    'Tilmaama kee jalqabaa booda buʼaan mirkanaaʼe asitti mulʼata.',
    'ድሕሪ ቀዳማይ ግምትካ ዝተረጋገጹ ውጽኢታትካ ኣብዚ ይርኣዩ።',
    'Natiijooyinkaaga la xaqiijiyay halkan ayay ka muuqdaan qiyaastaada koowaad ka dib.',
    'تظهر نتائجك المؤكدة هنا بعد تخمينك الأول.',
    'Matokeo yako yaliyothibitishwa yataonekana hapa baada ya makisio yako ya kwanza.',
    'Vos résultats confirmés apparaîtront ici après votre première estimation.'
  ),
  'Your number is locked. Result after entries close.': tr(
    'ቁጥርዎ ተቆልፏል። ውጤቱ ተሳትፎ ከተዘጋ በኋላ ነው።',
    'Lakkoofsi kee cufameera. Buʼaan hirmaannaan cufamee booda.',
    'ቁጽርኻ ተዓጽዩ። ውጽኢት ተሳትፎ ድሕሪ ምዕጻዉ።',
    'Lambarkaaga waa la xiray. Natiijadu waa marka gelitaanku xirmo ka dib.',
    'رقمك مثبت. النتيجة بعد إغلاق المشاركات.',
    'Nambari yako imefungwa. Matokeo baada ya ushiriki kufungwa.',
    'Votre numéro est verrouillé. Résultat après fermeture des participations.'
  ),
  'Your saved tickets and returns are restored after refresh.': tr(
    'የተቀመጡ ትኬቶችዎ እና ተመላሾችዎ ገጹን ካደሱ በኋላ ይመለሳሉ።',
    'Tikeetotaa fi deebiin kee olkaaʼaman haaromsa booda deebiʼu.',
    'ዝተዓቀቡ ትኬታትካን ተመላሲታትካን ድሕሪ ምሕዳስ ይምለሱ።',
    'Tigidhadaada iyo soo-noqoshada kaydsan waa la soo celiyaa cusboonaysiinta ka dib.',
    'تُستعاد تذاكرك وعوائدك المحفوظة بعد التحديث.',
    'Tiketi na marejesho yako yaliyohifadhiwa hurejeshwa baada ya kusasisha.',
    'Vos tickets et retours enregistrés sont restaurés après actualisation.'
  ),
  'Your ticket is live · auto cash-out stays active when you disconnect': tr(
    'ትኬትዎ ንቁ ነው · ግንኙነት ሲቋረጥ ራስ-ሰር መውጣት ንቁ ይቆያል',
    'Tikeetiin kee hojii irra jira · walqunnamtiin yoo cite baʼuun ofumaan hojii irra tura',
    'ትኬትካ ንጡፍ እዩ · ርክብ ምስ ተቛረጸ ርእሰ-ሰር ምውጻእ ንጡፍ ይጸንሕ',
    'Tigidhkaagu waa firfircoon yahay · bixitaanka tooska ahi wuu sii shaqeeyaa marka xiriirku goʼo',
    'تذكرتك نشطة · يبقى الخروج التلقائي فعالًا عند انقطاع اتصالك',
    'Tiketi yako iko hai · kutoka kiotomatiki hubaki hai unapokatika',
    'Votre ticket est actif · l’encaissement automatique reste actif après déconnexion'
  ),
  'Your ticket is live · manual cash-out requires a connection': tr(
    'ትኬትዎ ንቁ ነው · በእጅ ከጨዋታ መውጣት ግንኙነት ይፈልጋል',
    'Tikeetiin kee hojii irra jira · harkaan baʼuun walqunnamtii barbaada',
    'ትኬትካ ንጡፍ እዩ · ብኢድ ምውጻእ ርክብ ይደሊ',
    'Tigidhkaagu waa firfircoon yahay · bixitaanka gacantu wuxuu u baahan yahay xiriir',
    'تذكرتك نشطة · الخروج اليدوي يتطلب اتصالًا',
    'Tiketi yako iko hai · kutoka mwenyewe kunahitaji muunganisho',
    'Votre ticket est actif · l’encaissement manuel nécessite une connexion'
  ),
  'Your tickets from the latest 12 rounds, amounts in practice ETB': tr(
    'ከመጨረሻዎቹ 12 ዙሮች ትኬቶችዎ፣ መጠኖች በልምምድ ETB',
    'Tikeetota kee marsaa 12 dhumaa, maallaqa ETB shaakalaatiin',
    'ትኬታትካ ካብ መወዳእታ 12 ዙራት፣ መጠናት ብETB ልምምድ',
    'Tigidhadaada 12-kii wareeg ee u dambeeyay, qaddarro ETB tababar ah',
    'تذاكرك من آخر 12 جولة، المبالغ بـETB التدريبي',
    'Tiketi zako za raundi 12 za mwisho, kiasi kwa ETB ya mazoezi',
    'Vos tickets des 12 dernières manches, montants en ETB d’entraînement'
  ),
  '{stake} ETB · total successful return {value} ETB': tr(
    '{stake} ETB · ከተሳካ ጠቅላላ ተመላሽ {value} ETB',
    '{stake} ETB · deebii waliigalaa yoo milkaaʼe {value} ETB',
    '{stake} ETB · እንተተዓዊቱ ጠቕላላ ተመላሲ {value} ETB',
    '{stake} ETB · wadarta soo-noqoshada guusha {value} ETB',
    '{stake} ETB · إجمالي العائد عند النجاح {value} ETB',
    '{stake} ETB · jumla ya marejesho ukifanikiwa {value} ETB',
    '{stake} ETB · retour total si réussi {value} ETB'
  ),
  '{value} This does not independently establish publication time, funding or payment.': tr(
    '{value} ይህ በገለልተኛ ሁኔታ የህትመት ጊዜን፣ የገንዘብ ዝግጅትን ወይም ክፍያን አያረጋግጥም።',
    '{value} Kun yeroo maxxansaa, maallaqa qophaaʼe ykn kaffaltii walabaan hin mirkaneessu.',
    '{value} እዚ ግዜ ሕትመት፣ ምድላው ገንዘብ ወይ ክፍሊት ብናጻ ኣየረጋግጽን።',
    '{value} Tani si madax-bannaan uma caddayso waqtiga daabacaadda, maalgelinta ama lacag-bixinta.',
    '{value} هذا لا يثبت مستقلًا وقت النشر أو التمويل أو الدفع.',
    '{value} Hii haithibitishi kwa kujitegemea muda wa uchapishaji, ufadhili au malipo.',
    '{value} Cela n’établit pas indépendamment l’heure de publication, le financement ou le paiement.'
  ),
  '{value} per round · Confirm during the 15-second entry window.': tr(
    '{value} በዙር · በ 15 ሰከንድ የተሳትፎ ጊዜ ውስጥ ያረጋግጡ።',
    '{value} marsaa tokkoof · Yeroo hirmaannaa sekondii 15 keessatti mirkaneessi.',
    '{value} ንዙር · ኣብ 15 ካልኢት ግዜ ተሳትፎ ኣረጋግጽ።',
    '{value} wareeg kasta · Xaqiiji muddada 15 ilbiriqsi ee gelitaanka.',
    '{value} لكل جولة · أكّد خلال مهلة المشاركة البالغة 15 ثانية.',
    '{value} kwa raundi · Thibitisha ndani ya sekunde 15 za kujiunga.',
    '{value} par manche · Confirmez pendant les 15 secondes de participation.'
  ),
};
export default catalogue;
