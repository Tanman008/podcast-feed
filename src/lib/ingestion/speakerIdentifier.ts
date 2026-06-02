// lib/ingestion/speakerIdentifier.ts
// Uses GPT-4o-mini to identify speaker names from transcript context.
// Samples the first 10 utterances per speaker and looks for name cues:
// self-introductions, direct address, topic expertise, etc.
// Returns a map of diarization label → resolved name (only populated entries).

import OpenAI from 'openai';
import { TranscribedSegment } from './transcriber';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function identifySpeakers(
  segments: TranscribedSegment[],
  context?: { episodeTitle?: string; sourceName?: string }
): Promise<Record<string, string>> {
  // Collect first 25 + last 10 utterances per speaker, ignoring segments without a label.
  // The host (Speaker 0) rarely introduces themselves up front but may at the end.
  const fromStart: Record<string, string[]> = {};
  const fromEnd: Record<string, string[]> = {};

  for (const seg of segments) {
    const label = seg.speakerLabel;
    if (!label) continue;
    if (!fromStart[label]) fromStart[label] = [];
    if (fromStart[label].length < 25) fromStart[label].push(seg.text);
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const label = segments[i].speakerLabel;
    if (!label) continue;
    if (!fromEnd[label]) fromEnd[label] = [];
    if (fromEnd[label].length < 10) fromEnd[label].unshift(segments[i].text);
  }

  const labels = Object.keys(fromStart);
  if (labels.length === 0) return {};

  const speakerBlock = labels.map(label => {
    const start = fromStart[label] ?? [];
    const end = (fromEnd[label] ?? []).filter(t => !start.includes(t));
    const all = [...start, ...(end.length ? ['…', ...end] : [])];
    return `Speaker ${label}:\n${all.map(t => `- "${t}"`).join('\n')}`;
  }).join('\n\n');

  const contextLine = [
    context?.sourceName && `Podcast: ${context.sourceName}`,
    context?.episodeTitle && `Episode title: "${context.episodeTitle}"`,
  ].filter(Boolean).join('\n');

  const prompt = `You are identifying speakers in a financial podcast transcript.
${contextLine ? `\n${contextLine}\n` : ''}
Rules:
- Speaker 0 is typically the host. Hosts rarely introduce themselves but are often addressed by name or mentioned in the episode title.
- Other speakers are usually guests introduced by the host early in the episode.
- If the episode title contains a person's name (e.g. "Interview with Jensen Huang"), that person is almost certainly Speaker 1.
- Well-known podcast casts (All-In, Acquired, Lex Fridman, Dwarkesh, etc.) have consistent speakers — use your knowledge of the podcast to help.
- Look for patterns like "welcome [name]", "as [name] said", "I'm [name]", or "back to you [name]".

For each speaker below, identify their full name using any available cues.

${speakerBlock}

Return ONLY a JSON object mapping each speaker label string to their full name (or null if genuinely unknown).
Example: {"0": "Jason Calacanis", "1": "Chamath Palihapitiya", "2": "David Sacks", "3": null}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0,
    });

    const text = (response.choices[0]?.message?.content ?? '{}').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');

    const parsed = JSON.parse(text) as Record<string, string | null>;

    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    ) as Record<string, string>;
  } catch {
    return {};
  }
}
