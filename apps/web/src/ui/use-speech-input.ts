import { useCallback, useEffect, useRef, useState } from 'react';

/** The parts of the Web Speech API used here (not in TypeScript's DOM types yet). */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Voice input with the browser's own speech recognition: free, nothing to
 * install. In Chrome and Edge the audio is transcribed by the browser
 * vendor's service, which the mic button's tooltip says. `onText` receives
 * the words heard so far (interim, then final).
 */
export function useSpeechInput(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const supported = typeof window !== 'undefined' && recognitionConstructor() !== null;
  const latest = useRef(onText);
  useEffect(() => {
    latest.current = onText;
  }, [onText]);

  useEffect(() => () => recognition.current?.stop(), []);

  const start = useCallback(() => {
    const Recognition = recognitionConstructor();
    if (!Recognition || recognition.current) return;
    const instance = new Recognition();
    instance.lang = navigator.language || 'en-US';
    instance.interimResults = true;
    instance.continuous = false; // stops after a pause, like a walkie-talkie
    let heard = '';
    instance.onresult = (event) => {
      let text = '';
      for (let i = 0; i < event.results.length; i += 1) text += event.results[i]![0]!.transcript;
      heard = text;
      latest.current(heard);
    };
    instance.onerror = (event) => {
      setError(
        event.error === 'not-allowed'
          ? 'The browser blocked the microphone. Allow it in the address bar.'
          : `Voice input stopped (${event.error}).`,
      );
    };
    instance.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = instance;
    setError(null);
    setListening(true);
    instance.start();
  }, []);

  const stop = useCallback(() => recognition.current?.stop(), []);

  return { supported, listening, error, start, stop };
}
