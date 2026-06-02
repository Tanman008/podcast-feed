// lib/ingestion/transcriber.ts
// Sends audio to Deepgram Nova-2 for transcription + speaker diarization.
// Uses the REST API directly to avoid Deepgram SDK v3 auth issues.

import * as fs from 'fs';
import { withRetry } from '@/lib/utils/retry';

export interface TranscribedSegment {
  text: string;
  offset: number;       // milliseconds (start)
  duration: number;     // milliseconds
  speakerLabel: string; // "0", "1", "2", …
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker: number;
}

interface DeepgramResponse {
  results?: {
    utterances?: DeepgramUtterance[];
  };
  err_code?: string;
  err_msg?: string;
}

export async function transcribeAudio(audioPath: string): Promise<{
  segments: TranscribedSegment[];
  durationSeconds: number;
}> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');

  const audioBuffer = fs.readFileSync(audioPath);

  return withRetry(async () => {
    const url = 'https://api.deepgram.com/v1/listen' +
      '?model=nova-2&diarize=true&utterances=true&punctuate=true&smart_format=true';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'audio/m4a',
      },
      body: audioBuffer,
    });

    const data = await res.json() as DeepgramResponse;

    if (!res.ok) {
      throw new Error(
        `Deepgram ${res.status}: ${data.err_code ?? ''} ${data.err_msg ?? JSON.stringify(data)}`
      );
    }

    const utterances = data.results?.utterances;
    if (!utterances || utterances.length === 0) {
      throw new Error('Deepgram returned no utterances — audio may be silent or too short');
    }

    const segments: TranscribedSegment[] = utterances
      .map(u => ({
        text: u.transcript,
        offset: Math.round(u.start * 1000),
        duration: Math.round((u.end - u.start) * 1000),
        speakerLabel: String(u.speaker ?? '0'),
      }))
      .filter(s => s.text.trim().length > 0);

    const durationSeconds = Math.ceil(utterances[utterances.length - 1].end);

    return { segments, durationSeconds };
  }, { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 30000 });
}
