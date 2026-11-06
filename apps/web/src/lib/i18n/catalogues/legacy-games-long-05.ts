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
  'Resolve your unconfirmed ticket to add more selections.': tr(
    'ተጨማሪ ምርጫዎችን ለመጨመር ያልተረጋገጠውን ትኬትዎን ያጠናቅቁ።',
    'Filannoo dabalataa galchuuf tikeetii kee hin mirkanoofne xumuri.',
    'ተወሳኺ ምርጫታት ንምውሳኽ ዘይተረጋገጸ ትኬትካ ወድእ።',
    'Xalli tigidhkaaga aan la xaqiijin si aad doorashooyin kale ugu darto.',
    'احسم تذكرتك غير المؤكدة لإضافة اختيارات أخرى.',
    'Tatua tiketi yako isiyothibitishwa ili kuongeza machaguo.',
    'Résolvez votre ticket non confirmé pour ajouter des sélections.'
  ),
  'Response bytes included · timestamp signature not verified here': tr(
    'የምላሽ ባይቶች ተካትተዋል · የጊዜ ማህተም ፊርማ እዚህ አልተረጋገጠም',
    'Baayitii deebii dabalame · mallattoon yeroo asitti hin mirkanoofne',
    'ባይታት መልሲ ተሓዊሶም · ፊርማ ማሕተም ግዜ ኣብዚ ኣይተረጋገጸን',
    'Baytyada jawaabta waa lagu daray · saxiixa waqtiga halkan laguma xaqiijin',
    'بايتات الاستجابة مضمّنة · توقيع الطابع الزمني غير متحقق منه هنا',
    'Baiti za jibu zimejumuishwa · saini ya muhuri wa muda haijathibitishwa hapa',
    'Octets de réponse inclus · signature de l’horodatage non vérifiée ici'
  ),
  'Result revealed. Tap a result in the round history above to verify it.': tr(
    'ውጤቱ ተገልጧል። ለማረጋገጥ ከላይ ባለው የዙር ታሪክ ውጤትን ይንኩ።',
    'Buʼaan mulʼateera. Mirkaneessuuf seenaa marsaa armaan olii keessaa buʼaa tuqi.',
    'ውጽኢት ተገሊጹ። ንምርግጋጽ ኣብ ላዕሊ ታሪኽ ዙር ውጽኢት ጠውቕ።',
    'Natiijada waa la muujiyay. Taabo natiijo ku jirta taariikhda wareegyada ee kore si aad u xaqiijiso.',
    'كُشفت النتيجة. اضغط على نتيجة في سجل الجولات أعلاه للتحقق منها.',
    'Matokeo yameonyeshwa. Gusa matokeo katika historia ya raundi hapo juu kuyathibitisha.',
    'Résultat révélé. Touchez un résultat dans l’historique ci-dessus pour le vérifier.'
  ),
  'Result revealed. Verify it using the round history above.': tr(
    'ውጤቱ ተገልጧል። ከላይ ያለውን የዙር ታሪክ በመጠቀም ያረጋግጡት።',
    'Buʼaan mulʼateera. Seenaa marsaa armaan olii fayyadamuun mirkaneessi.',
    'ውጽኢት ተገሊጹ። ናይ ላዕሊ ታሪኽ ዙር ተጠቒምካ ኣረጋግጾ።',
    'Natiijada waa la muujiyay. Ku xaqiiji taariikhda wareegyada ee kore.',
    'كُشفت النتيجة. تحقّق منها عبر سجل الجولات أعلاه.',
    'Matokeo yameonyeshwa. Yathibitishe kwa historia ya raundi hapo juu.',
    'Résultat révélé. Vérifiez-le dans l’historique des manches ci-dessus.'
  ),
  'Results will appear after the first completed roll.': tr(
    'ውጤቶች ከመጀመሪያው የተጠናቀቀ የዳይስ ዙር በኋላ ይታያሉ።',
    'Buʼaan darbannaa jalqabaa xumurame booda mulʼata.',
    'ውጽኢታት ድሕሪ ቀዳማይ ዝተዛዘመ ምድርባይ ዳይስ ይርኣዩ።',
    'Natiijooyinku waxay muuqdaan rogista koowaad ee dhammaatay ka dib.',
    'تظهر النتائج بعد اكتمال الرمية الأولى.',
    'Matokeo yataonekana baada ya mrusho wa kwanza kukamilika.',
    'Les résultats apparaîtront après le premier lancer terminé.'
  ),
  'Returns appear only after server settlement. Amounts are practice ETB.': tr(
    'ተመላሾች በአገልጋዩ ክፍያ ከተጠናቀቀ በኋላ ብቻ ይታያሉ። መጠኖች የልምምድ ETB ናቸው።',
    'Deebiin sarvariin kaffaltii erga xumuree booda qofa mulʼata. Maallaqni ETB shaakalaa dha.',
    'ተመላሲታት ኣገልጋሊ ክፍሊት ድሕሪ ምውዳኡ ጥራይ ይርኣዩ። መጠናት ETB ልምምድ እዮም።',
    'Soo-noqoshadu waxay muuqataa keliya marka seerfarku bixinta dhammeeyo. Qaddarradu waa ETB tababar.',
    'تظهر العوائد بعد تسوية الخادم فقط. المبالغ بـETB التدريبي.',
    'Marejesho huonekana tu baada ya seva kukamilisha malipo. Kiasi ni ETB ya mazoezi.',
    'Les retours apparaissent seulement après règlement du serveur. Les montants sont en ETB d’entraînement.'
  ),
  'Returns go to your practice balance automatically.': tr(
    'ተመላሾች በራስ-ሰር ወደ የልምምድ ሂሳብዎ ይገባሉ።',
    'Deebiin ofumaan gara haftee shaakala keetti gala.',
    'ተመላሲታት ብርእሶም ናብ ሒሳብ ልምምድካ ይኣትዉ።',
    'Soo-noqoshadu si toos ah ayay ugu dhacdaa haraaga tababarkaaga.',
    'تُضاف العوائد تلقائيًا إلى رصيدك التدريبي.',
    'Marejesho huingia kwenye salio lako la mazoezi kiotomatiki.',
    'Les retours sont automatiquement versés à votre solde d’entraînement.'
  ),
  'Returns include the original stake. A 35 ETB win returns 54 ETB: 19 ETB net.': tr(
    'ተመላሾች የመጀመሪያውን ውርርድ ያካትታሉ። የ 35 ETB ውርርድ ሲያሸንፍ 54 ETB ይመልሳል፦ 19 ETB የተጣራ ትርፍ።',
    'Deebiin buusii jalqabaa dabalata. Moʼannaan 35 ETB deebii 54 ETB qaba: buʼaa qulqulluu 19 ETB.',
    'ተመላሲታት ቀዳማይ ውርርድ ይሓውሱ። ውርርድ 35 ETB እንተተዓዊቱ 54 ETB ይመልስ፦ ጽሩይ ረብሓ 19 ETB።',
    'Soo-noqoshadu sharadkii hore way ku jirtaa. Guul 35 ETB ah waxay soo celisaa 54 ETB: faaʼiido saafi ah 19 ETB.',
    'تشمل العوائد الرهان الأصلي. فوز برهان 35 ETB يعيد 54 ETB: صافي 19 ETB.',
    'Marejesho yanajumuisha dau la awali. Ushindi wa 35 ETB hurudisha 54 ETB: faida halisi 19 ETB.',
    'Les retours incluent la mise initiale. Une mise gagnante de 35 ETB rapporte 54 ETB : 19 ETB nets.'
  ),
  'Returns include the stake and settle after ball 35. Practice ETB has no cash value.': tr(
    'ተመላሾች ውርርዱን ያካትታሉ፣ ከኳስ 35 በኋላ ይከፈላሉ። የልምምድ ETB የገንዘብ ዋጋ የለውም።',
    'Deebiin buusii dabalatee kubbaa 35 booda kaffalama. ETB shaakalaa gatii maallaqaa hin qabu.',
    'ተመላሲታት ውርርድ ይሓውሱ፣ ድሕሪ ኩዕሶ 35 ይኽፈሉ። ETB ልምምድ ዋጋ ገንዘብ የብሉን።',
    'Soo-noqoshadu sharadka way ku jirtaa waxaana la bixiyaa kubbadda 35 ka dib. ETB tababarku qiime lacag ma laha.',
    'تشمل العوائد الرهان وتُسوّى بعد الكرة 35. ETB التدريبي بلا قيمة نقدية.',
    'Marejesho yanajumuisha dau na hulipwa baada ya mpira 35. ETB ya mazoezi haina thamani ya pesa halisi.',
    'Les retours incluent la mise et sont réglés après la boule 35. L’ETB d’entraînement n’a aucune valeur monétaire.'
  ),
  'Returns include the stake. Practice ETB has no cash value.': tr(
    'ተመላሾች ውርርዱን ያካትታሉ። የልምምድ ETB የገንዘብ ዋጋ የለውም።',
    'Deebiin buusii dabalata. ETB shaakalaa gatii maallaqaa hin qabu.',
    'ተመላሲታት ውርርድ ይሓውሱ። ETB ልምምድ ዋጋ ገንዘብ የብሉን።',
    'Soo-noqoshadu sharadka way ku jirtaa. ETB tababarku qiime lacag ma laha.',
    'تشمل العوائد الرهان. ETB التدريبي بلا قيمة نقدية.',
    'Marejesho yanajumuisha dau. ETB ya mazoezi haina thamani ya pesa halisi.',
    'Les retours incluent la mise. L’ETB d’entraînement n’a aucune valeur monétaire.'
  ),
  'Returns include your stake. The server credits the result once.': tr(
    'ተመላሾች ውርርድዎን ያካትታሉ። አገልጋዩ ውጤቱን አንድ ጊዜ ብቻ ወደ ሂሳብ ያስገባል።',
    'Deebiin buusii kee dabalata. Sarvariin buʼaa al tokko qofa herregatti galcha.',
    'ተመላሲታት ውርርድካ ይሓውሱ። ኣገልጋሊ ውጽኢት ሓንሳብ ጥራይ ናብ ሒሳብ የእቱ።',
    'Soo-noqoshadu sharadkaaga way ku jirtaa. Seerfarku natiijada hal mar ayuu koontada ku daraa.',
    'تشمل العوائد رهانك. يضيف الخادم النتيجة إلى الرصيد مرة واحدة.',
    'Marejesho yanajumuisha dau lako. Seva huongeza matokeo kwenye salio mara moja.',
    'Les retours incluent votre mise. Le serveur crédite le résultat une seule fois.'
  ),
  'Review the total return and confirm before the race starts. One selection per race; confirmed choices cannot be changed.':
    tr(
      'ጠቅላላ ተመላሹን ይገምግሙ፣ ውድድሩ ከመጀመሩ በፊት ያረጋግጡ። በውድድር አንድ ምርጫ፤ የተረጋገጡ ምርጫዎች አይቀየሩም።',
      'Deebii waliigalaa ilaali, fiigichi jalqabuu dura mirkaneessi. Fiigicha tokkoof filannoo tokko; filannoon mirkanaaʼe hin jijjiiramu.',
      'ጠቕላላ ተመላሲ ገምግም፣ ውድድር ቅድሚ ምጅማሩ ኣረጋግጽ። ንውድድር ሓደ ምርጫ፤ ዝተረጋገጹ ምርጫታት ኣይቅየሩን።',
      'Dib u eeg wadarta soo-noqoshada oo xaqiiji ka hor bilaabashada tartanka. Hal doorasho tartan kasta; doorasho la xaqiijiyay lama beddeli karo.',
      'راجع إجمالي العائد وأكّد قبل بدء السباق. اختيار واحد لكل سباق؛ لا يمكن تعديل الاختيارات المؤكدة.',
      'Kagua jumla ya marejesho na uthibitishe kabla ya mbio kuanza. Chaguo moja kwa mbio; yaliyothibitishwa hayawezi kubadilishwa.',
      'Vérifiez le retour total et confirmez avant le départ. Une sélection par course ; les choix confirmés sont non modifiables.'
    ),
  'Review your practice selection. A confirmed bet cannot be changed.': tr(
    'የልምምድ ምርጫዎን ይገምግሙ። የተረጋገጠ ውርርድ መቀየር አይቻልም።',
    'Filannoo shaakala kee ilaali. Buusiin mirkanaaʼe hin jijjiiramu.',
    'ምርጫ ልምምድካ ገምግም። ዝተረጋገጸ ውርርድ ኣይቅየርን።',
    'Dib u eeg doorashadaada tababarka. Sharad la xaqiijiyay lama beddeli karo.',
    'راجع اختيارك التدريبي. لا يمكن تعديل رهان مؤكد.',
    'Kagua chaguo lako la mazoezi. Dau lililothibitishwa haliwezi kubadilishwa.',
    'Vérifiez votre sélection d’entraînement. Une mise confirmée ne peut pas être modifiée.'
  ),
  'Review your selection and price. Confirmed bets cannot be changed.': tr(
    'ምርጫዎን እና ዋጋውን ይገምግሙ። የተረጋገጡ ውርርዶች አይቀየሩም።',
    'Filannoo fi gatii kee ilaali. Buusiiwwan mirkanaaʼan hin jijjiiraman.',
    'ምርጫኻን ዋጋን ገምግም። ዝተረጋገጹ ውርርዳት ኣይቅየሩን።',
    'Dib u eeg doorashadaada iyo qiimaha. Sharadyo la xaqiijiyay lama beddeli karo.',
    'راجع اختيارك وسعره. لا يمكن تعديل الرهانات المؤكدة.',
    'Kagua chaguo na bei yako. Dau zilizothibitishwa haziwezi kubadilishwa.',
    'Vérifiez votre sélection et sa cote. Les mises confirmées sont non modifiables.'
  ),
  'Round history and My bets cover the latest 12 rounds. Top shows the highest confirmed returns in the last 24 hours. Previous results cannot predict the next round.':
    tr(
      'የዙር ታሪክ እና የእኔ ውርርዶች የመጨረሻ 12 ዙሮችን ይሸፍናሉ። ከፍተኛ ባለፉት 24 ሰዓታት የተረጋገጡ ከፍተኛ ተመላሾችን ያሳያል። ያለፉ ውጤቶች ቀጣዩን ዙር ሊተነብዩ አይችሉም።',
      'Seenaa marsaa fi Buusii koo marsaa 12 dhumaa hammatu. Olaanaan saʼaatii 24 darban keessatti deebii mirkanaaʼe olaanaa agarsiisa. Buʼaan darbe marsaa itti aanu tilmaamuu hin dandaʼu.',
      'ታሪኽ ዙርን ውርርዳተይን ናይ መወዳእታ 12 ዙራት ይሓውሱ። ዝለዓሉ ኣብ ዝሓለፉ 24 ሰዓታት ዝተረጋገጹ ዝለዓሉ ተመላሲታት የርኢ። ዝሓለፉ ውጽኢታት ቀጻሊ ዙር ክግምቱ ኣይክእሉን።',
      'Taariikhda wareegga iyo Sharadyadayda waxay daboolaan 12-kii wareeg ee u dambeeyay. Ugu sarreeya wuxuu muujinayaa soo-noqoshada la xaqiijiyay ee ugu sarreysa 24-kii saac ee u dambeeyay. Natiijooyinkii hore ma saadaalin karaan wareegga xiga.',
      'سجل الجولات ورهاناتي يغطيان آخر 12 جولة. تعرض القمة أعلى العوائد المؤكدة خلال آخر 24 ساعة. النتائج السابقة لا تتنبأ بالجولة التالية.',
      'Historia ya raundi na Dau zangu huonyesha raundi 12 za mwisho. Bora huonyesha marejesho makubwa yaliyothibitishwa katika saa 24 zilizopita. Matokeo yaliyopita hayawezi kutabiri raundi inayofuata.',
      'L’historique et Mes mises couvrent les 12 dernières manches. Le classement montre les plus grands retours confirmés des dernières 24 heures. Les résultats passés ne prédisent pas la prochaine manche.'
    ),
  "Rows: A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Columns: 1–18, 19–36, 37–54, 55–72. The board shows each number's red or black color.":
    tr(
      'ረድፎች፦ A 1–12፣ B 13–24፣ C 25–36፣ D 37–48፣ E 49–60፣ F 61–72። አምዶች፦1–18፣19–36፣37–54፣55–72። ሰሌዳው የእያንዳንዱን ቁጥር ቀይ ወይም ጥቁር ቀለም ያሳያል።',
      'Tarree: A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Tarjaa:1–18,19–36,37–54,55–72. Gabateen halluu diimaa ykn gurraacha lakkoofsa hundaa agarsiisa.',
      'መስርዓት፦ A 1–12፣ B 13–24፣ C 25–36፣ D 37–48፣ E 49–60፣ F 61–72። ዓምድታት፦1–18፣19–36፣37–54፣55–72። ሰሌዳ ቀይሕ ወይ ጸሊም ሕብሪ ነፍሲ ወከፍ ቁጽሪ የርኢ።',
      'Safafka: A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Tiirarka:1–18,19–36,37–54,55–72. Looxu wuxuu muujinayaa midabka cas ama madow ee lambar kasta.',
      'الصفوف: A 1–12، B 13–24، C 25–36، D 37–48، E 49–60، F 61–72. الأعمدة: 1–18، 19–36، 37–54، 55–72. تعرض اللوحة لون كل رقم، أحمر أو أسود.',
      'Safu: A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Nguzo:1–18,19–36,37–54,55–72. Ubao huonyesha rangi nyekundu au nyeusi ya kila nambari.',
      'Lignes : A 1–12, B 13–24, C 25–36, D 37–48, E 49–60, F 61–72. Colonnes : 1–18, 19–36, 37–54, 55–72. Le plateau indique le rouge ou le noir de chaque numéro.'
    ),
  'Rules: {NUMBER_TIMED_RULES_ID}. Original Salem Bet game, not affiliated with 1xBet.': tr(
    'ደንቦች፦ {NUMBER_TIMED_RULES_ID}። የሳሌም ቤት ኦሪጅናል ጨዋታ፣ ከ1xBet ጋር ግንኙነት የለውም።',
    'Seerota: {NUMBER_TIMED_RULES_ID}. Tapha Salem Bet jalqabaa, 1xBet waliin hidhata hin qabu.',
    'ሕግታት፦ {NUMBER_TIMED_RULES_ID}። ኦሪጅናል ጸወታ ሳሌም ቤት፣ ምስ1xBet ዝምድና የብሉን።',
    'Xeerarka: {NUMBER_TIMED_RULES_ID}. Ciyaar asal ah oo Salem Bet, xiriir lama laha 1xBet.',
    'القواعد: {NUMBER_TIMED_RULES_ID}. لعبة أصلية من Salem Bet، غير تابعة لـ1xBet.',
    'Kanuni: {NUMBER_TIMED_RULES_ID}. Mchezo asili wa Salem Bet, hauhusiani na 1xBet.',
    'Règles : {NUMBER_TIMED_RULES_ID}. Jeu original Salem Bet, sans affiliation avec 1xBet.'
  ),
  "Salem's original practice game. Pick numbers or a first-ball market before the countdown ends.":
    tr(
      'የሳሌም ኦሪጅናል የልምምድ ጨዋታ። ቆጠራው ከማለቁ በፊት ቁጥሮችን ወይም የመጀመሪያ ኳስ ገበያ ይምረጡ።',
      'Tapha shaakalaa Salem jalqabaa. Lakkoofsa ykn gabaa kubbaa jalqabaa lakkoofsi yeroo dhumuu dura filadhu.',
      'ኦሪጅናል ጸወታ ልምምድ ሳሌም። ቆጸራ ግዜ ቅድሚ ምውዳኡ ቁጽርታት ወይ ዕዳጋ ቀዳማይ ኩዕሶ ምረጽ።',
      'Ciyaarta tababarka asalka ah ee Salem. Dooro lambarro ama suuqa kubbadda koowaad ka hor inta tirintu dhammaan.',
      'لعبة تدريب أصلية من سالم. اختر أرقامًا أو سوق الكرة الأولى قبل انتهاء العد التنازلي.',
      'Mchezo asili wa mazoezi wa Salem. Chagua nambari au soko la mpira wa kwanza kabla ya muda kuisha.',
      'Jeu d’entraînement original de Salem. Choisissez des numéros ou un marché de première boule avant la fin du compte à rebours.'
    ),
  "Salem's original practice rules. Choose your bets before the countdown closes.": tr(
    'የሳሌም መሠረታዊ የልምምድ ደንቦች። ቆጠራው ከማለቁ በፊት ውርርዶችዎን ይምረጡ።',
    'Seerota shaakalaa Salem jalqabaa. Buusii kee lakkoofsi yeroo dhumuu dura filadhu.',
    'መሰረታዊ ሕግታት ልምምድ ሳሌም። ቆጸራ ግዜ ቅድሚ ምውዳኡ ውርርዳትካ ምረጽ።',
    'Xeerarka tababarka asalka ah ee Salem. Dooro sharadyadaada ka hor inta tirintu xidhmin.',
    'قواعد تدريب أصلية من سالم. اختر رهاناتك قبل انتهاء العد التنازلي.',
    'Kanuni asili za mazoezi za Salem. Chagua dau zako kabla ya muda kuisha.',
    'Règles d’entraînement originales de Salem. Choisissez vos mises avant la fin du compte à rebours.'
  ),
  'Save a commitment receipt before joining a future financial round, then compare it after the draw. Retain an independent dated copy if you need evidence of when you observed it. The receipt hash identifies its terms; it is not an operator signature or trusted timestamp.':
    tr(
      'የወደፊት የገንዘብ ዙር ከመቀላቀልዎ በፊት የቅድመ ማረጋገጫ ደረሰኝ ያስቀምጡ፣ ከዕጣው በኋላም ያነጻጽሩት። መቼ እንዳዩት ማስረጃ ከፈለጉ ቀን ያለው ገለልተኛ ቅጂ ይያዙ። የደረሰኙ ሃሽ ውሎቹን ይለያል፤ የአስተዳዳሪ ፊርማ ወይም የታመነ የጊዜ ማህተም አይደለም።',
      'Marsaa maallaqaa fuulduraa hirmaachuu dura nagahee ragaa duraa olkaaʼi, carraan erga baʼee booda walbira qabi. Ragaa yeroo itti argite barbaadde koppii guyyaa qabu walaba qabaadhu. Haashiin nagahee haalawwan isaa adda baasa; mallattoo dhiyeessaa ykn ragaa yeroo amanamaa miti.',
      'ቅድሚ ናብ መጻኢ ዙር ገንዘብ ምስታፍካ ቅብሊት ቅድመ መረጋገጺ ዓቅብ፣ ድሕሪ ዕጣ ኣነጻጽሮ። መዓስ ከም ዝረኣኻዮ መርትዖ እንተደሊኻ ዕለት ዘለዎ ናጻ ቅዳሕ ዓቅብ። ሃሽ ቅብሊት ውዕላቱ ይለሊ፤ ፊርማ ኣመሓዳሪ ወይ እሙን ማሕተም ግዜ ኣይኮነን።',
      'Kaydi rasiidka xaqiijinta hore ka hor inta aadan ku biirin wareeg lacag mustaqbal ah, ka dibna barbar dhig isku-aadka ka dib. Hayso nuqul madax-bannaan oo taariikhaysan haddii aad u baahan tahay caddayn waqtigii aad aragtay. Hash-ka rasiidku wuxuu aqoonsadaa shuruudihiisa; ma aha saxiixa maamulaha ama shaabad waqti oo la aamini karo.',
      'احفظ إيصال الالتزام قبل الانضمام إلى جولة مالية مستقبلية، ثم قارنه بعد السحب. احتفظ بنسخة مستقلة مؤرخة إذا احتجت دليلًا على وقت مشاهدتك. تجزئة الإيصال تعرّف شروطه؛ وليست توقيع المشغّل أو طابعًا زمنيًا موثوقًا.',
      'Hifadhi risiti ya uthibitisho wa awali kabla ya kujiunga na raundi ya fedha ya baadaye, kisha linganisha baada ya droo. Hifadhi nakala huru yenye tarehe ikiwa unahitaji ushahidi wa ulipoiona. Hashi ya risiti hutambua masharti yake; si saini ya mwendeshaji wala muhuri wa muda unaoaminika.',
      'Enregistrez un reçu d’engagement avant de rejoindre une future manche financière, puis comparez-le après le tirage. Gardez une copie indépendante datée pour prouver quand vous l’avez observé. Le hachage du reçu identifie ses conditions ; ce n’est ni une signature de l’opérateur ni un horodatage fiable.'
    ),
  'Seed commitment, beacon signature and draw agree.': tr(
    'የመነሻ እሴት ቅድመ ማረጋገጫ፣ የዘፈቀዳዊ ምልክት ፊርማ እና ዕጣ ተዛምደዋል።',
    'Ragaan duraa sanyii, mallattoon ifaa carraa fi carraan baʼe wal simu.',
    'ቅድመ መረጋገጺ መበገሲ ክብሪ፣ ፊርማ ዘፈቀዳዊ ምልክትን ዕጣን ይዛመዱ።',
    'Xaqiijinta abuurka, saxiixa calaamadda nasiibka iyo isku-aadku way is waafaqaan.',
    'التزام البذرة وتوقيع المنارة والسحب متطابقة.',
    'Uthibitisho wa mbegu, saini ya ishara na droo vinalingana.',
    'L’engagement de graine, la signature de balise et le tirage concordent.'
  ),
  'Select 1–10 numbers. Choose a stake in steps of 5 for each selected number. A matching number returns 3.6× its stake (18 for every 5 credits) if included among the 20 drawn numbers. Returns include the stake on that number. Every draw has 20 different numbers from 1–80.':
    tr(
      '1–10 ቁጥሮችን ይምረጡ። ለእያንዳንዱ ቁጥር በ 5 ደረጃዎች ውርርድ ይምረጡ። ከ 20 የወጡ ቁጥሮች ውስጥ ከተካተተ ተዛማጅ ቁጥር 3.6× ውርርዱን (ለ 5 ክሬዲቶች 18) ይመልሳል። ተመላሾች በዚያ ቁጥር ያለውን ውርርድ ያካትታሉ። እያንዳንዱ ዕጣ ከ 1–80 20 የተለያዩ ቁጥሮች አሉት።',
      'Lakkoofsota 1–10 filadhu. Tokkoon tokkoon lakkoofsa filatameef buusii tarkaanfii 5 filadhu. Lakkoofsi walsimu lakkoofsota 20 baʼan keessatti yoo jiraate buusii isaa 3.6× (qabxii 5 hundaaf 18) deebisa. Deebiin buusii lakkoofsa sanaa dabalata. Carraa hundatti lakkoofsa adda addaa 20 kan 1–80 keessa jiru baʼa.',
      '1–10 ቁጽርታት ምረጽ። ንነፍሲ ወከፍ ዝተመርጸ ቁጽሪ ብ 5 ደረጃታት ውርርድ ምረጽ። ዝተዛመደ ቁጽሪ ኣብ 20 ዝወጹ ቁጽርታት እንተኾይኑ 3.6× ውርርዱ (ን 5 ክሬዲት 18) ይመልስ። ተመላሲታት ናይቲ ቁጽሪ ውርርድ ይሓውሱ። ነፍሲ ወከፍ ዕጣ ካብ 1–80 20 ዝተፈላለዩ ቁጽርታት ኣለዎ።',
      'Dooro 1–10 lambar. Lambar kasta oo la doortay u dooro sharad tallaabooyin 5 ah. Lambar is-waafaqa wuxuu soo celiyaa 3.6× sharadkiisa (18 shantii dhibcood) haddii uu ka mid yahay 20-ka lambar ee la soo saaray. Soo-noqoshadu sharadka lambarkaas way ku jirtaa. Isku-aad kastaa wuxuu leeyahay 20 lambar oo kala duwan oo 1–80 ah.',
      'اختر 1–10 أرقام. اختر رهانًا بزيادات 5 لكل رقم. الرقم المطابق يعيد 3.6× رهانه (18 لكل 5 أرصدة) إذا كان ضمن الأرقام العشرين المسحوبة. تشمل العوائد رهان ذلك الرقم. يحتوي كل سحب على 20 رقمًا مختلفًا من 1–80.',
      'Chagua nambari 1–10. Weka dau kwa hatua za 5 kwa kila nambari. Nambari inayolingana hurudisha 3.6× dau lake (18 kwa kila vitengo 5) ikiwa imo katika nambari 20 zilizotolewa. Marejesho yanajumuisha dau la nambari hiyo. Kila droo ina nambari 20 tofauti kutoka 1–80.',
      'Sélectionnez 1–10 numéros. Choisissez une mise par paliers de 5 pour chaque numéro. Un numéro correspondant rapporte 3,6× sa mise (18 pour 5 crédits) s’il figure parmi les 20 numéros tirés. Le retour inclut sa mise. Chaque tirage comporte 20 numéros différents parmi 1–80.'
    ),
  'Selections are closed for this matchweek. The next one opens soon.': tr(
    'ለዚህ የግጥሚያ ሳምንት ምርጫዎች ተዘግተዋል። ቀጣዩ በቅርቡ ይከፈታል።',
    'Filannoon torban taphaa kanaaf cufameera. Inni itti aanu dhiheenyatti ni banama.',
    'ናይዚ ሰሙን ግጥማት ምርጫታት ተዓጽዮም። ቀጻሊ ኣብ ቀረባ ይኽፈት።',
    'Doorashooyinka usbuucan kulamada way xirmeen. Kan xiga dhowaan ayuu furmayaa.',
    'اختيارات أسبوع المباريات هذا مغلقة. يُفتح التالي قريبًا.',
    'Machaguo ya wiki hii ya mechi yamefungwa. Inayofuata itafunguliwa karibuni.',
    'Les sélections de cette journée sont fermées. La suivante ouvre bientôt.'
  ),
  'Selections are paused while the connection recovers.': tr(
    'ግንኙነት እስኪመለስ ድረስ ምርጫዎች ቆመዋል።',
    'Hanga walqunnamtiin deebiʼutti filannoon dhaabbateera.',
    'ርክብ ክሳብ ዝምለስ ምርጫታት ተቛሪጾም።',
    'Doorashooyinka waa la hakiyay inta xiriirku soo kabanayo.',
    'الاختيارات متوقفة حتى استعادة الاتصال.',
    'Machaguo yamesimamishwa wakati muunganisho unarejeshwa.',
    'Les sélections sont suspendues pendant la reconnexion.'
  ),
  'Server practice · No deposits or redeemable prizes · 45 seconds to enter, 15 seconds for results':
    tr(
      'በአገልጋይ ልምምድ · ተቀማጭ ወይም ሊቀየሩ የሚችሉ ሽልማቶች የሉም · ለመሳተፍ 45 ሰከንዶች፣ ለውጤት 15 ሰከንዶች',
      'Shaakala sarvaraa · Maallaqa galchuu ykn badhaasa jijjiiramu hin qabu · Hirmaachuuf sekondii 45, buʼaaf sekondii 15',
      'ልምምድ ኣገልጋሊ · ተቐማጢ ወይ ዝልወጥ ሽልማት የለን · ንምስታፍ 45 ካልኢታት፣ ንውጽኢት 15 ካልኢታት',
      'Tababar seerfar · Dhigaal ama abaalmarin la sarifan karo ma jiro · 45 ilbiriqsi oo gelitaan, 15 ilbiriqsi oo natiijo',
      'تدريب على الخادم · بلا إيداعات أو جوائز قابلة للاستبدال · 45 ثانية للمشاركة و 15 ثانية للنتائج',
      'Mazoezi ya seva · Hakuna amana au zawadi zinazokombolewa · Sekunde 45 kujiunga, sekunde 15 za matokeo',
      'Entraînement sur serveur · Aucun dépôt ni prix échangeable · 45 secondes pour participer, 15 secondes de résultats'
    ),
  'Set an amount and optional auto cash-out target. Each panel is independent and shares the practice balance.':
    tr(
      'መጠን እና አማራጭ ራስ-ሰር የጨዋታ መውጫ ዒላማ ያዘጋጁ። እያንዳንዱ ፓነል ገለልተኛ ሲሆን የልምምድ ሂሳቡን ይጋራል።',
      'Maallaqa fi galma ofumaan baʼuu filannoo taʼe kaaʼi. Paanaaliin hundi walaba, haftee shaakalaa waliin qooddata.',
      'መጠንን ኣማራጺ ርእሰ-ሰር ዒላማ ምውጻእን ኣዳሉ። ነፍሲ ወከፍ ፓነል ናጻ እዩ፣ ሒሳብ ልምምድ ይካፈል።',
      'Deji qaddar iyo bartilmaameed bixitaan toos ah oo ikhtiyaari ah. Guddi kastaa waa gooni wuxuuna wadaagaa haraaga tababarka.',
      'حدّد مبلغًا وهدف خروج تلقائي اختياريًا. كل لوحة مستقلة وتشترك في الرصيد التدريبي.',
      'Weka kiasi na lengo la hiari la kutoka kiotomatiki. Kila paneli ni tofauti na inashiriki salio la mazoezi.',
      'Fixez un montant et une cible facultative d’encaissement automatique. Chaque panneau est indépendant et partage le solde d’entraînement.'
    ),
  'Six matched at ball {completion} · {value}× return': tr(
    'ስድስቱ በኳስ {completion} ተዛምደዋል · {value}× ተመላሽ',
    'Jaʼan kubbaa {completion} irratti walsiman · deebii {value}×',
    'ሽዱሽተ ኣብ ኩዕሶ {completion} ተዛሚዶም · {value}× ተመላሲ',
    'Lixdu waxay is-waafaqeen kubbadda {completion} · {value}× soo-noqosho',
    'اكتملت المطابقات الست عند الكرة {completion} · عائد {value}×',
    'Sita zimelingana kwenye mpira {completion} · marejesho {value}×',
    'Six correspondances à la boule {completion} · retour {value}×'
  ),
  'Steps of 5 · Maximum 480 credits per ticket · Amount locks when the draw starts.': tr(
    'በ 5 ደረጃዎች · በትኬት ከፍተኛው 480 ክሬዲቶች · ዕጣው ሲጀምር መጠኑ ይቆለፋል።',
    'Tarkaanfii 5 · Tikeetii tokkoof olʼaanaa qabxii 480 · Carraan yeroo jalqabu maallaqni cufama.',
    'ብ 5 ደረጃታት · ንትኬት ዝለዓለ 480 ክሬዲት · ዕጣ ምስ ጀመረ መጠን ይዕጾ።',
    'Tallaabooyin 5 · Ugu badnaan 480 dhibcood tigidh kasta · Qaddarku wuu xirmaa marka isku-aadku bilaabmo.',
    'بزيادات 5 · حد أقصى 480 رصيدًا لكل تذكرة · يُثبّت المبلغ عند بدء السحب.',
    'Hatua za 5 · Kiwango cha juu vitengo 480 kwa tiketi · Kiasi hufungwa droo inapoanza.',
    'Paliers de 5 · Maximum 480 crédits par ticket · Le montant est verrouillé au début du tirage.'
  ),
  'That game is no longer in the collection. Choose another game below.': tr(
    'ያ ጨዋታ ከእንግዲህ በስብስቡ ውስጥ የለም። ከታች ሌላ ጨዋታ ይምረጡ።',
    'Taphi sun kana booda kuusaa keessa hin jiru. Armaan gaditti tapha biraa filadhu.',
    'እቲ ጸወታ ደጊም ኣብ እኩብ የለን። ኣብ ታሕቲ ካልእ ጸወታ ምረጽ።',
    'Ciyaartaasi hadda ururinta kuma jirto. Hoos ka dooro ciyaar kale.',
    'لم تعد تلك اللعبة ضمن المجموعة. اختر لعبة أخرى أدناه.',
    'Mchezo huo haupo tena kwenye mkusanyiko. Chagua mwingine hapa chini.',
    'Ce jeu ne fait plus partie de la collection. Choisissez-en un autre ci-dessous.'
  ),
  'The browser checked structure and hashes only. Verify the timestamp offline against separately approved certificates. A download does not prove independent retention or earlier public availability.':
    tr(
      'አሳሹ መዋቅርን እና ሃሾችን ብቻ ፈትሿል። የጊዜ ማህተሙን ከመስመር ውጪ በተለየ በጸደቁ ማረጋገጫዎች ያረጋግጡ። ማውረድ ገለልተኛ ማስቀመጥ ወይም ቀድሞ ለሕዝብ መገኘትን አያረጋግጥም።',
      'Biraawzariin caasaa fi haashii qofa ilaale. Ragaa yeroo interneetii malee ragaa addaatti mirkanaaʼeen ilaali. Buufachuun kuusaa walaba ykn duraan uummataaf argamuu hin mirkaneessu.',
      'መርበብ ቅርጽን ሃሻትን ጥራይ መርሚሩ። ማሕተም ግዜ ካብ መስመር ወጻኢ ብበይኖም ዝጸደቑ ሰርቲፊኬታት ኣረጋግጽ። ምውራድ ናጻ ምዕቃብ ወይ ኣቐዲሙ ንህዝቢ ምርካብ ኣየረጋግጽን።',
      'Biraawsarku wuxuu hubiyay qaab-dhismeedka iyo hash-yada keliya. Shaabadda waqtiga offline ugu xaqiiji shahaadooyin si gaar ah loo ansixiyay. Soo-dejin ma caddayso kaydin madax-bannaan ama in hore dadweynaha loo heli jiray.',
      'تحقق المتصفح من البنية والتجزئات فقط. تحقّق من الطابع الزمني دون اتصال باستخدام شهادات معتمدة بشكل منفصل. التنزيل لا يثبت الاحتفاظ المستقل أو الإتاحة العامة السابقة.',
      'Kivinjari kimekagua muundo na hashi pekee. Thibitisha muhuri wa muda bila mtandao kwa vyeti vilivyoidhinishwa kando. Kupakua hakuthibitishi hifadhi huru au upatikanaji wa awali kwa umma.',
      'Le navigateur a seulement vérifié la structure et les hachages. Vérifiez l’horodatage hors ligne avec des certificats approuvés séparément. Un téléchargement ne prouve ni conservation indépendante ni disponibilité publique antérieure.'
    ),
  'The game rules have changed. Reload the app before playing.': tr(
    'የጨዋታ ደንቦች ተቀይረዋል። ከመጫወትዎ በፊት መተግበሪያውን እንደገና ይጫኑ።',
    'Seerotni taphaa jijjiiramaniiru. Taphachuu dura appii irra deebiʼii feʼi.',
    'ሕግታት ጸወታ ተቐይሮም። ቅድሚ ምጽዋትካ መተግበሪ ዳግም ጽዓን።',
    'Xeerarka ciyaarta way is beddeleen. Dib u soo deji abka ka hor ciyaarta.',
    'تغيّرت قواعد اللعبة. أعد تحميل التطبيق قبل اللعب.',
    'Kanuni za mchezo zimebadilika. Pakia programu upya kabla ya kucheza.',
    'Les règles du jeu ont changé. Rechargez l’application avant de jouer.'
  ),
  'The next matchweek opens in {value}. Matches are created only while selections are open, so a matchweek that nobody opens is never played.':
    tr(
      'ቀጣዩ የግጥሚያ ሳምንት በ{value} ይከፈታል። ግጥሚያዎች የሚፈጠሩት ምርጫዎች ክፍት ሲሆኑ ብቻ ነው፣ ስለዚህ ማንም ያልከፈተው ሳምንት አይጫወትም።',
      'Torban taphaa itti aanu {value} keessatti banama. Taphoonni filannoon banaa yeroo taʼe qofa uumamu; kanaaf torban namni hin banne hin taphatamu.',
      'ቀጻሊ ሰሙን ግጥማት ድሕሪ {value} ይኽፈት። ግጥማት ምርጫታት ክፉታት ከለዉ ጥራይ ይፍጠሩ፣ ስለዚ ማንም ዘይከፈቶ ሰሙን ኣይጽወትን።',
      'Usbuuca kulamada xiga wuxuu furmayaa {value} gudahood. Kulamada waxaa la sameeyaa keliya marka doorashooyinku furan yihiin, sidaas darteed usbuuc aan qofna furin lama ciyaaro.',
      'يفتح أسبوع المباريات التالي خلال {value}. تُنشأ المباريات فقط أثناء فتح الاختيارات، لذا الأسبوع الذي لا يفتحه أحد لا يُلعب.',
      'Wiki inayofuata ya mechi inafunguka baada ya {value}. Mechi huundwa tu machaguo yakiwa wazi, kwa hivyo wiki isiyofunguliwa na yeyote haichezwi.',
      'La prochaine journée ouvre dans {value}. Les matchs sont créés seulement lorsque les sélections sont ouvertes ; une journée ouverte par personne n’est donc jamais jouée.'
    ),
  'The server draws 18 different numbers from 1–72 and releases one each second.': tr(
    'አገልጋዩ ከ 1–72 18 የተለያዩ ቁጥሮችን ያወጣል፣ በየሰከንዱም አንዱን ይገልጣል።',
    'Sarvariin 1–72 keessaa lakkoofsota adda addaa 18 filatee sekondii sekondiin tokko mulʼisa.',
    'ኣገልጋሊ ካብ 1–72 18 ዝተፈላለዩ ቁጽርታት የውጽእ፣ ኣብ ነፍሲ ወከፍ ካልኢት ሓደ ይገልጽ።',
    'Seerfarku wuxuu soo saaraa 18 lambar oo kala duwan oo 1–72 ah, ilbiriqsi kastana mid ayuu muujiyaa.',
    'يسحب الخادم 18 رقمًا مختلفًا من 1–72 ويكشف واحدًا كل ثانية.',
    'Seva hutoa nambari 18 tofauti kutoka 1–72 na kuonyesha moja kila sekunde.',
    'Le serveur tire 18 numéros différents parmi 1–72 et en révèle un chaque seconde.'
  ),
  'The server draws 35 different balls from 1–48, revealing one every two seconds. The first five are the pre-balls.':
    tr(
      'አገልጋዩ ከ 1–48 35 የተለያዩ ኳሶችን ያወጣል፣ በየሁለት ሰከንዱ አንዱን ይገልጣል። የመጀመሪያዎቹ አምስት ቅድመ ኳሶች ናቸው።',
      'Sarvariin 1–48 keessaa kubbaa adda addaa 35 filatee sekondii lama lamaan tokko mulʼisa. Shanan jalqabaa kubbaa duraa dha.',
      'ኣገልጋሊ ካብ 1–48 35 ዝተፈላለዩ ኩዕሶታት የውጽእ፣ ኣብ ነፍሲ ወከፍ ክልተ ካልኢት ሓደ ይገልጽ። ቀዳሞት ሓሙሽተ ቅድመ ኩዕሶታት እዮም።',
      'Seerfarku wuxuu soo saaraa 35 kubbadood oo kala duwan oo 1–48 ah, labadii ilbiriqsina mid ayuu muujiyaa. Shanta hore waa kubbadaha hordhaca.',
      'يسحب الخادم 35 كرة مختلفة من 1–48، ويكشف واحدة كل ثانيتين. الخمس الأولى هي الكرات التمهيدية.',
      'Seva hutoa mipira 35 tofauti kutoka 1–48, ikionyesha mmoja kila sekunde mbili. Mitano ya kwanza ni mipira ya awali.',
      'Le serveur tire 35 boules différentes parmi 1–48, une toutes les deux secondes. Les cinq premières sont les boules préliminaires.'
    ),
  'The server runs a new round every minute, including when nobody is watching. Entries close after 45 seconds. Refreshing or reconnecting restores your saved ticket and result. You can confirm up to 10 separate tickets before the deadline. Confirmed tickets cannot be edited. Tickets are never placed automatically. Group PVP uses separate rules and a 7% completion fee.':
    tr(
      'አገልጋዩ ማንም ባይመለከትም በየደቂቃው አዲስ ዙር ያካሂዳል። ተሳትፎ ከ 45 ሰከንድ በኋላ ይዘጋል። ገጽ ማደስ ወይም ዳግም መገናኘት የተቀመጠ ትኬትዎን እና ውጤትዎን ይመልሳል። ከጊዜ ገደቡ በፊት እስከ 10 የተለዩ ትኬቶችን ማረጋገጥ ይችላሉ። የተረጋገጡ ትኬቶች አይቀየሩም። ትኬቶች በራስ-ሰር አይገቡም። የቡድን PVP የተለዩ ደንቦች እና 7% የማጠናቀቂያ ክፍያ ይጠቀማል።',
      'Sarvariin daqiiqaa daqiiqaan marsaa haaraa hojjeta, namni ilaalu yoo hin jirrellee. Hirmaannaan sekondii 45 booda cufama. Haaromsuun ykn deebiʼanii walqunnamuun tikeetii fi buʼaa olkaaʼame deebisa. Daangaa yeroo dura tikeetii adda addaa hanga 10 mirkaneessuu dandeessa. Tikeetiin mirkanaaʼe hin gulaalamu. Tikeetiin ofumaan hin galfamu. PVP garee seera addaa fi kaffaltii xumuraa 7% fayyadama.',
      'ኣገልጋሊ ማንም ይርኢ እንተዘየለ እውን ኣብ ነፍሲ ወከፍ ደቒቕ ሓድሽ ዙር የካይድ። ተሳትፎ ድሕሪ 45 ካልኢት ይዕጾ። ምሕዳስ ወይ ዳግም ምርኻብ ዝተዓቀበ ትኬትካን ውጽኢትካን ይመልስ። ቅድሚ ደረት ግዜ ክሳብ 10 በበይኖም ትኬታት ከተረጋግጽ ትኽእል። ዝተረጋገጹ ትኬታት ኣይቅየሩን። ትኬታት ብርእሶም ኣይምዝገቡን። ጉጅለ PVP ዝተፈለዩ ሕግታትን 7% ክፍሊት ምዝዛምን ይጥቀም።',
      'Seerfarku wareeg cusub ayuu bilaabaa daqiiqad kasta, xitaa qofna haddii uusan daawanayn. Gelitaanku wuxuu xirmaa 45 ilbiriqsi ka dib. Cusboonaysiin ama dib-u-xirid waxay soo celisaa tigidhka iyo natiijada kaydsan. Waxaad xaqiijin kartaa ilaa 10 tigidh oo gooni ah ka hor waqtiga kama dambaysta ah. Tigidh la xaqiijiyay lama beddeli karo. Tigidhyo si toos ah looma geliyo. Kooxaha PVP waxay isticmaalaan xeerar gaar ah iyo 7% khidmad dhammaystir.',
      'يشغّل الخادم جولة جديدة كل دقيقة حتى دون مشاهدين. تُغلق المشاركات بعد 45 ثانية. يعيد التحديث أو الاتصال تذكرتك ونتيجتك المحفوظتين. يمكنك تأكيد حتى 10 تذاكر منفصلة قبل الموعد. التذاكر المؤكدة لا تُعدّل ولا توضع تلقائيًا. يستخدم PVP الجماعي قواعد منفصلة ورسم إكمال 7%.',
      'Seva huendesha raundi mpya kila dakika hata bila watazamaji. Ushiriki hufungwa baada ya sekunde 45. Kusasisha au kuunganisha tena hurejesha tiketi na matokeo yaliyohifadhiwa. Unaweza kuthibitisha hadi tiketi 10 tofauti kabla ya muda kuisha. Tiketi zilizothibitishwa hazihaririwi. Tiketi haziwekwi kiotomatiki. PVP ya kikundi hutumia kanuni tofauti na ada ya kukamilisha ya 7%.',
      'Le serveur lance une manche chaque minute, même sans spectateurs. Les participations ferment après 45 secondes. Actualisation ou reconnexion restaure votre ticket et son résultat. Confirmez jusqu’à 10 tickets distincts avant la limite. Les tickets confirmés ne sont pas modifiables et ne sont jamais placés automatiquement. Le PVP de groupe utilise des règles distinctes et des frais d’achèvement de 7 %.'
    ),
};
export default catalogue;
