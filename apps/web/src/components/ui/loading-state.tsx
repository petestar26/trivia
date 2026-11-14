import { cn } from '@/lib/utils';
import { useLanguage } from '@/providers/language-provider';
import '@/styles/salem-polish.css';

/**
 * One accessible loading indicator for member and guest pages.
 * The visual mark is decorative; the translated label is what assistive
 * technology announces. Motion stops under prefers-reduced-motion.
 */
export function LoadingState({
  size = 'page',
  className,
}: {
  size?: 'page' | 'inline' | 'fullscreen';
  className?: string;
}) {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      className={cn(
        'salem-loading',
        size === 'inline' && 'is-inline',
        size === 'fullscreen' && 'is-fullscreen',
        className
      )}
    >
      <span className="salem-loading-mark" aria-hidden="true" />
      <span className="salem-loading-label">{t('Loading…')}</span>
    </div>
  );
}
