import { useState, useCallback, useEffect, useRef } from 'react';

const MAX_DURATION_MS = 300 * 1000; // 5 minutes max
const PREFERRED_MIME_TYPE = 'audio/ogg;codecs=opus';

export interface UseVoiceRecorderResult {
  isRecording: boolean;
  isSupported: boolean;
  isUploading: boolean;
  elapsedMs: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
  cancel: () => void;
  mimeType: string;
}

export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState(PREFERRED_MIME_TYPE);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      setIsSupported(false);
    }
  }, []);

  const stopTracks = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
      stopTracks(streamRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, [clearTimer, stopTracks]);

  const start = useCallback(async () => {
    setError(null);

    if (!isSupported) {
      setError('Voice recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const MediaRecorderCtor = window.MediaRecorder;
      const options: MediaRecorderOptions = {};
      if (MediaRecorderCtor.isTypeSupported(PREFERRED_MIME_TYPE)) {
        options.mimeType = PREFERRED_MIME_TYPE;
        setMimeType(PREFERRED_MIME_TYPE);
      } else {
        setMimeType('');
      }

      const recorder = new MediaRecorderCtor(stream, options);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onerror = () => {
        setError('Recording error occurred.');
        setIsRecording(false);
        clearTimer();
        stopTracks(stream);
      };

      recorder.start(250);

      startTimeRef.current = Date.now();
      setElapsedMs(0);
      setIsRecording(true);

      timerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        if (elapsed >= MAX_DURATION_MS) {
          stop();
        } else {
          setElapsedMs(elapsed);
        }
      }, 250);
    } catch (err) {
      setError(
        (err as Error)?.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone access to record.'
          : 'Could not access the microphone.'
      );
    }
  }, [isSupported]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = mediaRecorderRef.current;

    if (!recorder || recorder.state === 'inactive') {
      return null;
    }

    const chunks = chunksRef.current;

    const finished = new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        resolve(blob);
      };
    });

    clearTimer();
    setIsRecording(false);
    stopTracks(streamRef.current);
    streamRef.current = null;
    recorder.stop();

    return finished;
  }, [clearTimer, stopTracks]);

  const cancel = useCallback(() => {
    clearTimer();
    setIsRecording(false);
    stopTracks(streamRef.current);
    streamRef.current = null;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setElapsedMs(0);
  }, [clearTimer, stopTracks]);

  return {
    isRecording,
    isSupported,
    isUploading,
    elapsedMs,
    error,
    start,
    stop,
    cancel,
    mimeType,
  };
}
