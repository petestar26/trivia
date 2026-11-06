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
  'Casino practice is temporarily unavailable. Please try again shortly.': tr(
    'የካሲኖ ልምምድ ለጊዜው አይገኝም። እባክዎ ትንሽ ቆይተው ይሞክሩ።',
    'Shaakalli kaasinoo yeroo muraasaaf hin argamu. Xiqqoo booda irra deebiʼii yaali.',
    'ልምምድ ካዚኖ ንግዚኡ ኣይርከብን። ቁሩብ ጸኒሕካ ፈትን።',
    'Tababarka kasiinada hadda lama heli karo. Fadlan wax yar ka dib isku day.',
    'تدريب الكازينو غير متاح مؤقتًا. يرجى المحاولة بعد قليل.',
    'Mazoezi ya kasino hayapatikani kwa muda. Tafadhali jaribu tena baada ya muda mfupi.',
    'L’entraînement au casino est temporairement indisponible. Réessayez dans un instant.'
  ),
  'Check a published commitment and reproduce the result locally in your browser. Verification only · No bets or deposits.':
    tr(
      'የታተመውን ቅድመ ማረጋገጫ ይፈትሹ እና በአሳሽዎ ውስጥ ውጤቱን እንደገና ያስሉ። ማረጋገጫ ብቻ · ውርርድ ወይም ተቀማጭ የለም።',
      'Ragaa duraa maxxanfame ilaali, buʼaas biraawzara kee keessatti irra deebiʼii shallagi. Mirkaneessa qofa · Buusii ykn maallaqa galchuun hin jiru.',
      'ዝተሓትመ ቅድመ መረጋገጺ መርምር፣ ውጽኢት እውን ኣብ መርበብካ ደጊምካ ኣስልጥ። ምርግጋጽ ጥራይ · ውርርድ ወይ ተቐማጢ የለን።',
      'Hubi xaqiijinta hore ee la daabacay oo natiijada dib ugu xisaabi biraawsarkaaga. Xaqiijin keliya · Sharad ama dhigaal ma jiro.',
      'تحقّق من الالتزام المسبق المنشور وأعد حساب النتيجة محليًا في متصفحك. للتحقق فقط · بلا رهانات أو إيداعات.',
      'Kagua uthibitisho wa awali uliochapishwa na urudie hesabu ya matokeo kwenye kivinjari chako. Uthibitishaji tu · Hakuna dau au amana.',
      'Vérifiez un engagement publié et reproduisez le résultat dans votre navigateur. Vérification uniquement · Aucune mise ni dépôt.'
    ),
  'Choose 1–10 numbers from 1–80. Each matching number returns 3.6× its stake, including the original stake on that number. Twenty different numbers are drawn. The 25% chance × 3.6× return gives 90% theoretical return over repeated play.':
    tr(
      'ከ 1–80 መካከል 1–10 ቁጥሮችን ይምረጡ። እያንዳንዱ ተዛማጅ ቁጥር በዚያ ቁጥር የተወራረዱትን ጨምሮ 3.6× ይመልሳል። ሃያ የተለያዩ ቁጥሮች ይወጣሉ። 25% ዕድል × 3.6× ተመላሽ በተደጋጋሚ ጨዋታ 90% ንድፈ ሐሳባዊ ተመላሽ ይሰጣል።',
      '1–80 keessaa lakkoofsota 1–10 filadhu. Lakkoofsi walsimu hundi buusii isaa 3.6× deebisa, buusii jalqabaa lakkoofsa sanaa dabalatee. Lakkoofsota adda addaa digdamatu baʼa. Carraa 25% × deebii 3.6× jechuun tapha irra deddeebiʼamu irratti deebii tiyoorii 90% dha.',
      'ካብ 1–80 ቁጽርታት 1–10 ምረጽ። ነፍሲ ወከፍ ዝተዛመደ ቁጽሪ ውርርዱ 3.6× ይመልስ፣ ነቲ ቀዳማይ ውርርድ ሓዊሱ። ዕስራ ዝተፈላለዩ ቁጽርታት ይወጹ። 25% ዕድል × 3.6× ተመላሲ ኣብ ተደጋጋሚ ጸወታ 90% ቲዮራዊ ተመላሲ ይህብ።',
      'Dooro 1–10 lambar oo ka mid ah 1–80. Lambar kasta oo is-waafaqa wuxuu soo celiyaa 3.6× sharadkiisa, oo uu ku jiro sharadkii asalka ahaa ee lambarkaas. Labaatan lambar oo kala duwan ayaa la soo saaraa. Fursadda 25% × soo-noqoshada 3.6× waxay bixisaa 90% soo-noqosho aragtiyeed marka marar badan la ciyaaro.',
      'اختر 1–10 أرقام من 1–80. يعيد كل رقم مطابق 3.6× رهانه، شاملًا الرهان الأصلي لذلك الرقم. تُسحب عشرون رقمًا مختلفًا. احتمال 25% × عائد 3.6× يعطي عائدًا نظريًا 90% عبر اللعب المتكرر.',
      'Chagua nambari 1–10 kutoka 1–80. Kila nambari inayolingana hurudisha 3.6× dau lake, ikijumuisha dau la awali la nambari hiyo. Nambari ishirini tofauti hutolewa. Nafasi ya 25% × marejesho 3.6× hutoa marejesho ya kinadharia 90% kwa kucheza mara nyingi.',
      'Choisissez 1–10 numéros parmi 1–80. Chaque numéro correspondant rapporte 3,6× sa mise, mise initiale sur ce numéro incluse. Vingt numéros différents sont tirés. Une chance de 25 % × un retour de 3,6× donne un retour théorique de 90 % sur des jeux répétés.'
    ),
  'Choose a seat to win, draw or lose against the dealer, or predict final points: 17–21, a natural Blackjack, or a Bust. Dealer bets are final-points bets only.':
    tr(
      'አንድ መቀመጫ በአከፋፋዩ ላይ እንዲያሸንፍ፣ አቻ እንዲሆን ወይም እንዲሸነፍ ይምረጡ፤ ወይም የመጨረሻ ነጥቦችን፦17–21፣ በሁለት ካርዶች ብላክጃክ ወይም ከ 21 በላይ መሆን ይገምቱ። በአከፋፋዩ ላይ ውርርድ በመጨረሻ ነጥቦች ብቻ ነው።',
      'Bakki tokko qoodaa irratti moʼachuu, walqixa taʼuu ykn moʼamuu filadhu; ykn qabxii dhumaa 17–21, Blackjack uumamaa ykn 21 darbuu tilmaami. Buusiin qoodaa qabxii dhumaa qofa irratti.',
      'መቐመጢ ኣንጻር ኣከፋፋሊ ክዕወት፣ ማዕረ ክኸውን ወይ ክስዓር ምረጽ፤ ወይ መወዳእታ ነጥቢ 17–21፣ ብክልተ ካርድ ብላክጃክ ወይ ካብ 21 ምሕላፍ ገምት። ናይ ኣከፋፋሊ ውርርድ መወዳእታ ነጥቢ ጥራይ እዩ።',
      'Dooro kursi inuu ka guuleysto, barbaro la galo ama ka guuldarreysto qaybiyaha, ama saadaali dhibcaha kama dambaysta ah:17–21, Blackjack dabiici ah ama ka-badid 21. Sharadyada qaybiyaha waa dhibcaha kama dambaysta ah keliya.',
      'اختر مقعدًا ليفوز أو يتعادل أو يخسر أمام الموزّع، أو توقّع النقاط النهائية: 17–21 أو بلاك جاك طبيعي أو تجاوز 21. رهانات الموزّع على النقاط النهائية فقط.',
      'Chagua kiti kushinda, sare au kushindwa dhidi ya muuzaji, au tabiri alama za mwisho:17–21, Blackjack ya asili au kuzidi 21. Dau za muuzaji ni za alama za mwisho pekee.',
      'Choisissez un siège gagnant, nul ou perdant face au croupier, ou prévoyez ses points finaux : 17–21, Blackjack naturel ou dépassement. Les mises sur le croupier portent uniquement sur ses points finaux.'
    ),
  'Choose a six- or eight-dog race, then a selection type.': tr(
    'የስድስት ወይም ስምንት ውሻ ውድድር፣ ከዚያ የምርጫ አይነት ይምረጡ።',
    'Fiigicha saree jaʼaa ykn saddeetii, achiis gosa filannoo filadhu.',
    'ውድድር ሽዱሽተ ወይ ሸሞንተ ኣኽላባት፣ ድሕሪኡ ዓይነት ምርጫ ምረጽ።',
    'Dooro tartan lix ama siddeed eey ah, ka dibna nooca doorashada.',
    'اختر سباقًا بستة أو ثمانية كلاب، ثم نوع الاختيار.',
    'Chagua mbio za mbwa sita au wanane, kisha aina ya chaguo.',
    'Choisissez une course de six ou huit chiens, puis un type de sélection.'
  ),
  'Choose a six- or eight-horse race, then a selection type.': tr(
    'የስድስት ወይም ስምንት ፈረስ ውድድር፣ ከዚያ የምርጫ አይነት ይምረጡ።',
    'Fiigicha farda jaʼaa ykn saddeetii, achiis gosa filannoo filadhu.',
    'ውድድር ሽዱሽተ ወይ ሸሞንተ ኣፍራስ፣ ድሕሪኡ ዓይነት ምርጫ ምረጽ።',
    'Dooro tartan lix ama siddeed faras ah, ka dibna nooca doorashada.',
    'اختر سباقًا بستة أو ثمانية خيول، ثم نوع الاختيار.',
    'Chagua mbio za farasi sita au wanane, kisha aina ya chaguo.',
    'Choisissez une course de six ou huit chevaux, puis un type de sélection.'
  ),
  'Choose a stake, follow the rising multiplier, and cash out before the crash.': tr(
    'ውርርድ ይምረጡ፣ የሚጨምረውን አባዥ ይከታተሉ፣ ከመውደቁ በፊት ከጨዋታው ይውጡ።',
    'Buusii filadhu, baayʼisaa olkaʼaa jiru hordofi, kufaatii dura tapha keessaa baʼi.',
    'ውርርድ ምረጽ፣ ዝውስኽ ረቛሒ ተኸታተል፣ ቅድሚ ምውዳቕ ካብ ጸወታ ውጻእ።',
    'Dooro sharad, la soco isku-dhufashada koraysa, kana bax ka hor dhicitaanka.',
    'اختر مبلغ الرهان وتابع المضاعف الصاعد واخرج قبل الانهيار.',
    'Chagua dau, fuata kizidishi kinachopanda, na utoke kabla ya kuanguka.',
    'Choisissez une mise, suivez le multiplicateur croissant et encaissez avant le crash.'
  ),
  'Choose another fixture above, or minimize to return to your selections and ticket draft.': tr(
    'ከላይ ሌላ ግጥሚያ ይምረጡ፣ ወይም ወደ ምርጫዎችዎ እና የትኬት ረቂቅ ለመመለስ ያሳንሱ።',
    'Olitti tapha biraa filadhu, ykn gara filannoowwanii fi wixinee tikeetii keetti deebiʼuuf xiqqeessi.',
    'ኣብ ላዕሊ ካልእ ግጥም ምረጽ፣ ወይ ናብ ምርጫታትካን ረቂቕ ትኬትካን ንምምላስ ኣንእስ።',
    'Kor ka dooro kulan kale, ama yaree si aad ugu noqoto doorashooyinkaaga iyo qabyada tigidhka.',
    'اختر مباراة أخرى أعلاه، أو صغّر للعودة إلى اختياراتك ومسودة التذكرة.',
    'Chagua mechi nyingine hapo juu, au punguza ili urudi kwenye machaguo na rasimu ya tiketi yako.',
    'Choisissez une autre rencontre ci-dessus ou réduisez pour revenir à vos sélections et au brouillon du ticket.'
  ),
  'Club names are a visual theme for simulated matches, not real fixtures or player likenesses. Results are random and previous matches do not predict the next. Practice ETB have no monetary value.':
    tr(
      'የክለብ ስሞች የማስመሰያ ግጥሚያዎች ገጽታ ናቸው፣ እውነተኛ ግጥሚያዎች ወይም የተጫዋቾች ምስሎች አይደሉም። ውጤቶች ዘፈቀዳዊ ናቸው፣ ያለፉ ግጥሚያዎች ቀጣዩን አይተነብዩም። የልምምድ ETB የገንዘብ ዋጋ የላቸውም።',
      'Maqaan kilabootaa bifa taphoota fakkeeffamanii ti; tapha dhugaa ykn fakkii taphataa miti. Buʼaan carraan murtaaʼa; taphoonni darban itti aanu hin tilmaaman. ETB shaakalaa gatii maallaqaa hin qabu.',
      'ኣስማት ክለባት መልክዕ ዝተመሰሉ ግጥማት እዮም፣ ሓቀኛ ግጥማት ወይ ምስሊ ተጻወትቲ ኣይኮኑን። ውጽኢታት ብዕድል ይውሰኑ፣ ዝሓለፉ ግጥማት ቀጻሊ ኣይግምቱን። ETB ልምምድ ዋጋ ገንዘብ የብሉን።',
      'Magacyada kooxuhu waa muuqaal kulamo la matalay, ma aha kulamo dhab ah ama muuqaallo ciyaartoy. Natiijooyinku waa nasiib, kulamadii horena ma saadaaliyaan kan xiga. ETB tababarku qiime lacag dhab ah ma laha.',
      'أسماء الأندية طابع بصري لمباريات محاكاة، وليست مباريات حقيقية أو صورًا للاعبين. النتائج عشوائية والمباريات السابقة لا تتنبأ بالتالية. ETB التدريبي بلا قيمة نقدية.',
      'Majina ya klabu ni mandhari ya mechi za kuiga, si mechi halisi wala sura za wachezaji. Matokeo ni ya nasibu na mechi zilizopita hazitabiri inayofuata. ETB ya mazoezi haina thamani ya pesa halisi.',
      'Les noms de clubs habillent visuellement des matchs simulés, sans rencontres réelles ni représentation de joueurs. Les résultats sont aléatoires et les matchs précédents ne prédisent pas le suivant. Les ETB d’entraînement n’ont aucune valeur monétaire.'
    ),
  'Colors repeat every eight numbers: Red 1, 9, 17, 25, 33, 41; Green 2, 10, 18, 26, 34, 42; and so on through Pink 8, 16, 24, 32, 40, 48. All colors buys all eight six-number lines in one ticket.':
    tr(
      'ቀለሞች በየስምንት ቁጥሮች ይደገማሉ፦ ቀይ 1,9,17,25,33,41፤ አረንጓዴ 2,10,18,26,34,42፤ እንዲሁም እስከ ሮዝ 8,16,24,32,40,48። ሁሉም ቀለሞች ስምንቱንም ስድስት ቁጥር ያላቸውን መስመሮች በአንድ ትኬት ይገዛል።',
      'Halluun lakkoofsa saddeet saddeetiin deebiʼa: Diimaa 1,9,17,25,33,41; Magariisa 2,10,18,26,34,42; hanga Roosaa 8,16,24,32,40,48. Halluu hundi sararoota saddeet kan lakkoofsa jaʼaa tikeetii tokkoon bita.',
      'ሕብርታት ኣብ ነፍሲ ወከፍ ሸሞንተ ቁጽርታት ይድገሙ፦ ቀይሕ 1,9,17,25,33,41፤ ቀጠልያ 2,10,18,26,34,42፤ ክሳብ ሮዛ 8,16,24,32,40,48። ኩሎም ሕብርታት ንሸሞንተ ሽዱሽተ ቁጽሪ ዘለዎም መስመራት ብሓደ ትኬት ይዕድግ።',
      'Midabbadu siddeed lambar kasta ayay ku soo noqdaan: Casaan 1,9,17,25,33,41; Cagaar 2,10,18,26,34,42; ilaa Pink 8,16,24,32,40,48. Dhammaan midabbadu hal tigidh ayay ku iibsadaan dhammaan siddeedda sadar ee lixda lambar leh.',
      'تتكرر الألوان كل ثمانية أرقام: الأحمر 1،9،17،25،33،41؛ الأخضر 2،10،18،26،34،42؛ وهكذا حتى الوردي 8،16،24،32،40،48. خيار كل الألوان يشتري الأسطر الثمانية ذات الستة أرقام في تذكرة واحدة.',
      'Rangi hurudiwa kila nambari nane: Nyekundu 1,9,17,25,33,41; Kijani 2,10,18,26,34,42; hadi Waridi 8,16,24,32,40,48. Rangi zote hununua mistari yote minane ya nambari sita kwa tiketi moja.',
      'Les couleurs se répètent tous les huit numéros : rouge 1,9,17,25,33,41 ; vert 2,10,18,26,34,42 ; jusqu’au rose 8,16,24,32,40,48. Toutes les couleurs achète les huit lignes de six numéros dans un seul ticket.'
    ),
  'Common house-game rule: solo, shared and group play use the same payout table and 90% theoretical return. Group house games have no additional group fee. Pooled competitions are separate.':
    tr(
      'የጋራ የመድረክ ጨዋታ ደንብ፦ የግል፣ የተጋራ እና የቡድን ጨዋታ ተመሳሳይ የክፍያ ሰንጠረዥ እና 90% ንድፈ ሐሳባዊ ተመላሽ ይጠቀማሉ። የመድረክ ቡድን ጨዋታዎች ተጨማሪ የቡድን ክፍያ የላቸውም። የጋራ ሽልማት ውድድሮች የተለዩ ናቸው።',
      'Seera tapha waltajjii waliigalaa: dhuunfaa, waliin fi gareen gabatee kaffaltii tokkoo fi deebii tiyoorii 90% fayyadamu. Tapha waltajjii garee irratti kaffaltiin garee dabalataa hin jiru. Dorgommiin badhaasa walitti qabamee addaa dha.',
      'ሓባራዊ ሕጊ ጸወታ መድረኽ፦ ውልቃዊ፣ ሓባራዊን ጉጅለን ጸወታ ተመሳሳሊ ሰሌዳ ክፍሊትን 90% ቲዮራዊ ተመላስን ይጥቀሙ። ጸወታታት ጉጅለ መድረኽ ተወሳኺ ክፍሊት ጉጅለ የብሎምን። ናይ ሓባር ሽልማት ውድድራት ዝተፈልዩ እዮም።',
      'Xeerka guud ee ciyaaraha madasha: ciyaar keligiis, wadaag iyo koox waxay isticmaalaan isla jadwalka lacag-bixinta iyo 90% soo-noqosho aragtiyeed. Ciyaaraha kooxeed ee madashu ma laha khidmad kooxeed oo dheeraad ah. Tartamada barkadda abaalmarintu waa gooni.',
      'قاعدة مشتركة لألعاب المنصة: اللعب الفردي والمشترك والجماعي يستخدم جدول الدفع نفسه وعائدًا نظريًا 90%. لا رسوم جماعية إضافية لألعاب المنصة الجماعية. مسابقات الجوائز المجمعة منفصلة.',
      'Kanuni ya pamoja ya michezo ya jukwaa: mmoja, pamoja na kikundi hutumia jedwali moja la malipo na marejesho ya kinadharia 90%. Michezo ya kikundi ya jukwaa haina ada ya kikundi ya ziada. Mashindano ya zawadi zinazokusanywa ni tofauti.',
      'Règle commune des jeux de la plateforme : jeu solo, partagé et en groupe utilisent la même table de paiement et un retour théorique de 90 %. Aucun supplément de groupe. Les compétitions à cagnotte commune sont distinctes.'
    ),
  'Completed result. Your current ticket and cash-out target stay unchanged.': tr(
    'የተጠናቀቀ ውጤት። የአሁኑ ትኬትዎ እና የጨዋታ መውጫ ዒላማዎ አይቀየሩም።',
    'Buʼaa xumurame. Tikeetiin kee ammaa fi galmi tapha keessaa baʼuu hin jijjiiraman.',
    'ዝተዛዘመ ውጽኢት። ናይ ሕጂ ትኬትካን ዒላማ ምውጻእ ካብ ጸወታን ኣይቅየሩን።',
    'Natiijo dhammaystiran. Tigidhkaaga hadda iyo bartilmaameedka bixitaanku isma beddelaan.',
    'نتيجة مكتملة. تبقى تذكرتك الحالية وهدف الخروج دون تغيير.',
    'Matokeo yaliyokamilika. Tiketi yako ya sasa na lengo la kutoka havibadiliki.',
    'Résultat terminé. Votre ticket actuel et votre cible d’encaissement restent inchangés.'
  ),
  'Completed results and your confirmed practice bets.': tr(
    'የተጠናቀቁ ውጤቶች እና የተረጋገጡ የልምምድ ውርርዶችዎ።',
    'Buʼaawwan xumuramanii fi buusii shaakalaa kee mirkanaaʼan.',
    'ዝተዛዘሙ ውጽኢታትን ዝተረጋገጹ ውርርዳት ልምምድካን።',
    'Natiijooyinka dhammaaday iyo sharadyadaada tababar ee la xaqiijiyay.',
    'النتائج المكتملة ورهاناتك التدريبية المؤكدة.',
    'Matokeo yaliyokamilika na dau zako za mazoezi zilizothibitishwa.',
    'Résultats terminés et vos mises d’entraînement confirmées.'
  ),
  'Completed results · Tap a round for details. Previous rounds do not predict the next result.':
    tr(
      'የተጠናቀቁ ውጤቶች · ለዝርዝር ዙርን ይንኩ። ያለፉ ዙሮች ቀጣዩን ውጤት አይተነብዩም።',
      'Buʼaawwan xumuraman · Balʼinaaf marsaa tuqi. Marsaawwan darban buʼaa itti aanu hin tilmaaman.',
      'ዝተዛዘሙ ውጽኢታት · ንዝርዝር ዙር ጠውቕ። ዝሓለፉ ዙራት ቀጻሊ ውጽኢት ኣይግምቱን።',
      'Natiijooyin dhammaaday · Taabo wareeg si aad faahfaahin u aragto. Wareegyadii hore ma saadaaliyaan natiijada xigta.',
      'نتائج مكتملة · اضغط على جولة للتفاصيل. الجولات السابقة لا تتنبأ بالنتيجة التالية.',
      'Matokeo yaliyokamilika · Gusa raundi kwa maelezo. Raundi zilizopita hazitabiri matokeo yajayo.',
      'Résultats terminés · Touchez une manche pour les détails. Les manches précédentes ne prédisent pas le prochain résultat.'
    ),
  'Confirm once during the countdown. Your ticket stays saved after refresh.': tr(
    'በቆጠራው ጊዜ አንድ ጊዜ ያረጋግጡ። ገጹን ካደሱ በኋላ ትኬትዎ ተቀምጦ ይቆያል።',
    'Yeroo lakkoofsa yeroo keessatti al tokko mirkaneessi. Tikeetiin kee haaromsa booda olkaaʼamee tura.',
    'ኣብ ቆጸራ ግዜ ሓንሳብ ኣረጋግጽ። ትኬትካ ድሕሪ ምሕዳስ ተዓቂቡ ይጸንሕ።',
    'Hal mar xaqiiji inta tirintu socoto. Tigidhkaagu wuu kaydsanaanayaa marka la cusboonaysiiyo.',
    'أكّد مرة واحدة أثناء العد التنازلي. تبقى تذكرتك محفوظة بعد تحديث الصفحة.',
    'Thibitisha mara moja wakati wa hesabu ya muda. Tiketi yako hubaki imehifadhiwa baada ya kusasisha.',
    'Confirmez une fois pendant le compte à rebours. Votre ticket reste enregistré après actualisation.'
  ),
  'Confirm once. Watch the same roll as everyone at this table.': tr(
    'አንድ ጊዜ ያረጋግጡ። በዚህ ጠረጴዛ ያሉ ሁሉ የሚያዩትን ተመሳሳይ የዳይስ ውጤት ይመልከቱ።',
    'Al tokko mirkaneessi. Darbannaa namoota minjaala kanaa hundaa waliin ilaali.',
    'ሓንሳብ ኣረጋግጽ። ምስ ኩሎም ኣብዚ ጠረጴዛ ዘለዉ ተመሳሳሊ ዳይስ ርአ።',
    'Hal mar xaqiiji. Daawo isla rogista ay arkaan dhammaan dadka miiskan jooga.',
    'أكّد مرة واحدة. شاهد الرمية نفسها مع الجميع على هذه الطاولة.',
    'Thibitisha mara moja. Tazama mrusho mmoja na kila mtu mezani hapa.',
    'Confirmez une fois. Regardez le même lancer que tous les joueurs de cette table.'
  ),
  'Connection interrupted. Betting pauses until the table is up to date.': tr(
    'ግንኙነት ተቋርጧል። የጠረጴዛው መረጃ እስኪታደስ ድረስ ውርርድ ይቆማል።',
    'Walqunnamtiin citeera. Hanga minjaalli haaromfamutti buusiin dhaabbata.',
    'ርክብ ተቛሪጹ። ሓበሬታ ጠረጴዛ ክሳብ ዝሕደስ ውርርድ ይቖም።',
    'Xiriirkii wuu goʼay. Sharadku wuu joogsadaa ilaa xogta miisku cusboonaato.',
    'انقطع الاتصال. تتوقف الرهانات حتى تحديث الطاولة.',
    'Muunganisho umekatika. Dau husimama hadi taarifa za meza zisasishwe.',
    'Connexion interrompue. Les mises sont suspendues jusqu’à la mise à jour de la table.'
  ),
  'Connection interrupted. Entry and manual cash-out are paused until the server reconnects.': tr(
    'ግንኙነት ተቋርጧል። አገልጋዩ እስኪገናኝ ድረስ ተሳትፎ እና በእጅ ከጨዋታ መውጣት ቆመዋል።',
    'Walqunnamtiin citeera. Hanga sarvariin deebiʼee walqunnamutti hirmaannaa fi harkaan tapha keessaa baʼuun dhaabbateera.',
    'ርክብ ተቛሪጹ። ኣገልጋሊ ክሳብ ዳግም ዝራኸብ ምስታፍን ብኢድ ካብ ጸወታ ምውጻእን ተቛሪጾም።',
    'Xiriirkii wuu goʼay. Ka-qaybgalka iyo bixitaanka gacanta waa la hakiyay ilaa seerfarku dib u xirmo.',
    'انقطع الاتصال. المشاركة والخروج اليدوي متوقفان حتى إعادة الاتصال بالخادم.',
    'Muunganisho umekatika. Kujiunga na kutoka mwenyewe vimesimamishwa hadi seva iunganishwe tena.',
    'Connexion interrompue. La participation et l’encaissement manuel sont suspendus jusqu’à la reconnexion au serveur.'
  ),
  'Connection interrupted. Selections are paused until the game status refreshes.': tr(
    'ግንኙነት ተቋርጧል። የጨዋታ ሁኔታ እስኪታደስ ድረስ ምርጫዎች ቆመዋል።',
    'Walqunnamtiin citeera. Hanga haalli taphaa haaromfamutti filannoon dhaabbata.',
    'ርክብ ተቛሪጹ። ኩነታት ጸወታ ክሳብ ዝሕደስ ምርጫታት ተቛሪጾም።',
    'Xiriirkii wuu goʼay. Doorashooyinka waa la hakiyay ilaa xaaladda ciyaarta la cusboonaysiiyo.',
    'انقطع الاتصال. الاختيارات متوقفة حتى تحديث حالة اللعبة.',
    'Muunganisho umekatika. Machaguo yamesimamishwa hadi hali ya mchezo isasishwe.',
    'Connexion interrompue. Les sélections sont suspendues jusqu’à l’actualisation de l’état du jeu.'
  ),
  'Connection lost? Your confirmed selection still settles on the server. Reconnect to retrieve its result. Unconfirmed selections are never carried into a later race.':
    tr(
      'ግንኙነት ጠፋ? የተረጋገጠው ምርጫዎ በአገልጋዩ ላይ ይጠናቀቃል። ውጤቱን ለማግኘት እንደገና ይገናኙ። ያልተረጋገጡ ምርጫዎች ወደ ቀጣይ ውድድር አይተላለፉም።',
      'Walqunnamtiin bade? Filannoon kee mirkanaaʼe sarvarii irratti ni xumurama. Buʼaa isaa argachuuf deebiʼii walqunnami. Filannoowwan hin mirkanoofne gara fiigicha boodaa hin darbani.',
      'ርክብ ጠፊኡ? ዝተረጋገጸ ምርጫኻ ኣብ ኣገልጋሊ ይወዳእ። ውጽኢቱ ንምርካብ ዳግም ተራኸብ። ዘይተረጋገጹ ምርጫታት ናብ ቀጻሊ ውድድር ኣይሰጋገሩን።',
      'Xiriirku ma lumay? Doorashadaada la xaqiijiyay weli seerfarka ayay ku dhammaanaysaa. Dib u xirmo si aad natiijadeeda u hesho. Doorashooyinka aan la xaqiijin marna looma gudbiyo tartan dambe.',
      'فُقد الاتصال؟ يستمر حسم اختيارك المؤكد على الخادم. أعد الاتصال لاسترجاع نتيجته. لا تُنقل الاختيارات غير المؤكدة إلى سباق لاحق أبدًا.',
      'Muunganisho umepotea? Chaguo lako lililothibitishwa bado linakamilishwa kwenye seva. Unganisha tena kupata matokeo. Machaguo yasiyothibitishwa hayahamishiwi kamwe kwenye mbio zinazofuata.',
      'Connexion perdue ? Votre sélection confirmée est tout de même réglée sur le serveur. Reconnectez-vous pour récupérer son résultat. Les sélections non confirmées ne sont jamais reportées à une course ultérieure.'
    ),
};
export default catalogue;
