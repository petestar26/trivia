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
  'Manual cash-out is accepted at server processing time, after locks are acquired. At or after the crash cutoff it loses. Displayed multipliers are estimates between updates; only a server-confirmed receipt is a return. A round can crash immediately at 1.00×. Cash-out is capped at 20.00×, with a terminal crash at 20.01×.':
    tr(
      'በእጅ ከጨዋታ መውጣት የሚቀበለው የውሂብ መቆለፊያዎች ከተያዙ በኋላ አገልጋዩ ባስኬደበት ጊዜ ነው። በመውደቂያ ገደብ ወይም ከዚያ በኋላ ይሸነፋል። የሚታዩ አባዦች በማደሻዎች መካከል ግምቶች ናቸው፤ በአገልጋዩ የተረጋገጠ ደረሰኝ ብቻ ተመላሽ ነው። ዙር በ 1.00× ወዲያውኑ ሊወድቅ ይችላል። መውጣት በ 20.00× ይገደባል፣ የመጨረሻ መውደቅም በ 20.01× ነው።',
      'Harkaan tapha keessaa baʼuun erga cufamni deetaa argamee booda yeroo sarvariin adeemsisutti fudhatama. Yeroo daangaa kufaatii ykn sana booda ni moʼama. Baayʼisaan mulʼatu haaromsa gidduutti tilmaama; nagaheen sarvariin mirkanaaʼe qofti deebii dha. Marsaan battalumatti 1.00× irratti kufuu dandaʼa. Baʼuun 20.00× irratti daangeffama, kufaatiin xumuraa 20.01× irratti.',
      'ብኢድ ካብ ጸወታ ምውጻእ መዕጸዊታት ሓበሬታ ድሕሪ ምሓዝ ኣገልጋሊ ኣብ ዘስርሓሉ ግዜ ይቕበል። ኣብ ደረት ምውዳቕ ወይ ድሕሪኡ ይስዓር። ዝርኣዩ ረቛሒታት ኣብ መንጎ ምሕዳሳት ግምታት እዮም፤ ብኣገልጋሊ ዝተረጋገጸ ቅብሊት ጥራይ ተመላሲ እዩ። ዙር ብቕጽበት ኣብ 1.00× ክወድቕ ይኽእል። ምውጻእ ኣብ 20.00× ይድረት፣ መወዳእታ ምውዳቕ ኣብ 20.01× እዩ።',
      'Bixitaanka gacanta waxaa la aqbalaa waqtiga seerfarku farsameeyo, ka dib marka qufulyada xogta la helo. Waqtiga dhicitaanka ama ka dib waa guuldarro. Isku-dhufashada muuqata waa qiyaaso inta u dhexaysa cusboonaysiinta; rasiid seerfarku xaqiijiyay keliya ayaa soo-noqosho ah. Wareeggu isla markiiba wuu ku dhici karaa 1.00×. Bixitaanku wuxuu ku xaddidan yahay 20.00×, dhicitaanka ugu dambaysana waa 20.01×.',
      'يُقبل الخروج اليدوي وقت معالجة الخادم، بعد الحصول على الأقفال. عند حد الانهيار أو بعده يخسر. المضاعفات المعروضة تقديرات بين التحديثات؛ الإيصال المؤكد من الخادم وحده يثبت العائد. قد تنهار الجولة فورًا عند 1.00×. الخروج محدود بـ 20.00×، والانهيار النهائي عند 20.01×.',
      'Kutoka mwenyewe hukubaliwa wakati seva inachakata, baada ya kupata kufuli za data. Katika muda wa kuanguka au baadaye hupoteza. Vizidishi vinavyoonekana ni makadirio kati ya masasisho; risiti iliyothibitishwa na seva pekee ndiyo marejesho. Raundi inaweza kuanguka mara moja katika 1.00×. Kutoka kuna kikomo cha 20.00×, na kuanguka kwa mwisho katika 20.01×.',
      'L’encaissement manuel est accepté à l’heure de traitement du serveur, après acquisition des verrous. À la limite du crash ou après, il perd. Les multiplicateurs affichés sont des estimations entre mises à jour ; seul un reçu confirmé par le serveur établit un retour. Une manche peut crasher immédiatement à 1,00×. L’encaissement est plafonné à 20,00×, avec un crash final à 20,01×.'
    ),
  'New rounds begin every five minutes. You have 3 minutes 30 seconds to place bets.': tr(
    'አዲስ ዙሮች በየአምስት ደቂቃው ይጀምራሉ። ውርርድ ለማስገባት 3 ደቂቃ 30 ሰከንድ አለዎት።',
    'Marsaan haaraan daqiiqaa shan shaniin jalqaba. Buusii galchuuf daqiiqaa 3 sekondii 30 qabda.',
    'ሓደስቲ ዙራት ኣብ ነፍሲ ወከፍ ሓሙሽተ ደቒቕ ይጅምሩ። ንውርርድ 3 ደቒቕ 30 ካልኢት ኣለካ።',
    'Wareegyo cusub waxay bilaabmaan shantii daqiiqaba. Waxaad haysataa 3 daqiiqo 30 ilbiriqsi oo aad sharad dhigato.',
    'تبدأ جولات جديدة كل خمس دقائق. لديك 3 دقائق و 30 ثانية لوضع الرهانات.',
    'Raundi mpya huanza kila dakika tano. Una dakika 3 sekunde 30 kuweka dau.',
    'De nouvelles manches commencent toutes les cinq minutes. Vous avez 3 minutes 30 secondes pour miser.'
  ),
  'No jackpots, automatic repeat bets, deposits or redeemable prizes.': tr(
    'ጃክፖት፣ ራስ-ሰር ተደጋጋሚ ውርርድ፣ ተቀማጭ ወይም ሊቀየሩ የሚችሉ ሽልማቶች የሉም።',
    'Jaakpootii, buusii ofumaan deebiʼu, maallaqa galchuu ykn badhaasa jijjiiramu hin qabu.',
    'ጃክፖት፣ ርእሰ-ሰር ተደጋጋሚ ውርርድ፣ ተቐማጢ ወይ ዝልወጥ ሽልማት የለን።',
    'Ma jiraan jaakbooto, sharad is-celiya, dhigaallo ama abaalmarin la sarifan karo.',
    'لا جوائز كبرى أو تكرار تلقائي للرهانات أو إيداعات أو جوائز قابلة للاستبدال.',
    'Hakuna jackpot, kurudia dau kiotomatiki, amana au zawadi zinazoweza kukombolewa.',
    'Aucun jackpot, répétition automatique des mises, dépôt ou prix échangeable.'
  ),
  'Official completed results and your confirmed practice bets.': tr(
    'የተረጋገጡ የተጠናቀቁ ውጤቶች እና የተረጋገጡ የልምምድ ውርርዶችዎ።',
    'Buʼaawwan xumuraman mirkanaaʼanii fi buusii shaakalaa kee mirkanaaʼan.',
    'ዝተረጋገጹ ዝተዛዘሙ ውጽኢታትን ዝተረጋገጹ ውርርዳት ልምምድካን።',
    'Natiijooyinka rasmiga ah ee dhammaaday iyo sharadyadaada tababar ee la xaqiijiyay.',
    'النتائج الرسمية المكتملة ورهاناتك التدريبية المؤكدة.',
    'Matokeo rasmi yaliyokamilika na dau zako za mazoezi zilizothibitishwa.',
    'Résultats officiels terminés et vos mises d’entraînement confirmées.'
  ),
  'One bet is awaiting confirmation. Retry checks the same receipt.': tr(
    'አንድ ውርርድ ማረጋገጫን እየጠበቀ ነው። ዳግም መሞከር ያንኑ ደረሰኝ ይፈትሻል።',
    'Buusiin tokko mirkaneessa eegaa jira. Irra deebiʼuun nagahee isuma ilaala.',
    'ሓደ ውርርድ ምርግጋጽ ይጽበ ኣሎ። ዳግም ምፍታን ነቲ ተመሳሳሊ ቅብሊት ይምርምር።',
    'Hal sharad ayaa sugaya xaqiijin. Dib-u-tijaabintu waxay hubisaa isla rasiidkii.',
    'رهان واحد بانتظار التأكيد. إعادة المحاولة تتحقق من الإيصال نفسه.',
    'Dau moja linasubiri uthibitisho. Kujaribu tena hukagua risiti ileile.',
    'Une mise attend confirmation. Réessayer vérifie le même reçu.'
  ),
  'One guess per round. The server confirms the closing time.': tr(
    'በዙር አንድ ግምት። የመዝጊያ ሰዓቱን አገልጋዩ ያረጋግጣል።',
    'Marsaa tokkoof tilmaama tokko. Yeroo cufiinsaa sarvariin mirkaneessa.',
    'ንሓደ ዙር ሓደ ግምት። ግዜ ምዕጻው ኣገልጋሊ የረጋግጽ።',
    'Hal qiyaas wareeg kasta. Seerfarku wuxuu xaqiijiyaa waqtiga xidhitaanka.',
    'تخمين واحد لكل جولة. يؤكد الخادم وقت الإغلاق.',
    'Makisio moja kwa raundi. Seva inathibitisha muda wa kufunga.',
    'Une estimation par manche. Le serveur confirme l’heure de fermeture.'
  ),
  'One-minute rounds · 30 seconds to choose · one shared target.': tr(
    'የአንድ ደቂቃ ዙሮች · ለመምረጥ 30 ሰከንዶች · አንድ የጋራ ዒላማ።',
    'Marsaa daqiiqaa tokko · filachuuf sekondii 30 · galma waliinii tokko.',
    'ናይ ሓደ ደቒቕ ዙራት · ንምምራጽ 30 ካልኢታት · ሓደ ሓባራዊ ዒላማ።',
    'Wareegyo hal daqiiqo ah · 30 ilbiriqsi oo doorasho · hal bartilmaameed la wadaago.',
    'جولات من دقيقة · 30 ثانية للاختيار · هدف مشترك واحد.',
    'Raundi za dakika moja · sekunde 30 za kuchagua · lengo moja la pamoja.',
    'Manches d’une minute · 30 secondes pour choisir · une cible commune.'
  ),
  'Only future-beacon financial rounds have this proof. Solo and scheduled practice rounds use different protocols.':
    tr(
      'ይህ ማስረጃ ያለው በወደፊት ዘፈቀዳዊ ምልክት የሚመሩ የገንዘብ ዙሮች ብቻ ናቸው። የግል እና በጊዜ የተመደቡ የልምምድ ዙሮች የተለዩ ሥርዓቶችን ይጠቀማሉ።',
      'Ragaan kun marsaa maallaqaa mallattoo carraa fuulduraa fayyadamu qofaaf. Marsaan shaakalaa dhuunfaa fi saganteeffame adeemsa adda addaa fayyadamu.',
      'እዚ መርትዖ ንዙራት ገንዘብ ናይ መጻኢ ዘፈቀዳዊ ምልክት ዝጥቀሙ ጥራይ እዩ። ውልቃውን ዝተመደቡን ዙራት ልምምድ ዝተፈላለዩ ኣገባባት ይጥቀሙ።',
      'Caddayntan waxaa leh oo keliya wareegyada lacagta ee isticmaala calaamad nasiib mustaqbalka. Wareegyada tababarka keligiis iyo kuwa jadwalaysan waxay isticmaalaan habab kala duwan.',
      'هذا الإثبات للجولات المالية المعتمدة على منارة عشوائية مستقبلية فقط. تستخدم جولات التدريب الفردية والمجدولة بروتوكولات مختلفة.',
      'Uthibitisho huu ni kwa raundi za fedha zinazotumia ishara ya nasibu ya baadaye pekee. Raundi za mazoezi za mtu mmoja na zilizopangwa hutumia taratibu tofauti.',
      'Seules les manches financières utilisant une balise aléatoire future ont cette preuve. Les manches d’entraînement solo et programmées utilisent d’autres protocoles.'
    ),
  'Original simulated racing with free, non-redeemable practice ETB.': tr(
    'በነፃ፣ ሊለወጥ በማይችል የልምምድ ETB የሚካሄድ ኦሪጅናል ማስመሰያ ውድድር።',
    'Fiigicha fakkeeffame jalqabaa ETB shaakalaa bilisaa kan maallaqatti hin jijjiiramneen.',
    'ኦሪጅናል ዝተመሰለ ውድድር ብነጻ፣ ዘይልወጥ ETB ልምምድ።',
    'Tartan la matalay oo asal ah, leh ETB tababar bilaash ah oo aan la sarifan karin.',
    'سباقات محاكاة أصلية برصيد ETB تدريبي مجاني غير قابل للاستبدال.',
    'Mbio asili za kuiga kwa ETB ya mazoezi ya bure isiyokombolewa.',
    'Courses simulées originales avec des ETB d’entraînement gratuits et non échangeables.'
  ),
  'Original simulated racing with free, non-redeemable practice ETB. Your racing practice balance is shared with Derby; your cash wallet is separate.':
    tr(
      'በነፃ፣ ሊለወጥ በማይችል የልምምድ ETB የሚካሄድ ኦሪጅናል ማስመሰያ ውድድር። የውድድር ልምምድ ሂሳብዎ ከደርቢ ጋር የጋራ ነው፤ የገንዘብ ቦርሳዎ የተለየ ነው።',
      'Fiigicha fakkeeffame jalqabaa ETB shaakalaa bilisaa kan hin jijjiiramneen. Hafteen shaakala fiigichaa kee Derby waliin qooddama; boorsaan maallaqaa kee addaa dha.',
      'ኦሪጅናል ዝተመሰለ ውድድር ብነጻ፣ ዘይልወጥ ETB ልምምድ። ሒሳብ ልምምድ ውድድርካ ምስ ደርቢ ሓባራዊ እዩ፤ ቦርሳ ገንዘብካ ዝተፈለየ እዩ።',
      'Tartan la matalay oo asal ah, leh ETB tababar bilaash ah oo aan la sarifan karin. Haraaga tababarka tartanka waxaa lala wadaagaa Derby; jeebka lacagtaada dhabta ahi waa gooni.',
      'سباقات محاكاة أصلية برصيد ETB تدريبي مجاني غير قابل للاستبدال. رصيد تدريب السباقات مشترك مع ديربي؛ محفظتك النقدية منفصلة.',
      'Mbio asili za kuiga kwa ETB ya mazoezi ya bure isiyokombolewa. Salio lako la mazoezi ya mbio linashirikiwa na Derby; pochi yako ya fedha ni tofauti.',
      'Courses simulées originales avec des ETB d’entraînement gratuits et non échangeables. Le solde d’entraînement est partagé avec Derby ; votre portefeuille monétaire est distinct.'
    ),
  'Pick exactly six numbers for one amount. All six must appear; the position of your sixth match sets the return.':
    tr(
      'ለአንድ መጠን በትክክል ስድስት ቁጥሮችን ይምረጡ። ስድስቱም መውጣት አለባቸው፤ የስድስተኛው ተዛማጅ ቦታ ተመላሹን ይወስናል።',
      'Maallaqa tokkoof lakkoofsota jaʼa sirriitti filadhu. Jaʼan hundi baʼuu qabu; bakki walsimannaa jaʼaffaa deebii murteessa.',
      'ንሓደ መጠን ብልክዕ ሽዱሽተ ቁጽርታት ምረጽ። ኩሎም ሽዱሽተ ክወጹ ኣለዎም፤ ቦታ ሻድሻይ ዝተዛመደ ተመላሲ ይውስን።',
      'Hal qaddar ku dooro lix lambar oo keliya. Lixduba waa inay soo baxaan; booska is-waafajintaada lixaad ayaa goʼaamiya soo-noqoshada.',
      'اختر ستة أرقام بالضبط لمبلغ واحد. يجب ظهور الستة؛ ترتيب مطابقتك السادسة يحدد العائد.',
      'Chagua nambari sita hasa kwa kiasi kimoja. Zote sita lazima zionekane; nafasi ya nambari yako ya sita inayolingana huamua marejesho.',
      'Choisissez exactement six numéros pour un montant. Les six doivent sortir ; la position de votre sixième correspondance détermine le retour.'
    ),
  'Pick numbered dogs in the required order. Choose 10–500 ETB.': tr(
    'ቁጥር ያላቸውን ውሾች በሚፈለገው ቅደም ተከተል ይምረጡ። 10–500 ETB ይምረጡ።',
    'Sareewwan lakkoofsa qaban tartiiba barbaadameen filadhu. 10–500 ETB filadhu.',
    'ቁጽሪ ዘለዎም ኣኽላባት ብዝድለ ቅደም ተኸተል ምረጽ። 10–500 ETB ምረጽ።',
    'U dooro eeyaha lambaraysan kala horreynta loo baahan yahay. Dooro 10–500 ETB.',
    'اختر الكلاب المرقّمة بالترتيب المطلوب. اختر 10–500 ETB.',
    'Chagua mbwa wenye nambari kwa mpangilio unaohitajika. Chagua 10–500 ETB.',
    'Choisissez les chiens numérotés dans l’ordre requis. Choisissez 10–500 ETB.'
  ),
  'Pick numbered horses in the required order. Choose 10–500 ETB.': tr(
    'ቁጥር ያላቸውን ፈረሶች በሚፈለገው ቅደም ተከተል ይምረጡ። 10–500 ETB ይምረጡ።',
    'Fardeen lakkoofsa qaban tartiiba barbaadameen filadhu. 10–500 ETB filadhu.',
    'ቁጽሪ ዘለዎም ኣፍራስ ብዝድለ ቅደም ተኸተል ምረጽ። 10–500 ETB ምረጽ።',
    'U dooro fardaha lambaraysan kala horreynta loo baahan yahay. Dooro 10–500 ETB.',
    'اختر الخيول المرقّمة بالترتيب المطلوب. اختر 10–500 ETB.',
    'Chagua farasi wenye nambari kwa mpangilio unaohitajika. Chagua 10–500 ETB.',
    'Choisissez les chevaux numérotés dans l’ordre requis. Choisissez 10–500 ETB.'
  ),
  'Place up to ten independent tickets per round, with 5–500 practice ETB each. You start with a separate 1,000 ETB practice balance.':
    tr(
      'በዙር እስከ አስር ገለልተኛ ትኬቶች፣ እያንዳንዱን በ 5–500 የልምምድ ETB ያስገቡ። በተለየ 1,000 ETB የልምምድ ሂሳብ ይጀምራሉ።',
      'Marsaa tokkoof hanga tikeetii walaba kudhan, tokkoon tokkoon ETB shaakalaa 5–500 galchi. Haftee shaakalaa addaa 1,000 ETB irraa jalqabda.',
      'ኣብ ዙር ክሳብ ዓሰርተ ናጻ ትኬታት፣ ነፍሲ ወከፍ ብ 5–500 ETB ልምምድ ኣእቱ። ብዝተፈለየ 1,000 ETB ሒሳብ ልምምድ ትጅምር።',
      'Geli ilaa toban tigidh oo gooni ah wareeg kasta, midkiiba 5–500 ETB tababar ah. Waxaad ku bilaabaysaa haraag tababar oo gaar ah oo 1,000 ETB ah.',
      'ضع حتى عشر تذاكر مستقلة لكل جولة، بـ 5–500 ETB تدريبي لكل منها. تبدأ برصيد تدريبي منفصل قدره 1,000 ETB.',
      'Weka hadi tiketi kumi tofauti kwa raundi, kila moja 5–500 ETB ya mazoezi. Unaanza na salio tofauti la mazoezi la 1,000 ETB.',
      'Placez jusqu’à dix tickets indépendants par manche, de 5–500 ETB d’entraînement chacun. Vous commencez avec un solde d’entraînement distinct de 1 000 ETB.'
    ),
  'Practice ETB only · No deposits or redeemable prizes · 90% theoretical return': tr(
    'የልምምድ ETB ብቻ · ተቀማጭ ወይም ሊቀየሩ የሚችሉ ሽልማቶች የሉም · 90% ንድፈ ሐሳባዊ ተመላሽ',
    'ETB shaakalaa qofa · Maallaqa galchuu ykn badhaasa jijjiiramu hin qabu · Deebii tiyoorii 90%',
    'ETB ልምምድ ጥራይ · ተቐማጢ ወይ ዝልወጥ ሽልማት የለን · 90% ቲዮራዊ ተመላሲ',
    'ETB tababar keliya · Dhigaal ama abaalmarin la sarifan karo ma jiro · 90% soo-noqosho aragtiyeed',
    'ETB تدريبي فقط · بلا إيداعات أو جوائز قابلة للاستبدال · عائد نظري 90%',
    'ETB ya mazoezi tu · Hakuna amana au zawadi zinazokombolewa · Marejesho ya kinadharia 90%',
    'ETB d’entraînement uniquement · Aucun dépôt ni prix échangeable · Retour théorique de 90 %'
  ),
  "Practice ETB only · No deposits or redeemable prizes · Salem's original rules": tr(
    'የልምምድ ETB ብቻ · ተቀማጭ ወይም ሊቀየሩ የሚችሉ ሽልማቶች የሉም · የሳሌም መሠረታዊ ደንቦች',
    'ETB shaakalaa qofa · Maallaqa galchuu ykn badhaasa jijjiiramu hin qabu · Seerota Salem jalqabaa',
    'ETB ልምምድ ጥራይ · ተቐማጢ ወይ ዝልወጥ ሽልማት የለን · መሰረታዊ ሕግታት ሳሌም',
    'ETB tababar keliya · Dhigaal ama abaalmarin la sarifan karo ma jiro · Xeerarka asalka ah ee Salem',
    'ETB تدريبي فقط · بلا إيداعات أو جوائز قابلة للاستبدال · قواعد سالم الأصلية',
    'ETB ya mazoezi tu · Hakuna amana au zawadi zinazokombolewa · Kanuni asili za Salem',
    'ETB d’entraînement uniquement · Aucun dépôt ni prix échangeable · Règles originales de Salem'
  ),
  'Practice ETB starts at 1,000, cannot be bought, transferred, gifted or converted, and are separate from your cash wallet and Game Points. If the connection or worker is interrupted, entry pauses and saved tickets settle against their original roll when service resumes. Existing group PVP games use a separate 7% completion fee.':
    tr(
      'የልምምድ ETB በ 1,000 ይጀምራል፣ መግዛት፣ ማስተላለፍ፣ በስጦታ መስጠት ወይም መቀየር አይቻልም፣ ከገንዘብ ቦርሳዎ እና የጨዋታ ነጥቦች የተለየ ነው። ግንኙነት ወይም የጀርባ አገልግሎት ከተቋረጠ ተሳትፎ ይቆማል፣ አገልግሎቱ ሲመለስ የተቀመጡ ትኬቶች በመጀመሪያ የዳይስ ውጤታቸው ይጠናቀቃሉ። ነባር የቡድን PVP ጨዋታዎች የተለየ 7% የማጠናቀቂያ ክፍያ ይጠቀማሉ።',
      'ETB shaakalaa 1,000 irraa jalqaba; bitamuu, dabarfamuu, kennaa taʼuu ykn jijjiiramuu hin dandaʼu; boorsaa maallaqaa fi Qabxii Taphaa irraa addaa dha. Walqunnamtiin ykn tajaajilli duubaa yoo cite, hirmaannaan dhaabbata; tikeetiin olkaaʼame tajaajilli yeroo deebiʼu darbannaa jalqabaa isaatiin xumurama. Taphoonni garee PVP jiran kaffaltii xumuraa addaa 7% fayyadamu.',
      'ETB ልምምድ ካብ 1,000 ይጅምር፣ ክዕደግ፣ ክሰጋገር፣ ህያብ ክኸውን ወይ ክልወጥ ኣይክእልን፣ ካብ ቦርሳ ገንዘብካን ነጥብታት ጸወታን ዝተፈለየ እዩ። ርክብ ወይ ድሕረ-ባይታ ኣገልግሎት እንተተቛሪጹ ተሳትፎ ይቖም፣ ዝተዓቀቡ ትኬታት ኣገልግሎት ምስ ተመልሰ ብቀዳማይ ውጽኢቶም ይውድኡ። ነባራት ጉጅለ PVP ጸወታታት ዝተፈለየ 7% ክፍሊት ምዝዛም ይጥቀሙ።',
      'ETB tababarku wuxuu ka bilaabmaa 1,000, lama iibsan, wareejin, hadiyadeyn ama beddeli karo, wuxuuna ka gooni yahay jeebka lacagta iyo Dhibcaha Ciyaarta. Haddii xiriirka ama adeegga dambe goʼo, gelitaanku wuu joogsadaa; tigidhada kaydsanna waxay ku dhammaanayaan rogistoodii asalka ahayd marka adeeggu soo noqdo. Ciyaaraha kooxeed ee PVP ee jira waxay leeyihiin khidmad dhammaystir oo gaar ah oo 7% ah.',
      'يبدأ ETB التدريبي بـ 1,000، ولا يُشترى أو يُنقل أو يُهدى أو يُحوّل، وهو منفصل عن المحفظة النقدية ونقاط اللعبة. عند انقطاع الاتصال أو العامل الخلفي تتوقف المشاركة، وتُسوّى التذاكر المحفوظة على رميتها الأصلية عند عودة الخدمة. ألعاب PVP الجماعية الحالية تستخدم رسم إكمال منفصلًا قدره 7%.',
      'ETB ya mazoezi huanza 1,000, haiwezi kununuliwa, kuhamishwa, kutolewa kama zawadi au kubadilishwa; ni tofauti na pochi ya fedha na Alama za Mchezo. Muunganisho au huduma ya nyuma ikikatika, kujiunga husimama na tiketi zilizohifadhiwa hukamilishwa kwa mrusho wake wa awali huduma ikirudi. Michezo ya sasa ya kikundi ya PVP hutumia ada tofauti ya kukamilisha ya 7%.',
      'Les ETB d’entraînement commencent à 1 000, ne peuvent être achetés, transférés, offerts ou convertis et sont distincts du portefeuille monétaire et des points de jeu. En cas d’interruption de connexion ou du traitement, les participations sont suspendues et les tickets sont réglés sur leur lancer initial à la reprise. Les jeux PVP de groupe existants utilisent des frais d’achèvement distincts de 7 %.'
    ),
  'Practice is unavailable. Check your connection or sign in again.': tr(
    'ልምምድ አይገኝም። ግንኙነትዎን ይፈትሹ ወይም እንደገና ይግቡ።',
    'Shaakalli hin argamu. Walqunnamtii kee ilaali ykn irra deebiʼii seeni.',
    'ልምምድ ኣይርከብን። ርክብካ መርምር ወይ ዳግም እቶ።',
    'Tababar lama heli karo. Hubi xiriirkaaga ama mar kale gal.',
    'التدريب غير متاح. تحقّق من اتصالك أو سجّل الدخول مجددًا.',
    'Mazoezi hayapatikani. Kagua muunganisho wako au ingia tena.',
    'L’entraînement est indisponible. Vérifiez votre connexion ou reconnectez-vous.'
  ),
  'Practice only · Local demo draw · No deposits or redeemable prizes': tr(
    'ልምምድ ብቻ · በዚህ መሣሪያ የሙከራ ዕጣ · ተቀማጭ ወይም ሊቀየሩ የሚችሉ ሽልማቶች የሉም',
    'Shaakala qofa · Carraa yaalii meeshaa kanaa · Maallaqa galchuu ykn badhaasa jijjiiramu hin qabu',
    'ልምምድ ጥራይ · ዕጣ ፈተነ ኣብዚ መሳርሒ · ተቐማጢ ወይ ዝልወጥ ሽልማት የለን',
    'Tababar keliya · Isku-aad tijaabo oo qalabkan ah · Dhigaal ama abaalmarin la sarifan karo ma jiro',
    'تدريب فقط · سحب تجريبي على الجهاز · بلا إيداعات أو جوائز قابلة للاستبدال',
    'Mazoezi tu · Droo ya majaribio kwenye kifaa · Hakuna amana au zawadi zinazokombolewa',
    'Entraînement uniquement · Tirage de démo local · Aucun dépôt ni prix échangeable'
  ),
  'Practice starts with 1,000 nonredeemable practice ETB, separate from your cash wallet and Game Points. No purchases, gifts, transfers or withdrawals. Confirm up to two immutable tickets per round. Auto cash-out is handled by the server and survives disconnects.':
    tr(
      'ልምምድ ከገንዘብ ቦርሳዎ እና የጨዋታ ነጥቦች በተለየ፣ ሊለወጥ በማይችል 1,000 የልምምድ ETB ይጀምራል። ግዢ፣ ስጦታ፣ ዝውውር ወይም ወጪ ማድረግ የለም። በዙር እስከ ሁለት የማይቀየሩ ትኬቶችን ያረጋግጡ። ራስ-ሰር ከጨዋታ መውጣት በአገልጋዩ ይከናወናል፣ ግንኙነት ቢቋረጥም ይቀጥላል።',
      'Shaakalli ETB 1,000 hin jijjiiramne irraa jalqaba, boorsaa maallaqaa fi Qabxii Taphaa irraa addaa. Bittaa, kennaa, dabarsa ykn baasuun hin jiru. Marsaa tokkoof hanga tikeetii lama hin jijjiiramne mirkaneessi. Ofumaan tapha keessaa baʼuu sarvariin hojjeta, walqunnamtiin yoo cite ni tura.',
      'ልምምድ ብዘይልወጥ 1,000 ETB ይጅምር፣ ካብ ቦርሳ ገንዘብካን ነጥብታት ጸወታን ዝተፈለየ። ዕድጊ፣ ህያብ፣ ምስግጋር ወይ ገንዘብ ምውጻእ የለን። ኣብ ዙር ክሳብ ክልተ ዘይቅየሩ ትኬታት ኣረጋግጽ። ርእሰ-ሰር ምውጻእ ካብ ጸወታ ብኣገልጋሊ ይፍጸም፣ ርክብ እንተተቛሪጹ ይቕጽል።',
      'Tababarku wuxuu ku bilaabmaa 1,000 ETB tababar oo aan la sarifan karin, kana gooni ah jeebka lacagta iyo Dhibcaha Ciyaarta. Ma jiraan iibsi, hadiyad, wareejin ama la-bixid lacag. Xaqiiji ilaa laba tigidh oo aan la beddeli karin wareeg kasta. Bixitaanka tooska ah seerfarka ayaa maamula wuxuuna sii shaqeeyaa haddii xiriirku goʼo.',
      'يبدأ التدريب بـ 1,000 ETB غير قابل للاستبدال، منفصل عن المحفظة النقدية ونقاط اللعبة. لا شراء أو هدايا أو تحويلات أو سحب. أكّد حتى تذكرتين غير قابلتين للتعديل لكل جولة. يتولى الخادم الخروج التلقائي ويستمر عند انقطاع الاتصال.',
      'Mazoezi huanza na ETB 1,000 zisizokombolewa, tofauti na pochi ya fedha na Alama za Mchezo. Hakuna ununuzi, zawadi, uhamisho au kutoa pesa. Thibitisha hadi tiketi mbili zisizobadilika kwa raundi. Seva hushughulikia kutoka kiotomatiki hata muunganisho ukikatika.',
      'L’entraînement commence avec 1 000 ETB non échangeables, distincts du portefeuille monétaire et des points de jeu. Aucun achat, cadeau, transfert ou retrait. Confirmez jusqu’à deux tickets non modifiables par manche. Le serveur gère l’encaissement automatique, qui reste actif après déconnexion.'
    ),
  'Practice starts with 1,000 nonredeemable practice ETB, separate from your cash wallet and Game Points. No purchases, refills, gifts, transfers or withdrawals. Sky Crash practice ETB are separate from Crash Point practice ETB. Confirm up to two immutable tickets per round. Auto cash-out is handled by the server and survives disconnects. A target equal to the crash loses.':
    tr(
      'ልምምድ ከገንዘብ ቦርሳዎ እና የጨዋታ ነጥቦች በተለየ፣ ሊለወጥ በማይችል 1,000 የልምምድ ETB ይጀምራል። ግዢ፣ እንደገና መሙላት፣ ስጦታ፣ ዝውውር ወይም ወጪ የለም። የSky Crash ልምምድ ETB ከCrash Point የተለየ ነው። በዙር እስከ ሁለት የማይቀየሩ ትኬቶችን ያረጋግጡ። ራስ-ሰር ከጨዋታ መውጣት በአገልጋዩ ይከናወናል፣ ግንኙነት ቢቋረጥም ይቀጥላል። ከመውደቂያው ጋር እኩል የሆነ ዒላማ ይሸነፋል።',
      'Shaakalli ETB 1,000 hin jijjiiramne irraa jalqaba, boorsaa maallaqaa fi Qabxii Taphaa irraa addaa. Bittaa, irra guutuu, kennaa, dabarsa ykn baasuun hin jiru. ETB shaakalaa Sky Crash kan Crash Point irraa addaa dha. Marsaa tokkoof hanga tikeetii lama hin jijjiiramne mirkaneessi. Baʼuu ofumaan sarvariin hojjeta, walqunnamtiin yoo cite ni tura. Galmi kufaatii wajjin walqixa taʼe ni moʼama.',
      'ልምምድ ብዘይልወጥ 1,000 ETB ይጅምር፣ ካብ ቦርሳ ገንዘብካን ነጥብታት ጸወታን ዝተፈለየ። ዕድጊ፣ ዳግም ምምላእ፣ ህያብ፣ ምስግጋር ወይ ገንዘብ ምውጻእ የለን። ETB ልምምድ Sky Crash ካብ Crash Point ዝተፈለየ እዩ። ኣብ ዙር ክሳብ ክልተ ዘይቅየሩ ትኬታት ኣረጋግጽ። ርእሰ-ሰር ምውጻእ ብኣገልጋሊ ይፍጸም፣ ርክብ እንተተቛሪጹ ይቕጽል። ምስ ምውዳቕ ማዕረ ዒላማ ይስዓር።',
      'Tababarku wuxuu ku bilaabmaa 1,000 ETB aan la sarifan karin, kana gooni ah jeebka lacagta iyo Dhibcaha Ciyaarta. Ma jiraan iibsi, dib-u-buuxin, hadiyad, wareejin ama la-bixid. ETB tababarka Sky Crash waa ka gooni kan Crash Point. Xaqiiji ilaa laba tigidh oo aan la beddeli karin wareeg kasta. Bixitaanka tooska ah seerfarka ayaa maamula wuuna sii shaqeeyaa haddii xiriirku goʼo. Bartilmaameed la mid ah dhicitaanka wuu lumiyaa.',
      'يبدأ التدريب بـ 1,000 ETB غير قابل للاستبدال، منفصل عن المحفظة النقدية ونقاط اللعبة. لا شراء أو إعادة تعبئة أو هدايا أو تحويلات أو سحب. رصيد Sky Crash التدريبي منفصل عن Crash Point. أكّد حتى تذكرتين غير قابلتين للتعديل لكل جولة. يتولى الخادم الخروج التلقائي ويستمر عند انقطاع الاتصال. الهدف المساوي للانهيار يخسر.',
      'Mazoezi huanza na ETB 1,000 zisizokombolewa, tofauti na pochi ya fedha na Alama za Mchezo. Hakuna ununuzi, kujaza tena, zawadi, uhamisho au kutoa pesa. ETB ya mazoezi ya Sky Crash ni tofauti na ya Crash Point. Thibitisha hadi tiketi mbili zisizobadilika kwa raundi. Seva hushughulikia kutoka kiotomatiki hata muunganisho ukikatika. Lengo linalolingana na kuanguka hupoteza.',
      'L’entraînement commence avec 1 000 ETB non échangeables, distincts du portefeuille monétaire et des points de jeu. Aucun achat, recharge, cadeau, transfert ou retrait. Les ETB de Sky Crash sont distincts de ceux de Crash Point. Confirmez jusqu’à deux tickets non modifiables par manche. Le serveur gère l’encaissement automatique, actif même après déconnexion. Une cible égale au crash perd.'
    ),
  'Predict six automated seats playing against one dealer. You choose bets; the table deals and plays each hand.':
    tr(
      'አንድ አከፋፋይ ላይ የሚጫወቱ ስድስት ራስ-ሰር መቀመጫዎችን ይገምቱ። እርስዎ ውርርዶችን ይመርጣሉ፤ ጠረጴዛው ካርዶችን ያከፋፍላል እና እያንዳንዱን እጅ ይጫወታል።',
      'Bakka ofumaan taphatu jaʼa qoodaa tokko irratti tilmaami. Ati buusii filatta; minjaalli kaardii qooda, harka hundas taphata.',
      'ኣንጻር ሓደ ኣከፋፋሊ ዝጻወቱ ሽዱሽተ ርእሰ-ሰር መቐመጢታት ገምት። ንስኻ ውርርድ ትመርጽ፤ ጠረጴዛ ካርድ ይኸፋፍልን ነፍሲ ወከፍ ኢድ ይጻወትን።',
      'Saadaali lix kursi oo toos u ciyaaraya hal qaybiye. Adiga ayaa doorta sharadyada; miiskuna kaararka ayuu qaybiyaa gacanna kasta wuu ciyaaraa.',
      'توقّع نتائج ستة مقاعد آلية أمام موزّع واحد. تختار الرهانات؛ والطاولة توزّع وتلعب كل يد.',
      'Tabiri viti sita vya kiotomatiki vinavyocheza dhidi ya muuzaji mmoja. Unachagua dau; meza hugawa na kucheza kila mkono.',
      'Prévoyez six sièges automatisés face à un croupier. Vous choisissez les mises ; la table distribue et joue chaque main.'
    ),
  'Premier League club-themed simulation · Original kits and badges · Not real fixtures or player likenesses':
    tr(
      'በፕሪሚየር ሊግ ክለቦች ገጽታ የተዘጋጀ ማስመሰያ · የራስ ማሊያዎች እና አርማዎች · እውነተኛ ግጥሚያዎች ወይም የተጫዋቾች ምስሎች አይደሉም',
      'Fakkeessa bifa kilaboota Premier League · Uffataa fi mallattoo mataa isaa · Tapha dhugaa ykn fakkii taphataa miti',
      'ምምሳል ብመልክዕ ክለባት ፕሪሚየር ሊግ · ናይ ርእሱ ማልያታትን ምልክታትን · ሓቀኛ ግጥማት ወይ ምስሊ ተጻወትቲ ኣይኮኑን',
      'Matalid leh muuqaalka kooxaha Premier League · Funaanado iyo calaamado asal ah · Ma aha kulamo dhab ah ama muuqaallo ciyaartoy',
      'محاكاة بطابع أندية الدوري الإنجليزي · أطقم وشعارات أصلية · ليست مباريات حقيقية أو صور لاعبين',
      'Uigaji wenye mandhari ya klabu za Premier League · Jezi na nembo asili · Si mechi halisi wala sura za wachezaji',
      'Simulation sur le thème des clubs de Premier League · Tenues et emblèmes originaux · Aucune rencontre réelle ni représentation de joueurs'
    ),
  'Prices for this matchweek could not be verified in your browser, so selections are paused. Refresh to try again.':
    tr(
      'በአሳሽዎ የዚህ የግጥሚያ ሳምንት ዋጋዎች ማረጋገጥ አልተቻለም፣ ስለዚህ ምርጫዎች ቆመዋል። እንደገና ለመሞከር ያድሱ።',
      'Gatiin torban taphaa kanaa biraawzara kee keessatti mirkanaaʼuu hin dandeenye, kanaaf filannoon dhaabbateera. Irra deebiʼii yaaluuf haaromsi.',
      'ዋጋታት ናይዚ ሰሙን ግጥማት ኣብ መርበብካ ክረጋገጹ ኣይከኣሉን፣ ስለዚ ምርጫታት ተቛሪጾም። ዳግም ንምፍታን ኣሐድስ።',
      'Qiimayaasha usbuucan kulamada lagama xaqiijin karin biraawsarkaaga, sidaas darteed doorashooyinka waa la hakiyay. Cusboonaysii si aad mar kale u tijaabiso.',
      'تعذر التحقق من أسعار أسبوع المباريات في متصفحك، لذا توقفت الاختيارات. حدّث الصفحة للمحاولة مجددًا.',
      'Bei za wiki hii ya mechi hazikuweza kuthibitishwa kwenye kivinjari chako, hivyo machaguo yamesimamishwa. Sasisha ili ujaribu tena.',
      'Les cotes de cette journée n’ont pas pu être vérifiées dans votre navigateur ; les sélections sont suspendues. Actualisez pour réessayer.'
    ),
  'Prices refresh after each deal and lock when you confirm. Closed outcomes cannot be bet on. A winning prediction returns stake × locked price; an incorrect prediction returns zero. Draw bets pay only when you select Draw.':
    tr(
      'ዋጋዎች ከእያንዳንዱ ካርድ ክፍፍል በኋላ ይታደሳሉ፣ ሲያረጋግጡም ይቆለፋሉ። የተዘጉ ውጤቶች ላይ መወራረድ አይቻልም። አሸናፊ ግምት ውርርድ × የተቆለፈ ዋጋ ይመልሳል፤ የተሳሳተ ግምት ዜሮ ይመልሳል። አቻ ውርርዶች የሚከፍሉት አቻን ሲመርጡ ብቻ ነው።',
      'Gatiin kaardii qoodamu hunda booda haaroma, yeroo mirkaneessitu cufama. Buʼaa cufame irratti buusii gochuun hin dandaʼamu. Tilmaamni moʼate buusii × gatii cufame deebisa; dogoggoraan zeeroo. Buusiin walqixaa yoo Walqixa filatte qofa kaffala.',
      'ዋጋታት ድሕሪ ነፍሲ ወከፍ ክፍፍል ካርድ ይሕደሱ፣ ምስ ኣረጋገጽካ ይዕጸዉ። ኣብ ዝተዓጽዉ ውጽኢታት ውርርድ ኣይፍቀድን። ተዓዋቲ ግምት ውርርድ × ዝተዓጽወ ዋጋ ይመልስ፤ ጌጋ ግምት ዜሮ። ማዕረ ውርርድ ማዕረ እንተመሪጽካ ጥራይ ይኸፍል።',
      'Qiimayaashu way cusboonaadaan qaybin kasta ka dib, wayna xirmaan markaad xaqiijiso. Natiijooyin xiran lama sharadi karo. Saadaal guuleysata waxay soo celisaa sharadka × qiimaha xiran; saadaal khaldan eber. Sharadka barbaruhu wuxuu bixiyaa oo keliya markaad doorato Barbaro.',
      'تتحدث الأسعار بعد كل توزيع وتُثبّت عند التأكيد. لا يمكن الرهان على نتائج مغلقة. التوقع الفائز يعيد الرهان × السعر المثبت؛ والخاطئ يعيد صفرًا. رهانات التعادل تدفع فقط عند اختيار التعادل.',
      'Bei husasishwa baada ya kila ugawaji na kufungwa unapothibitisha. Huwezi kuweka dau kwa matokeo yaliyofungwa. Utabiri ulioshinda hurudisha dau × bei iliyofungwa; uliokosea hurudisha sifuri. Dau za sare hulipa tu unapochagua Sare.',
      'Les cotes sont actualisées après chaque distribution et verrouillées à la confirmation. Aucune mise sur un résultat fermé. Une prévision gagnante rapporte mise × cote verrouillée ; une prévision incorrecte rapporte zéro. Les paris de match nul ne paient que si vous choisissez Match nul.'
    ),
  'Published before entry closes. The seed stays hidden until the crash.': tr(
    'ተሳትፎ ከመዘጋቱ በፊት ታትሟል። መነሻ እሴቱ እስከ መውደቁ ድረስ ይደበቃል።',
    'Hirmaannaan cufamuu dura maxxanfame. Sanyiin hanga kufaatiitti dhokatee tura.',
    'ተሳትፎ ቅድሚ ምዕጻዉ ተሓቲሙ። መበገሲ ክብሪ ክሳብ ምውዳቕ ተሓቢኡ ይጸንሕ።',
    'Waxaa la daabacay ka hor xidhitaanka gelitaanka. Abuurku wuu qarsoon yahay ilaa dhicitaanka.',
    'يُنشر قبل إغلاق المشاركة. تبقى البذرة مخفية حتى الانهيار.',
    'Huchapishwa kabla ya ushiriki kufungwa. Mbegu hubaki imefichwa hadi kuanguka.',
    'Publié avant la fermeture des participations. La graine reste cachée jusqu’au crash.'
  ),
  'Reconnecting. Bet entry is paused until a fresh update arrives.': tr(
    'እንደገና በመገናኘት ላይ። አዲስ መረጃ እስኪመጣ ድረስ ውርርድ ማስገባት ቆሟል።',
    'Irra deebiʼee walqunnamaa jira. Hanga odeeffannoon haaraan dhufutti buusii galchuun dhaabbateera.',
    'ዳግም ይራኸብ ኣሎ። ሓድሽ ሓበሬታ ክሳብ ዝመጽእ ውርርድ ምእታው ተቛሪጹ።',
    'Dib ayaa loo xirayaa. Gelinta sharadka waa la hakiyay ilaa xog cusub timaaddo.',
    'جارٍ إعادة الاتصال. وضع الرهانات متوقف حتى وصول تحديث جديد.',
    'Inaunganisha tena. Kuweka dau kumesimamishwa hadi taarifa mpya ifike.',
    'Reconnexion. Les mises sont suspendues jusqu’à une nouvelle mise à jour.'
  ),
  'Reconnecting. Bet entry pauses until a fresh update arrives.': tr(
    'እንደገና በመገናኘት ላይ። አዲስ መረጃ እስኪመጣ ድረስ ውርርድ ማስገባት ይቆማል።',
    'Irra deebiʼee walqunnamaa jira. Hanga odeeffannoon haaraan dhufutti buusii galchuun dhaabbata.',
    'ዳግም ይራኸብ ኣሎ። ሓድሽ ሓበሬታ ክሳብ ዝመጽእ ውርርድ ምእታው ይቖም።',
    'Dib ayaa loo xirayaa. Gelinta sharadku way joogsataa ilaa xog cusub timaaddo.',
    'جارٍ إعادة الاتصال. يتوقف وضع الرهانات حتى وصول تحديث جديد.',
    'Inaunganisha tena. Kuweka dau husimama hadi taarifa mpya ifike.',
    'Reconnexion. Les mises sont suspendues jusqu’à une nouvelle mise à jour.'
  ),
  'Reconnecting. Entry is paused until a fresh server update arrives.': tr(
    'እንደገና በመገናኘት ላይ። ከአገልጋዩ አዲስ መረጃ እስኪመጣ ድረስ ተሳትፎ ቆሟል።',
    'Irra deebiʼee walqunnamaa jira. Hanga odeeffannoon sarvaraa haaraan dhufutti hirmaannaan dhaabbateera.',
    'ዳግም ይራኸብ ኣሎ። ካብ ኣገልጋሊ ሓድሽ ሓበሬታ ክሳብ ዝመጽእ ተሳትፎ ተቛሪጹ።',
    'Dib ayaa loo xirayaa. Gelitaanka waa la hakiyay ilaa xog cusub oo seerfarka ah timaaddo.',
    'جارٍ إعادة الاتصال. المشاركة متوقفة حتى وصول تحديث جديد من الخادم.',
    'Inaunganisha tena. Kujiunga kumesimamishwa hadi taarifa mpya ya seva ifike.',
    'Reconnexion. Les participations sont suspendues jusqu’à une nouvelle mise à jour du serveur.'
  ),
  'Reconnecting. Ticket entry is paused until a fresh server update arrives.': tr(
    'እንደገና በመገናኘት ላይ። ከአገልጋዩ አዲስ መረጃ እስኪመጣ ድረስ ትኬት ማስገባት ቆሟል።',
    'Irra deebiʼee walqunnamaa jira. Hanga odeeffannoon sarvaraa haaraan dhufutti tikeetii galchuun dhaabbateera.',
    'ዳግም ይራኸብ ኣሎ። ካብ ኣገልጋሊ ሓድሽ ሓበሬታ ክሳብ ዝመጽእ ትኬት ምእታው ተቛሪጹ።',
    'Dib ayaa loo xirayaa. Gelinta tigidhka waa la hakiyay ilaa xog cusub oo seerfarka ah timaaddo.',
    'جارٍ إعادة الاتصال. وضع التذاكر متوقف حتى وصول تحديث جديد من الخادم.',
    'Inaunganisha tena. Kuweka tiketi kumesimamishwa hadi taarifa mpya ya seva ifike.',
    'Reconnexion. Les tickets sont suspendus jusqu’à une nouvelle mise à jour du serveur.'
  ),
};
export default catalogue;
