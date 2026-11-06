import { useLanguage } from '@/providers/language-provider';
import type { MessageValues } from './types';
/** For static interface copy inside class boundaries or rich JSX. */
export function LocalizedText({
  message,
  values,
  translateValues = [],
}: {
  message: string;
  values?: MessageValues;
  /** Only explicitly named source-owned labels, never names or user content. */
  translateValues?: readonly string[];
}) {
  const { t } = useLanguage();
  const displayed =
    values &&
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        translateValues.includes(name) && typeof value === 'string' ? t(value) : value,
      ])
    );
  return <>{t(message, displayed)}</>;
}
