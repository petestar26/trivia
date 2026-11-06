import type { TranslationCatalog } from '../types';
const catalogue: TranslationCatalog = {
  'Ticket · {count} selections': {
    am: { one: 'ትኬት · {count} ምርጫ', other: 'ትኬት · {count} ምርጫዎች' },
    om: { one: 'Tikeetii · filannoo {count}', other: 'Tikeetii · filannoowwan {count}' },
    ti: { one: 'ትኬት · {count} ምርጫ', other: 'ትኬት · {count} ምርጫታት' },
    so: { one: 'Tigidh · {count} doorasho', other: 'Tigidh · {count} doorasho' },
    ar: {
      zero: 'تذكرة · لا اختيارات',
      one: 'تذكرة · اختيار واحد',
      two: 'تذكرة · اختياران',
      few: 'تذكرة · {count} اختيارات',
      many: 'تذكرة · {count} اختيارًا',
      other: 'تذكرة · {count} اختيار',
    },
    sw: { one: 'Tiketi · chaguo {count}', other: 'Tiketi · machaguo {count}' },
    fr: { one: 'Ticket · {count} sélection', other: 'Ticket · {count} sélections' },
  },
  'A ticket confirmation is unresolved ({count} lines, {amount} ETB). Checking it again cannot charge you twice.':
    {
      am: {
        one: 'የትኬት ማረጋገጫ አልተጠናቀቀም ({count} መስመር፣ {amount} ETB)። እንደገና መፈተሽ ሁለት ጊዜ አያስከፍልዎትም።',
        other: 'የትኬት ማረጋገጫ አልተጠናቀቀም ({count} መስመሮች፣ {amount} ETB)። እንደገና መፈተሽ ሁለት ጊዜ አያስከፍልዎትም።',
      },
      om: {
        one: 'Mirkaneessi tikeetii hin xumuramne (sarara {count}, {amount} ETB). Irra deebiʼanii ilaaluun yeroo lama si hin kaffalchiisu.',
        other:
          'Mirkaneessi tikeetii hin xumuramne (sararoota {count}, {amount} ETB). Irra deebiʼanii ilaaluun yeroo lama si hin kaffalchiisu.',
      },
      ti: {
        one: 'ምርግጋጽ ትኬት ኣይተወድአን ({count} መስመር፣ {amount} ETB)። ዳግም ምፍታሽ ክልተ ግዜ ኣየኽፍለካን።',
        other: 'ምርግጋጽ ትኬት ኣይተወድአን ({count} መስመራት፣ {amount} ETB)። ዳግም ምፍታሽ ክልተ ግዜ ኣየኽፍለካን።',
      },
      so: {
        one: 'Xaqiijinta tigidh weli lama xallin ({count} sadar, {amount} ETB). Hubinta mar kale laba jeer lacag kaama jari karto.',
        other:
          'Xaqiijinta tigidh weli lama xallin ({count} sadar, {amount} ETB). Hubinta mar kale laba jeer lacag kaama jari karto.',
      },
      ar: {
        zero: 'تأكيد تذكرة لم يُحسم (بلا أسطر، {amount} ETB). التحقق مجددًا لا يخصم منك مرتين.',
        one: 'تأكيد تذكرة لم يُحسم (سطر واحد، {amount} ETB). التحقق مجددًا لا يخصم منك مرتين.',
        two: 'تأكيد تذكرة لم يُحسم (سطران، {amount} ETB). التحقق مجددًا لا يخصم منك مرتين.',
        few: 'تأكيد تذكرة لم يُحسم ({count} أسطر، {amount} ETB). التحقق مجددًا لا يخصم منك مرتين.',
        many: 'تأكيد تذكرة لم يُحسم ({count} سطرًا، {amount} ETB). التحقق مجددًا لا يخصم منك مرتين.',
        other: 'تأكيد تذكرة لم يُحسم ({count} سطر، {amount} ETB). التحقق مجددًا لا يخصم منك مرتين.',
      },
      sw: {
        one: 'Uthibitisho wa tiketi haujakamilika (mstari {count}, {amount} ETB). Kuikagua tena hakuwezi kukutoza mara mbili.',
        other:
          'Uthibitisho wa tiketi haujakamilika (mistari {count}, {amount} ETB). Kuikagua tena hakuwezi kukutoza mara mbili.',
      },
      fr: {
        one: 'Une confirmation de ticket reste en attente ({count} ligne, {amount} ETB). La vérifier à nouveau ne peut pas vous débiter deux fois.',
        other:
          'Une confirmation de ticket reste en attente ({count} lignes, {amount} ETB). La vérifier à nouveau ne peut pas vous débiter deux fois.',
      },
    },
  'Prices changed for {count} selections. Accept the updated prices before confirming.': {
    am: {
      one: 'የ{count} ምርጫ ዋጋ ተቀይሯል። ከማረጋገጥዎ በፊት የተዘመኑትን ዋጋዎች ይቀበሉ።',
      other: 'የ{count} ምርጫዎች ዋጋዎች ተቀይረዋል። ከማረጋገጥዎ በፊት የተዘመኑትን ዋጋዎች ይቀበሉ።',
    },
    om: {
      one: 'Gatiin filannoo {count} jijjiirameera. Mirkaneessuu dura gatii haaromfame fudhadhu.',
      other:
        'Gatiin filannoowwan {count} jijjiirameera. Mirkaneessuu dura gatii haaromfame fudhadhu.',
    },
    ti: {
      one: 'ዋጋ {count} ምርጫ ተቐይሩ። ቅድሚ ምርግጋጽካ ዝተሓደሱ ዋጋታት ተቐበል።',
      other: 'ዋጋታት {count} ምርጫታት ተቐይሮም። ቅድሚ ምርግጋጽካ ዝተሓደሱ ዋጋታት ተቐበል።',
    },
    so: {
      one: 'Qiimaha {count} doorasho wuu is beddelay. Aqbal qiimayaasha cusub ka hor xaqiijinta.',
      other:
        'Qiimayaasha {count} doorasho way is beddeleen. Aqbal qiimayaasha cusub ka hor xaqiijinta.',
    },
    ar: {
      zero: 'لم تتغير أسعار أي اختيارات. اقبل الأسعار المحدثة قبل التأكيد.',
      one: 'تغيّر سعر اختيار واحد. اقبل الأسعار المحدثة قبل التأكيد.',
      two: 'تغيّر سعر اختيارين. اقبل الأسعار المحدثة قبل التأكيد.',
      few: 'تغيّرت أسعار {count} اختيارات. اقبل الأسعار المحدثة قبل التأكيد.',
      many: 'تغيّرت أسعار {count} اختيارًا. اقبل الأسعار المحدثة قبل التأكيد.',
      other: 'تغيّرت أسعار {count} اختيار. اقبل الأسعار المحدثة قبل التأكيد.',
    },
    sw: {
      one: 'Bei imebadilika kwa chaguo {count}. Kubali bei zilizosasishwa kabla ya kuthibitisha.',
      other:
        'Bei zimebadilika kwa machaguo {count}. Kubali bei zilizosasishwa kabla ya kuthibitisha.',
    },
    fr: {
      one: 'La cote a changé pour {count} sélection. Acceptez les cotes actualisées avant de confirmer.',
      other:
        'Les cotes ont changé pour {count} sélections. Acceptez les cotes actualisées avant de confirmer.',
    },
  },
  sec: { am: 'ሰከንድ', om: 'sek', ti: 'ካልኢት', so: 'ilb', ar: 'ث', sw: 'sek', fr: 's' },
};
export default catalogue;
