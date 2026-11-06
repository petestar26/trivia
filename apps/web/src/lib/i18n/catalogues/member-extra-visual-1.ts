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
  'Use an agent instead': tr(
    'በምትኩ ወኪል ይጠቀሙ',
    'Bakka isaa bakka buʼaa fayyadami',
    'ኣብ ክንድኡ ወኪል ተጠቐም',
    'Halkii isticmaal wakiil',
    'استخدم وكيلًا بدلًا من ذلك',
    'Tumia wakala badala yake',
    'Utiliser plutôt un agent'
  ),
  'Use at least 8 characters, with uppercase, lowercase, a number and a symbol.': tr(
    'ቢያንስ 8 ቁምፊዎች፣ ትልቅ ፊደል፣ ትንሽ ፊደል፣ ቁጥር እና ምልክት ይጠቀሙ።',
    'Yoo xiqqaate arfiilee 8, qubee guddaa, xiqqaa, lakkoofsa fi mallattoo fayyadami.',
    'እንተወሓደ 8 ፊደላት፣ ዓቢ ፊደል፣ ንእሽቶ ፊደል፣ ቁጽሪን ምልክትን ተጠቐም።',
    'Isticmaal ugu yaraan 8 xaraf, oo leh xaraf weyn, yar, lambar iyo calaamad.',
    'استخدم 8 أحرف على الأقل، مع حرف كبير وصغير ورقم ورمز.',
    'Tumia angalau herufi 8, zikiwemo kubwa, ndogo, nambari na alama.',
    'Utilisez au moins 8 caractères, avec une majuscule, une minuscule, un chiffre et un symbole.'
  ),
  'Use bonus Birr for eligible real-money bets. The reward itself, returned stakes, and refunds remain non-withdrawable. Only verified net winnings can enter your cash balance, subject to withdrawal checks. Practice games and casino demos never produce withdrawable winnings.':
    tr(
      'የቦነስ ብርን ለተፈቀዱ የእውነተኛ ገንዘብ ውርርዶች ይጠቀሙ። ሽልማቱ ራሱ፣ የተመለሱ ውርርዶች እና ተመላሾች ወጪ ሊደረጉ አይችሉም። በማውጣት ፍተሻዎች መሠረት ወደ ገንዘብ ሂሳብዎ ሊገቡ የሚችሉት የተረጋገጡ የተጣሩ ትርፎች ብቻ ናቸው። የልምምድ ጨዋታዎች እና የካሲኖ ማሳያዎች ወጪ የሚደረግ ትርፍ አያመጡም።',
      'Birrii dabalataa buusii maallaqa dhugaa hayyamameef fayyadami. Badhaasni, buusiin deebiʼee fi deebiin kaffaltii baasuun hin dandaʼamu. Buʼaa qulqulluu mirkanaaʼe qofa, sakattaʼinsa baasuu jalatti, gara haftee maallaqa keetti galuu dandaʼa. Taphoonni shaakalaa fi demoon kaasinoo buʼaa baafamuu dandaʼu hin maddisiisan.',
      'ብር ቦነስ ንዝፍቀዱ ውርርዳት ሓቀኛ ገንዘብ ተጠቐም። ሽልማቱ፣ ዝተመልሱ ውርርዳትን ተመላሲታትን ክወጹ ኣይክእሉን። ዝተረጋገጹ ጽሩያት ረብሓታት ጥራይ ብመሰረት መርመራ ምውጻእ ናብ ሒሳብ ገንዘብካ ክኣትዉ ይኽእሉ። ጸወታታት ልምምድን ማሳያ ካዚኖን ክወጽእ ዝኽእል ረብሓ ኣየምጽኡን።',
      'U isticmaal Birr gunnada sharadyada lacagta dhabta ah ee u qalma. Abaalmarinta lafteeda, sharadyada la soo celiyay iyo lacag-celintu lama bixi karo. Guul saafi ah oo la xaqiijiyay keliya ayaa geli karta haraaga lacagtaada, iyadoo la marayo hubinta la-bixidda. Ciyaaraha tababarka iyo tijaabooyinka kasiinadu ma keenaan guul lacag ahaan loo bixi karo.',
      'استخدم بير البونص للرهانات المؤهلة بأموال حقيقية. المكافأة نفسها والرهانات المعادة والمبالغ المستردة تبقى غير قابلة للسحب. صافي الأرباح الموثقة فقط يمكن إضافته للرصيد النقدي، مع الخضوع لفحوص السحب. ألعاب التدريب وعروض الكازينو لا تنتج أرباحًا قابلة للسحب.',
      'Tumia Birr ya bonasi kwa dau halali za pesa halisi. Zawadi yenyewe, dau zilizorudishwa na marejesho hayawezi kutolewa. Faida halisi zilizothibitishwa pekee zinaweza kuingia salio la fedha, zikifuata ukaguzi wa utoaji. Michezo ya mazoezi na demo za kasino hazizalishi faida inayoweza kutolewa.',
      'Utilisez les Birr bonus pour les mises éligibles en argent réel. La récompense, les mises restituées et les remboursements restent non retirables. Seuls les gains nets vérifiés peuvent rejoindre le solde monétaire, sous réserve des contrôles de retrait. L’entraînement et les démos ne produisent jamais de gains retirables.'
    ),
  'Use the actual transfer record. Payment time must be after the request was created and cannot be in the future.':
    tr(
      'ትክክለኛውን የዝውውር መዝገብ ይጠቀሙ። የክፍያ ጊዜ ጥያቄው ከተፈጠረ በኋላ መሆን አለበት፣ የወደፊት ጊዜም መሆን አይችልም።',
      'Galmee dabarsaa dhugaa fayyadami. Yeroon kaffaltii gaaffiin uumame booda taʼuu qaba, yeroo fuulduraa taʼuu hin dandaʼu.',
      'ሓቀኛ መዝገብ ምስግጋር ተጠቐም። ግዜ ክፍሊት ሕቶ ድሕሪ ምፍጣሩ ክኸውን ኣለዎ፣ መጻኢ ግዜ ክኸውን ኣይክእልን።',
      'Isticmaal diiwaanka wareejinta ee dhabta ah. Waqtiga lacag-bixintu waa inuu ka dambeeyaa abuurista codsiga, mustaqbalna ma noqon karo.',
      'استخدم سجل التحويل الفعلي. يجب أن يكون وقت الدفع بعد إنشاء الطلب، وألا يكون في المستقبل.',
      'Tumia rekodi halisi ya uhamisho. Muda wa malipo lazima uwe baada ya ombi kuundwa, wala usiwe wa baadaye.',
      'Utilisez le vrai relevé du transfert. Le paiement doit dater d’après la création de la demande, jamais du futur.'
    ),
  'Use your country code and a password.': tr(
    'የአገርዎን ኮድ እና የይለፍ ቃል ይጠቀሙ።',
    'Koodii biyya keetii fi jecha iccitii fayyadami.',
    'ኮድ ሃገርካን ቃል ምስጢርን ተጠቐም።',
    'Isticmaal koodhka dalkaaga iyo eray sir ah.',
    'استخدم رمز بلدك وكلمة مرور.',
    'Tumia msimbo wa nchi yako na nenosiri.',
    'Utilisez votre indicatif pays et un mot de passe.'
  ),
  'Use your own receiving address on TRON (TRC20). Your requested ETB balance is held while the payout is processed. Practice balances cannot be withdrawn.':
    tr(
      'በTRON (TRC20) የራስዎን መቀበያ አድራሻ ይጠቀሙ። ክፍያው በሚሠራበት ጊዜ የጠየቁት ETB ተይዞ ይቆያል። የልምምድ ሂሳቦች ወጪ ሊደረጉ አይችሉም።',
      'Teessoo fudhannaa mataa kee kan TRON (TRC20) fayyadami. ETB ati gaafatte yeroo kaffaltiin adeemsifamu qabamee tura. Hafteen shaakalaa baafamuu hin dandaʼu.',
      'ኣብ TRON (TRC20) ናይ ርእስኻ መቐበሊ ኣድራሻ ተጠቐም። ዝሓተትካዮ ETB ክፍሊት ክስራሕ ከሎ ተታሒዙ ይጸንሕ። ሒሳባት ልምምድ ክወጹ ኣይክእሉን።',
      'Isticmaal cinwaankaaga qaabilaadda TRON (TRC20). ETB-ga aad codsatay waa la hayaa inta lacag-bixinta la farsamaynayo. Haraaga tababarka lama bixi karo.',
      'استخدم عنوان الاستلام الخاص بك على TRON (TRC20). يُحجز مبلغ ETB المطلوب أثناء معالجة الدفع. لا يمكن سحب أرصدة التدريب.',
      'Tumia anwani yako ya kupokea kwenye TRON (TRC20). Kiasi cha ETB ulichoomba kinahifadhiwa malipo yakichakatwa. Salio la mazoezi haliwezi kutolewa.',
      'Utilisez votre propre adresse de réception TRON (TRC20). Le montant ETB demandé est réservé pendant le traitement. Les soldes d’entraînement ne sont pas retirables.'
    ),
  'Verification failed: {value}': tr(
    'ማረጋገጫ አልተሳካም፦ {value}',
    'Mirkaneessuun hin milkoofne: {value}',
    'ምርግጋጽ ኣይተዓወተን፦ {value}',
    'Xaqiijintu way fashilantay: {value}',
    'فشل التحقق: {value}',
    'Uthibitishaji umeshindikana: {value}',
    'Échec de la vérification : {value}'
  ),
  'Verification is delayed. Do not send again. We will keep checking.': tr(
    'ማረጋገጫ ዘግይቷል። እንደገና አይላኩ። መፈተሻችንን እንቀጥላለን።',
    'Mirkaneessuun harkifateera. Irra deebiʼii hin ergin. Ilaaluu itti fufna.',
    'ምርግጋጽ ደንጒዩ። ዳግም ኣይትልኣኽ። ምፍታሽ ክንቅጽል ኢና።',
    'Xaqiijintu way daahday. Mar kale ha dirin. Waan sii hubinaynaa.',
    'تأخر التحقق. لا ترسل مرة أخرى. سنواصل التحقق.',
    'Uthibitishaji umechelewa. Usitume tena. Tutaendelea kukagua.',
    'La vérification prend du retard. N’envoyez pas à nouveau. Nous continuons à vérifier.'
  ),
  'Verification notes': tr(
    'የማረጋገጫ ማስታወሻዎች',
    'Yaadannoo mirkaneessaa',
    'መዘኻኸሪታት ምርግጋጽ',
    'Qoraallada xaqiijinta',
    'ملاحظات التحقق',
    'Maelezo ya uthibitishaji',
    'Notes de vérification'
  ),
  'Verification notes are visible to the member. Do not include private credentials or unrelated account details.':
    tr(
      'የማረጋገጫ ማስታወሻዎች ለአባሉ ይታያሉ። የግል የመግቢያ መረጃ ወይም የማይዛመዱ የመለያ ዝርዝሮችን አያካትቱ።',
      'Yaadannoon mirkaneessaa miseensaaf mulʼata. Odeeffannoo seensaa dhuunfaa ykn balʼina herregaa hin ilaallanne hin dabalin.',
      'መዘኻኸሪታት ምርግጋጽ ንኣባል ይርኣዩ። ውልቃዊ ሓበሬታ መእተዊ ወይ ዘይዛመድ ዝርዝር መለያ ኣይትሓውስ።',
      'Qoraallada xaqiijinta xubintu way arki kartaa. Ha ku darin aqoonsiyo sir ah ama faahfaahin koonto oo aan khusayn.',
      'ملاحظات التحقق مرئية للعضو. لا تُضمّن بيانات دخول خاصة أو تفاصيل حساب غير مرتبطة.',
      'Maelezo ya uthibitishaji yanaonekana kwa mwanachama. Usijumuishe taarifa za siri za kuingia au za akaunti zisizohusika.',
      'Les notes de vérification sont visibles par le membre. N’incluez pas d’identifiants privés ni de détails de compte sans rapport.'
    ),
  'Verified amount received and fully refunded (': tr(
    'የተቀበለው መጠን ተረጋግጦ ሙሉ ተመልሷል (',
    'Maallaqni fudhatame mirkanaaʼee guutumaan deebiʼe (',
    'ዝተቐበለ መጠን ተረጋጊጹ ሙሉእ ተመሊሱ (',
    'Qaddarka la helay waa la xaqiijiyay gebi ahaanba waa la celiyay (',
    'تم التحقق من المبلغ المستلم واسترداده بالكامل (',
    'Kiasi kilichopokelewa kimethibitishwa na kurudishwa chote (',
    'Montant reçu vérifié et intégralement remboursé ('
  ),
  'Verified deposits credit the saved ETB amount. Later rate changes never revalue wallet balances. Withdrawals reserve the requested ETB amount and show the USDT payout before confirmation.':
    tr(
      'የተረጋገጡ ተቀማጮች የተቀመጠውን ETB መጠን ወደ ሂሳብ ያስገባሉ። ከዚያ በኋላ የሚለወጡ ተመኖች የቦርሳ ሂሳብን ዋጋ አይቀይሩም። ወጪ ማድረግ የተጠየቀውን ETB ይይዛል፣ ከማረጋገጫ በፊት የUSDT ክፍያን ያሳያል።',
      'Maallaqni galfame mirkanaaʼe ETB olkaaʼame herregatti dabala. Jijjiiramni reetii boodaa gatii haftee boorsaa hin jijjiiru. Baasuun ETB gaafame qabatee kaffaltii USDT mirkaneessa dura agarsiisa.',
      'ዝተረጋገጹ ተቐማጢታት ዝተዓቀበ መጠን ETB ናብ ሒሳብ የእትዉ። ድሒሩ ዝቕየር ተመን ግምት ሒሳብ ቦርሳ ኣይቕይርን። ምውጻእ ዝተሓተተ ETB ይሕዝ፣ ቅድሚ ምርግጋጽ ክፍሊት USDT የርኢ።',
      'Dhigaal la xaqiijiyay wuxuu koontada ku daraa qaddarka ETB ee kaydsan. Isbeddellada sicirka ee dambe ma beddelaan qiimaha haraaga jeebka. La-bixiddu waxay haysaa ETB-ga la codsaday waxayna muujisaa lacag-bixinta USDT ka hor xaqiijinta.',
      'تضيف الإيداعات الموثقة مبلغ ETB المحفوظ. تغيّر الأسعار لاحقًا لا يعيد تقييم أرصدة المحفظة. تحجز السحوبات مبلغ ETB المطلوب وتعرض دفع USDT قبل التأكيد.',
      'Amana zilizothibitishwa huongeza kiasi cha ETB kilichohifadhiwa. Mabadiliko ya baadaye ya viwango hayabadili thamani ya salio la pochi. Utoaji huhifadhi ETB iliyoombwa na kuonyesha malipo ya USDT kabla ya kuthibitisha.',
      'Les dépôts vérifiés créditent le montant ETB enregistré. Les changements ultérieurs de taux ne réévaluent jamais les soldes. Les retraits réservent les ETB demandés et affichent le versement USDT avant confirmation.'
    ),
  'Verified incoming reference': tr(
    'የተረጋገጠ ገቢ ማጣቀሻ',
    'Wabii galii mirkanaaʼe',
    'ዝተረጋገጸ መወከሲ ኣታዊ',
    'Tixraaca soo-galka ee la xaqiijiyay',
    'مرجع وارد موثّق',
    'Rejea ya mapokezi iliyothibitishwa',
    'Référence entrante vérifiée'
  ),
  'Verified transfer evidence': tr(
    'የተረጋገጠ የዝውውር ማስረጃ',
    'Ragaa dabarsaa mirkanaaʼe',
    'ዝተረጋገጸ መርትዖ ምስግጋር',
    'Caddaynta wareejinta ee la xaqiijiyay',
    'إثبات تحويل موثّق',
    'Ushahidi wa uhamisho uliothibitishwa',
    'Preuve de transfert vérifiée'
  ),
  'Verified transfer reference': tr(
    'የተረጋገጠ የዝውውር ማጣቀሻ',
    'Wabii dabarsaa mirkanaaʼe',
    'ዝተረጋገጸ መወከሲ ምስግጋር',
    'Tixraaca wareejinta ee la xaqiijiyay',
    'مرجع تحويل موثّق',
    'Rejea ya uhamisho iliyothibitishwa',
    'Référence de transfert vérifiée'
  ),
  'Verified: all {length} matches were generated from the seed committed before kick-off.': tr(
    'ተረጋግጧል፦ ሁሉም {length} ግጥሚያዎች ከጅማሬ በፊት በተረጋገጠው መነሻ እሴት ተፈጥረዋል።',
    'Mirkanaaʼe: taphoonni {length} hundi sanyii jalqaba dura waadaa galame irraa uumaman.',
    'ተረጋጊጹ፦ ኩሎም {length} ግጥማት ቅድሚ ምጅማር ካብ ዝተወፈየ መበገሲ ክብሪ ተፈጢሮም።',
    'Waa la xaqiijiyay: dhammaan {length} kulan waxaa laga sameeyay abuurkii la xaqiijiyay ka hor bilowga.',
    'تم التحقق: وُلّدت المباريات {length} كلها من البذرة الملتزم بها قبل الانطلاق.',
    'Imethibitishwa: mechi zote {length} zilitolewa kwa mbegu iliyoahidiwa kabla ya kuanza.',
    'Vérifié : les {length} matchs ont été générés à partir de la graine engagée avant le coup d’envoi.'
  ),
  'Verify identity': tr(
    'ማንነትን ያረጋግጡ',
    'Eenyummaa mirkaneessi',
    'መንነት ኣረጋግጽ',
    'Xaqiiji aqoonsiga',
    'التحقق من الهوية',
    'Thibitisha utambulisho',
    'Vérifier l’identité'
  ),
  'Verify that the recipient controls the destination wallet. Never transfer a withdrawal to a platform deposit address, including a retired address.':
    tr(
      'ተቀባዩ የመድረሻ ቦርሳውን እንደሚቆጣጠር ያረጋግጡ። ከአገልግሎት የወጣን አድራሻ ጨምሮ፣ ወጪን ወደ መድረኩ የተቀማጭ አድራሻ ፈጽሞ አያስተላልፉ።',
      'Fudhataan boorsaa gaʼumsaa toʼachuu isaa mirkaneessi. Teessoo dulloome dabalatee, baasii gara teessoo galii waltajjiitti hin dabarsin.',
      'ተቐባሊ ቦርሳ መድረሻ ከም ዝቆጻጸር ኣረጋግጽ። ዝተሰናበተ ኣድራሻ ሓዊስካ፣ ገንዘብ ምውጻእ ናብ ኣድራሻ ተቐማጢ መድረኽ ፈጺምካ ኣይተሰጋግር።',
      'Xaqiiji in qaatahu maamulo jeebka loo dirayo. Marna lacag la-bixid ah ha ugu wareejin cinwaan dhigaal oo madasha ah, xitaa cinwaan hawlgab ah.',
      'تحقّق من سيطرة المستلم على محفظة الوجهة. لا تحوّل سحبًا إلى عنوان إيداع للمنصة أبدًا، حتى لو كان متوقفًا.',
      'Thibitisha mpokeaji anadhibiti pochi lengwa. Usihamishe utoaji kamwe kwa anwani ya amana ya jukwaa, hata iliyostaafishwa.',
      'Vérifiez que le destinataire contrôle le portefeuille de destination. Ne transférez jamais un retrait vers une adresse de dépôt de la plateforme, même désactivée.'
    ),
  'Verify the incoming transfer and full refund in the payment provider’s records. This form records a completed refund; it does not send money. Unverified and partial refunds must remain under investigation.':
    tr(
      'ገቢ ዝውውሩን እና ሙሉ ተመላሹን በክፍያ አቅራቢው መዝገቦች ያረጋግጡ። ይህ ቅጽ የተጠናቀቀ ተመላሽ ይመዘግባል፤ ገንዘብ አይልክም። ያልተረጋገጡ እና ከፊል ተመላሾች በምርመራ ላይ መቆየት አለባቸው።',
      'Dabarsa galii fi deebii guutuu galmee dhiyeessaa kaffaltii keessatti mirkaneessi. Unki kun deebii xumurame galmeessa; maallaqa hin ergu. Deebiin hin mirkanoofnee fi gartokkee qorannoo keessa turuu qaba.',
      'ኣታዊ ምስግጋርን ምሉእ ተመላስን ኣብ መዛግብቲ ኣቕራቢ ክፍሊት ኣረጋግጽ። እዚ ቅጥዒ ዝተዛዘመ ተመላሲ ይምዝግብ፤ ገንዘብ ኣይልእኽን። ዘይተረጋገጹን ከፊላውያን ተመላሲታትን ኣብ ምርመራ ክጸንሑ ኣለዎም።',
      'Ka xaqiiji wareejinta soo gashay iyo lacag-celinta buuxda diiwaannada bixiyaha lacag-bixinta. Foomkani wuxuu diiwaangeliyaa lacag-celin dhammaatay; lacag ma diro. Lacag-celin aan la xaqiijin ama qayb ah waa inay baaritaan ku sii jirtaa.',
      'تحقّق من التحويل الوارد والاسترداد الكامل في سجلات مزوّد الدفع. يسجّل هذا النموذج استردادًا مكتملًا؛ ولا يرسل أموالًا. الاستردادات غير الموثقة والجزئية يجب أن تبقى قيد التحقيق.',
      'Thibitisha uhamisho uliopokelewa na marejesho yote kwenye rekodi za mtoa malipo. Fomu hii hurekodi marejesho yaliyokamilika; haitumi pesa. Marejesho yasiyothibitishwa na ya sehemu lazima yabaki yakichunguzwa.',
      'Vérifiez le transfert entrant et le remboursement intégral dans les relevés du prestataire. Ce formulaire enregistre un remboursement effectué ; il n’envoie pas d’argent. Les remboursements partiels ou non vérifiés doivent rester en cours d’enquête.'
    ),
  'Verify these results in your browser': tr(
    'እነዚህን ውጤቶች በአሳሽዎ ያረጋግጡ',
    'Buʼaawwan kana biraawzara kee keessatti mirkaneessi',
    'ነዞም ውጽኢታት ኣብ መርበብካ ኣረጋግጽ',
    'Ku xaqiiji natiijooyinkan biraawsarkaaga',
    'تحقّق من هذه النتائج في متصفحك',
    'Thibitisha matokeo haya kwenye kivinjari chako',
    'Vérifier ces résultats dans votre navigateur'
  ),
  'Verify withdrawal': tr(
    'ወጪን ያረጋግጡ',
    'Baasii mirkaneessi',
    'ምውጻእ ኣረጋግጽ',
    'Xaqiiji la-bixidda',
    'التحقق من السحب',
    'Thibitisha utoaji',
    'Vérifier le retrait'
  ),
  'View competitions': tr(
    'ውድድሮችን ይመልከቱ',
    'Dorgommiiwwan ilaali',
    'ውድድራት ርአ',
    'Eeg tartamada',
    'عرض المسابقات',
    'Tazama mashindano',
    'Voir les compétitions'
  ),
  'View deposit transfer': tr(
    'የተቀማጭ ዝውውር ይመልከቱ',
    'Dabarsa galii ilaali',
    'ምስግጋር ተቐማጢ ርአ',
    'Eeg wareejinta dhigaalka',
    'عرض تحويل الإيداع',
    'Tazama uhamisho wa amana',
    'Voir le transfert de dépôt'
  ),
  'View on TRON explorer': tr(
    'በTRON አሳሽ ይመልከቱ',
    'Sakattaʼaa TRON irratti ilaali',
    'ኣብ መርመሪ TRON ርአ',
    'Ka eeg sahmiyaha TRON',
    'عرض في مستكشف TRON',
    'Tazama kwenye kivinjari cha TRON',
    'Voir dans l’explorateur TRON'
  ),
  'View payment activity →': tr(
    'የክፍያ እንቅስቃሴ ይመልከቱ →',
    'Sochii kaffaltii ilaali →',
    'ንጥፈት ክፍሊት ርአ →',
    'Eeg dhaqdhaqaaqa lacag-bixinta →',
    'عرض نشاط الدفع →',
    'Tazama shughuli za malipo →',
    'Voir l’activité des paiements →'
  ),
  'Virtual ETB with no cash value. Practice gifts and game balances cannot be withdrawn.': tr(
    'የገንዘብ ዋጋ የሌለው ምናባዊ ETB። የልምምድ ስጦታዎች እና የጨዋታ ሂሳቦች ወጪ ሊደረጉ አይችሉም።',
    'ETB fakkeeffame gatii maallaqaa hin qabne. Kennaa shaakalaa fi hafteen taphaa baafamuu hin dandaʼan.',
    'ምናባዊ ETB ዋጋ ገንዘብ ዘይብሉ። ህያባት ልምምድን ሒሳባት ጸወታን ክወጹ ኣይክእሉን።',
    'ETB dalwad ah oo aan qiime lacag lahayn. Hadiyadaha tababarka iyo haraaga ciyaarta lama bixi karo.',
    'ETB افتراضي بلا قيمة نقدية. هدايا التدريب وأرصدة الألعاب غير قابلة للسحب.',
    'ETB pepe isiyo na thamani ya pesa. Zawadi za mazoezi na salio la michezo haviwezi kutolewa.',
    'ETB virtuels sans valeur monétaire. Les cadeaux d’entraînement et soldes de jeu ne sont pas retirables.'
  ),
  'Virtual ETB · No cash value': tr(
    'ምናባዊ ETB · የገንዘብ ዋጋ የለውም',
    'ETB fakkeeffame · Gatii maallaqaa hin qabu',
    'ምናባዊ ETB · ዋጋ ገንዘብ የብሉን',
    'ETB dalwad ah · Qiime lacag ma laha',
    'ETB افتراضي · بلا قيمة نقدية',
    'ETB pepe · Hakuna thamani ya pesa',
    'ETB virtuels · Aucune valeur monétaire'
  ),
  'Visible only to you': tr(
    'ለእርስዎ ብቻ ይታያል',
    'Siif qofa mulʼata',
    'ንዓኻ ጥራይ ይርአ',
    'Adiga keliya ayaa arka',
    'مرئي لك فقط',
    'Unaona wewe tu',
    'Visible uniquement par vous'
  ),
  'Voice message': tr(
    'የድምፅ መልእክት',
    'Ergaa sagalee',
    'መልእኽቲ ድምጺ',
    'Farriin cod ah',
    'رسالة صوتية',
    'Ujumbe wa sauti',
    'Message vocal'
  ),
  W: tr('ድል', 'M', 'ዓ', 'G', 'ف', 'U', 'V'),
  'WELCOME TO THE LOUNGE': tr(
    'እንኳን ወደ መዝናኛ አዳራሽ በደህና መጡ',
    'BAGA GARA BAKKA BOQONNAA DHUFTAN',
    'ናብ ኣዳራሽ መዘናግዒ እንቋዕ ብደሓን መጻእኩም',
    'KU SOO DHOWOW QOLKA NASASHADA',
    'مرحبًا بك في الصالة',
    'KARIBU SEBULENI',
    'BIENVENUE AU SALON'
  ),
  'Waiting for opponent to respond.': tr(
    'የተቃዋሚውን ምላሽ በመጠባበቅ ላይ።',
    'Deebii morkataa eegaa jira.',
    'መልሲ ተቓዋሚ ይጽበ ኣሎ።',
    'Jawaabta qofka kaa soo horjeeda ayaa la sugayaa.',
    'بانتظار رد المنافس.',
    'Inasubiri jibu la mpinzani.',
    'En attente de la réponse de l’adversaire.'
  ),
  'Waiting for your response.': tr(
    'የእርስዎን ምላሽ በመጠባበቅ ላይ።',
    'Deebii kee eegaa jira.',
    'መልስኻ ይጽበ ኣሎ።',
    'Jawaabtaada ayaa la sugayaa.',
    'بانتظار ردك.',
    'Inasubiri jibu lako.',
    'En attente de votre réponse.'
  ),
  'Wallet activity': tr(
    'የቦርሳ እንቅስቃሴ',
    'Sochii boorsaa',
    'ንጥፈት ቦርሳ',
    'Dhaqdhaqaaqa jeebka',
    'نشاط المحفظة',
    'Shughuli za pochi',
    'Activité du portefeuille'
  ),
  'Wallet currency: Birr (ETB)': tr(
    'የቦርሳ ገንዘብ፦ ብር (ETB)',
    'Maallaqa boorsaa: Birr (ETB)',
    'ገንዘብ ቦርሳ፦ ብር (ETB)',
    'Lacagta jeebka: Birr (ETB)',
    'عملة المحفظة: بير (ETB)',
    'Sarafu ya pochi: Birr (ETB)',
    'Devise du portefeuille : Birr (ETB)'
  ),
  'Wallet sections': tr(
    'የቦርሳ ክፍሎች',
    'Kutaalee boorsaa',
    'ክፍልታት ቦርሳ',
    'Qaybaha jeebka',
    'أقسام المحفظة',
    'Sehemu za pochi',
    'Sections du portefeuille'
  ),
  'Wallet {value} · Payment {value2}': tr(
    'ቦርሳ {value} · ክፍያ {value2}',
    'Boorsaa {value} · Kaffaltii {value2}',
    'ቦርሳ {value} · ክፍሊት {value2}',
    'Jeeb {value} · Lacag-bixin {value2}',
    'المحفظة {value} · الدفع {value2}',
    'Pochi {value} · Malipo {value2}',
    'Portefeuille {value} · Paiement {value2}'
  ),
  'Want to send a gift?': tr(
    'ስጦታ መላክ ይፈልጋሉ?',
    'Kennaa erguu barbaaddaa?',
    'ህያብ ክትልእኽ ትደሊ?',
    'Ma doonaysaa inaad hadiyad dirto?',
    'تريد إرسال هدية؟',
    'Unataka kutuma zawadi?',
    'Envie d’envoyer un cadeau ?'
  ),
  'Ways to earn': tr(
    'የማግኛ መንገዶች',
    'Karaalee argachuu',
    'መንገድታት ምርካብ',
    'Siyaabaha lagu kasbado',
    'طرق الكسب',
    'Njia za kupata',
    'Façons de gagner'
  ),
  'We couldn’t check your session. Reconnecting…': tr(
    'የመግቢያ ክፍለ ጊዜዎን መፈተሽ አልቻልንም። እንደገና በመገናኘት ላይ…',
    'Yeroo seensaa kee ilaaluu hin dandeenye. Irra deebiʼee walqunnamaa jira…',
    'ክፍለግዜኻ ክንምርምር ኣይከኣልናን። ዳግም ይራኸብ ኣሎ…',
    'Ma hubin karin fadhigaaga. Dib ayaa loo xirayaa…',
    'تعذر التحقق من جلستك. جارٍ إعادة الاتصال…',
    'Hatukuweza kukagua kipindi chako. Inaunganisha tena…',
    'Impossible de vérifier votre session. Reconnexion…'
  ),
  'Week {n}': tr(
    'ሳምንት {n}',
    'Torban {n}',
    'ሰሙን {n}',
    'Usbuuc {n}',
    'الأسبوع {n}',
    'Wiki {n}',
    'Semaine {n}'
  ),
  'Welcome back': tr(
    'እንኳን ደህና ተመለሱ',
    'Baga nagaan deebite',
    'እንቋዕ ብደሓን ተመለስካ',
    'Ku soo dhowow mar kale',
    'مرحبًا بعودتك',
    'Karibu tena',
    'Bon retour'
  ),
  'Welcome back,': tr(
    'እንኳን ደህና ተመለሱ፣',
    'Baga nagaan deebite,',
    'እንቋዕ ብደሓን ተመለስካ፣',
    'Ku soo dhowow mar kale,',
    'مرحبًا بعودتك،',
    'Karibu tena,',
    'Bon retour,'
  ),
  'Which balance can I use?': tr(
    'የትኛውን ሂሳብ መጠቀም እችላለሁ?',
    'Haftee kam fayyadamuu dandaʼa?',
    'ኣየናይ ሒሳብ ክጥቀም እኽእል?',
    'Haraagee ayaan isticmaali karaa?',
    'أي رصيد يمكنني استخدامه؟',
    'Ninaweza kutumia salio lipi?',
    'Quel solde puis-je utiliser ?'
  ),
  'Winner reward (Coins)': tr(
    'የአሸናፊ ሽልማት (ሳንቲሞች)',
    'Badhaasa moʼataa (Saantima)',
    'ሽልማት ተዓዋቲ (ሳንቲም)',
    'Abaalmarinta guuleystaha (qadaadiic)',
    'مكافأة الفائز (عملات)',
    'Zawadi ya mshindi (Sarafu)',
    'Récompense du gagnant (pièces)'
  ),
  'Winner reward (GP)': tr(
    'የአሸናፊ ሽልማት (GP)',
    'Badhaasa moʼataa (GP)',
    'ሽልማት ተዓዋቲ (GP)',
    'Abaalmarinta guuleystaha (GP)',
    'مكافأة الفائز (GP)',
    'Zawadi ya mshindi (GP)',
    'Récompense du gagnant (GP)'
  ),
  'Winner rewards:': tr(
    'የአሸናፊ ሽልማቶች፦',
    'Badhaasota moʼataa:',
    'ሽልማታት ተዓዋቲ፦',
    'Abaalmarinnada guuleystaha:',
    'مكافآت الفائز:',
    'Zawadi za mshindi:',
    'Récompenses du gagnant :'
  ),
  'Winner: {value}': tr(
    'አሸናፊ፦ {value}',
    'Moʼataa: {value}',
    'ተዓዋቲ፦ {value}',
    'Guuleyste: {value}',
    'الفائز: {value}',
    'Mshindi: {value}',
    'Gagnant : {value}'
  ),
  'Withdraw amount (ETB)': tr(
    'የሚወጣ መጠን (ETB)',
    'Maallaqa baafamu (ETB)',
    'ዝወጽእ መጠን (ETB)',
    'Qaddarka la bixinayo (ETB)',
    'مبلغ السحب (ETB)',
    'Kiasi cha kutoa (ETB)',
    'Montant du retrait (ETB)'
  ),
  Withdrawal: tr('ወጪ', 'Baasii', 'ምውጻእ', 'La-bixid', 'سحب', 'Utoaji', 'Retrait'),
  'Withdrawal must exceed {value} USDT at this rate.': tr(
    'በዚህ ተመን ወጪው ከ{value} USDT በላይ መሆን አለበት።',
    'Reetii kanaan baasuun {value} USDT caaluu qaba.',
    'በዚ ተመን ምውጻእ ካብ {value} USDT ክበልጽ ኣለዎ።',
    'La-bixiddu waa inay ka badataa {value} USDT sicirkan.',
    'يجب أن يتجاوز السحب {value} USDT بهذا السعر.',
    'Utoaji lazima uzidi {value} USDT kwa kiwango hiki.',
    'Le retrait doit dépasser {value} USDT à ce taux.'
  ),
  'Withdrawal requests': tr(
    'የወጪ ጥያቄዎች',
    'Gaaffiiwwan baasii',
    'ሕቶታት ምውጻእ',
    'Codsiyada la-bixidda',
    'طلبات السحب',
    'Maombi ya kutoa',
    'Demandes de retrait'
  ),
  Withdrawals: tr(
    'ወጪዎች',
    'Baasiiwwan',
    'ምውጻእ ገንዘብ',
    'La-bixitaannada',
    'السحوبات',
    'Utoaji wa pesa',
    'Retraits'
  ),
  'Withdrawals are awaiting payment setup': tr(
    'ወጪዎች የክፍያ ዝግጅትን እየጠበቁ ናቸው',
    'Baasiiwwan qophii kaffaltii eegaa jiru',
    'ምውጻእ ገንዘብ ምድላው ክፍሊት ይጽበ ኣሎ',
    'La-bixitaannadu waxay sugayaan dejinta lacag-bixinta',
    'السحوبات بانتظار إعداد الدفع',
    'Utoaji unasubiri mipangilio ya malipo',
    'Les retraits attendent la configuration des paiements'
  ),
  'Withdrawals follow your account eligibility.': tr(
    'ወጪዎች የመለያዎን ብቁነት ይከተላሉ።',
    'Baasuun ulaagaa herrega keetii hordofa.',
    'ምውጻእ ገንዘብ ብቕዓት መለያኻ ይኽተል።',
    'La-bixitaannadu waxay raacaan u-qalmitaanka koontadaada.',
    'تخضع السحوبات لأهلية حسابك.',
    'Utoaji hufuata ustahiki wa akaunti yako.',
    'Les retraits dépendent de l’éligibilité de votre compte.'
  ),
  'Withdrawals still require account and country eligibility. Game Points and free practice credits are separate from your Birr balance.':
    tr(
      'ወጪዎች አሁንም የመለያ እና የአገር ብቁነት ይፈልጋሉ። የጨዋታ ነጥቦች እና ነፃ የልምምድ ክሬዲቶች ከብር ሂሳብዎ የተለዩ ናቸው።',
      'Baasuun ammallee ulaagaa herregaa fi biyya barbaada. Qabxiin Taphaa fi qabxiin shaakalaa bilisaa haftee Birrii kee irraa adda.',
      'ምውጻእ ገንዘብ ገና ብቕዓት መለያን ሃገርን ይደሊ። ነጥብታት ጸወታን ነጻ ክሬዲት ልምምድን ካብ ሒሳብ ብርካ ዝተፈለዩ እዮም።',
      'La-bixitaannadu weli waxay u baahan yihiin u-qalmitaanka koontada iyo dalka. Dhibcaha Ciyaarta iyo dhibcaha tababarka bilaashka ahi way ka gooni yihiin haraaga Birr.',
      'السحوبات ما زالت تتطلب أهلية الحساب والبلد. نقاط اللعبة وأرصدة التدريب المجانية منفصلة عن رصيد بير.',
      'Utoaji bado unahitaji ustahiki wa akaunti na nchi. Alama za Mchezo na vitengo vya mazoezi vya bure ni tofauti na salio la Birr.',
      'Les retraits restent soumis à l’éligibilité du compte et du pays. Les points de jeu et crédits d’entraînement gratuits sont distincts du solde Birr.'
    ),
  Won: tr('አሸንፏል', 'Moʼate', 'ተዓዊቱ', 'Guuleystay', 'فاز', 'Ameshinda', 'Gagné'),
  'YOUR ACCOUNT': tr(
    'የእርስዎ መለያ',
    'HERREGA KEE',
    'መለያኻ',
    'KOONTADAADA',
    'حسابك',
    'AKAUNTI YAKO',
    'VOTRE COMPTE'
  ),
  'YOUR GAMES. YOUR PEOPLE.': tr(
    'የእርስዎ ጨዋታዎች። የእርስዎ ሰዎች።',
    'TAPHOOTA KEE. NAMOOTA KEE.',
    'ጸወታታትካ። ሰባትካ።',
    'CIYAARAHAAGA. DADKAAGA.',
    'ألعابك. أصدقاؤك.',
    'MICHEZO YAKO. WATU WAKO.',
    'VOS JEUX. VOS PROCHES.'
  ),
  'YOUR MEMBERSHIP': tr(
    'የእርስዎ አባልነት',
    'MISEENSUMMAA KEE',
    'ኣባልነትካ',
    'XUBINNIMADAADA',
    'عضويتك',
    'UANACHAMA WAKO',
    'VOTRE ADHÉSION'
  ),
  'YOUR MONEY, CLEARLY TRACKED': tr(
    'ገንዘብዎ፣ በግልጽ የሚከታተል',
    'MAALLAQA KEE, IFATTI HORDOFAME',
    'ገንዘብካ፣ ብንጹር ዝከታተል',
    'LACAGTAADA, SI CAD LOO RAACAY',
    'أموالك، بتتبّع واضح',
    'PESA ZAKO, ZINAFUATILIWA WAZI',
    'VOTRE ARGENT, SUIVI CLAIREMENT'
  ),
  You: tr('እርስዎ', 'Ati', 'ንስኻ', 'Adiga', 'أنت', 'Wewe', 'Vous'),
  'You are not a member of any groups yet.': tr(
    'እስካሁን የማንኛውም ቡድን አባል አይደሉም።',
    'Ammallee miseensa garee kamiyyuu miti.',
    'ገና ኣባል ዝኾነ ጉጅለ ኣይኮንካን።',
    'Weli xubin kama tihid kooxna.',
    'لست عضوًا في أي مجموعة بعد.',
    'Bado si mwanachama wa kikundi chochote.',
    'Vous ne faites encore partie d’aucun groupe.'
  ),
  'You can keep using the website without installing. An internet connection is needed to play.':
    tr(
      'ሳይጭኑ ድረ ገጹን መጠቀም መቀጠል ይችላሉ። ለመጫወት የበይነመረብ ግንኙነት ያስፈልጋል።',
      'Osoo hin feʼin marsariitii fayyadamuu itti fufuu dandeessa. Taphachuuf walqunnamtii interneetii barbaachisa.',
      'ከይጸዓንካ ድረ ገጽ ምጥቃም ክትቅጽል ትኽእል። ንምጽዋት ርክብ ኢንተርነት የድሊ።',
      'Waxaad sii isticmaali kartaa website-ka adigoon rakibin. Internet ayaa loo baahan yahay si loo ciyaaro.',
      'يمكنك متابعة استخدام الموقع دون تثبيت. يلزم اتصال بالإنترنت للعب.',
      'Unaweza kuendelea kutumia tovuti bila kusakinisha. Muunganisho wa intaneti unahitajika kucheza.',
      'Vous pouvez continuer sur le site sans installation. Une connexion Internet est nécessaire pour jouer.'
    ),
  'You can save your payout account below. Requests open after payout services are activated.': tr(
    'የመቀበያ ሂሳብዎን ከታች ማስቀመጥ ይችላሉ። የክፍያ አገልግሎቶች ከተነቁ በኋላ ጥያቄዎች ይከፈታሉ።',
    'Herrega kaffaltii fudhannaa kee armaan gaditti olkaaʼuu dandeessa. Gaaffiin tajaajilli kaffaltii hojiirra ooluu booda banama.',
    'ሒሳብ መቐበሊኻ ኣብ ታሕቲ ክትዕቅብ ትኽእል። ኣገልግሎት ክፍሊት ድሕሪ ምንቃሑ ሕቶታት ይኽፈቱ።',
    'Hoos ayaad ku kaydin kartaa koontada lacag-qaadashada. Codsiyadu waxay furmaan marka adeegyada lacag-bixinta la hawlgeliyo.',
    'يمكنك حفظ حساب استلامك أدناه. تُفتح الطلبات بعد تفعيل خدمات الدفع.',
    'Unaweza kuhifadhi akaunti ya kupokea hapa chini. Maombi hufunguliwa huduma za malipo zikiwashwa.',
    'Vous pouvez enregistrer votre compte de versement ci-dessous. Les demandes ouvriront après activation des services de paiement.'
  ),
  'You challenged {value}': tr(
    '{value}ን ፈትነዋል',
    'Ati {value} morkatte',
    'ን{value} ተፈቲንካዮ',
    'Waxaad tartan ku casuuntay {value}',
    'تحدّيت {value}',
    'Umempa {value} changamoto',
    'Vous avez défié {value}'
  ),
  'You have completed all {playLimit} rounds.': tr(
    'ሁሉንም {playLimit} ዙሮች አጠናቀዋል።',
    'Marsaa {playLimit} hunda xumurteetta.',
    'ኩሎም {playLimit} ዙራት ወዲእካ።',
    'Waxaad dhammaysay dhammaan {playLimit} wareeg.',
    'أكملت كل الجولات البالغ عددها {playLimit}.',
    'Umekamilisha raundi zote {playLimit}.',
    'Vous avez terminé les {playLimit} manches.'
  ),
  'You lost': tr(
    'ተሸንፈዋል',
    'Moʼamte',
    'ተሳዒርካ',
    'Waad guuldarreysatay',
    'خسرت',
    'Umeshindwa',
    'Vous avez perdu'
  ),
  'You lost {entryAmount} GP': tr(
    '{entryAmount} GP አጥተዋል',
    '{entryAmount} GP dhabde',
    '{entryAmount} GP ስኢንካ',
    'Waxaad lumisay {entryAmount} GP',
    'خسرت {entryAmount} GP',
    'Umepoteza {entryAmount} GP',
    'Vous avez perdu {entryAmount} GP'
  ),
  'You need {value} more {value2}.': tr(
    'ተጨማሪ {value} {value2} ያስፈልግዎታል።',
    'Dabalataan {value} {value2} si barbaachisa.',
    'ተወሳኺ {value} {value2} የድልየካ።',
    'Waxaad u baahan tahay {value} {value2} oo dheeraad ah.',
    'تحتاج إلى {value} {value2} إضافية.',
    'Unahitaji {value} {value2} zaidi.',
    'Il vous faut encore {value} {value2}.'
  ),
  'You pay': tr(
    'የሚከፍሉት',
    'Ati kaffalta',
    'ትኸፍሎ',
    'Waxaad bixinaysaa',
    'تدفع',
    'Unalipa',
    'Vous payez'
  ),
  'You receive': tr(
    'የሚቀበሉት',
    'Ati fudhatta',
    'ትቕበሎ',
    'Waxaad helaysaa',
    'تستلم',
    'Unapokea',
    'Vous recevez'
  ),
  'You receive at your address': tr(
    'በአድራሻዎ የሚቀበሉት',
    'Teessoo keetti fudhatta',
    'ኣብ ኣድራሻኻ ትቕበሎ',
    'Waxaad ku helaysaa cinwaankaaga',
    'تستلم على عنوانك',
    'Unapokea kwenye anwani yako',
    'Vous recevez à votre adresse'
  ),
  'You receive {value}. Final amount is fixed when the order is created.': tr(
    '{value} ይቀበላሉ። የመጨረሻው መጠን ትዕዛዙ ሲፈጠር ይወሰናል።',
    '{value} fudhatta. Maallaqni dhumaa yeroo ajajni uumamu murtaaʼa.',
    '{value} ትቕበል። መወዳእታ መጠን ትእዛዝ ምስ ተፈጥረ ይውሰን።',
    'Waxaad helaysaa {value}. Qaddarka kama dambaysta ah wuxuu goʼaa marka dalabka la abuuro.',
    'تستلم {value}. يُثبّت المبلغ النهائي عند إنشاء الطلب.',
    'Unapokea {value}. Kiasi cha mwisho huwekwa agizo linapoundwa.',
    'Vous recevez {value}. Le montant final est fixé à la création de la commande.'
  ),
  'You withdraw': tr(
    'የሚያወጡት',
    'Ati baafatta',
    'ተውጽኦ',
    'Waxaad la baxaysaa',
    'تسحب',
    'Unatoa',
    'Vous retirez'
  ),
  'You won {value} GP!': tr(
    '{value} GP አሸንፈዋል!',
    '{value} GP moʼatte!',
    '{value} GP ተዓዊትካ!',
    'Waxaad ku guuleysatay {value} GP!',
    'ربحت {value} GP!',
    'Umeshinda {value} GP!',
    'Vous avez gagné {value} GP !'
  ),
  'You won!': tr(
    'አሸንፈዋል!',
    'Moʼatte!',
    'ተዓዊትካ!',
    'Waad guuleysatay!',
    'فزت!',
    'Umeshinda!',
    'Vous avez gagné !'
  ),
  'You won! 🎉': tr(
    'አሸንፈዋል! 🎉',
    'Moʼatte! 🎉',
    'ተዓዊትካ! 🎉',
    'Waad guuleysatay! 🎉',
    'فزت! 🎉',
    'Umeshinda! 🎉',
    'Vous avez gagné ! 🎉'
  ),
  "You're all caught up.": tr(
    'ሁሉንም አይተዋል።',
    'Hunda argiteetta.',
    'ኩሉ ርኢኻዮ።',
    'Wax walba waad la socotaa.',
    'أنت مطّلع على كل جديد.',
    'Umeona kila kitu kipya.',
    'Vous êtes à jour.'
  ),
  'Your 20 most recent tickets are shown (at most {maxTicketsPerMatchweek} per matchweek). Confirmed tickets are immutable.':
    tr(
      'የቅርብ 20 ትኬቶችዎ ታይተዋል (በግጥሚያ ሳምንት እስከ {maxTicketsPerMatchweek})። የተረጋገጡ ትኬቶች አይቀየሩም።',
      'Tikeetota kee 20 dhihoo agarsiisa (torban taphaa tokkoof olʼaanaa {maxTicketsPerMatchweek}). Tikeetiin mirkanaaʼe hin jijjiiramu.',
      'ናይ ቀረባ 20 ትኬታትካ ይርኣዩ (ኣብ ሰሙን ግጥማት ክሳብ {maxTicketsPerMatchweek})። ዝተረጋገጹ ትኬታት ኣይቅየሩን።',
      '20-ka tigidh ee kuugu dambeeyay ayaa la muujiyay (ugu badnaan {maxTicketsPerMatchweek} usbuuc kasta oo kulamo ah). Tigidhada la xaqiijiyay lama beddeli karo.',
      'تُعرض أحدث 20 تذكرة لك (حتى {maxTicketsPerMatchweek} لكل أسبوع مباريات). التذاكر المؤكدة غير قابلة للتعديل.',
      'Tiketi zako 20 za karibuni zinaonyeshwa (hadi {maxTicketsPerMatchweek} kwa wiki ya mechi). Tiketi zilizothibitishwa hazibadilishwi.',
      'Vos 20 tickets les plus récents sont affichés (maximum {maxTicketsPerMatchweek} par journée). Les tickets confirmés sont non modifiables.'
    ),
};
export default catalogue;
