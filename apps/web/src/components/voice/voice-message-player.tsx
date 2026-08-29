import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { voiceMessageUrl } from '@/lib/api';

interface VoiceMessagePlayerProps {
  groupId: string;
  messageId: string;
  mimeType?: string;
  duration?: number;
  className?: string;
}

function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  const mm = Math.floor(whole / 60)
    .toString()
    .padStart(2, '0');
  const ss = (whole % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export function VoiceMessagePlayer({
  groupId,
  messageId,
  duration = 0,
  className,
}: VoiceMessagePlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [messageId]);

  const total = duration || getAudioDuration(audioRef.current);
  const progress = total > 0 ? Math.min(currentTime / total, 1) : 0;

  return (
    <div className={cn('flex items-center gap-3 rounded-lg bg-muted p-3', className)}>
      <Button type="button" size="icon" variant="secondary" onClick={toggle} aria-label={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? '❚❚' : '▶'}
      </Button>

      <div className="flex flex-1 flex-col gap-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20">
          <div
            className="h-full rounded-full bg-primary-600 transition-[width] duration-150"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatDuration(Math.min(currentTime, total || 0))} / {formatDuration(total)}
        </span>
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={voiceMessageUrl(groupId, messageId)}
        preload="metadata"
        className="hidden"
      />
    </div>
  );
}

function getAudioDuration(audio: HTMLAudioElement | null): number {
  if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
    return audio.duration;
  }
  return 0;
}
