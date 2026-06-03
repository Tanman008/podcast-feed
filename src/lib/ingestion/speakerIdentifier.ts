// lib/ingestion/speakerIdentifier.ts
// Uses GPT-4o to identify speaker names from diarized transcript context.
// Samples the first 25 + last 10 utterances per speaker and looks for name cues:
// self-introductions, direct address, topic expertise, episode title, etc.
// Returns a map of diarization label → resolved name (only populated entries).
//
// Fixes applied:
//   1a. withRetry wrapping — transient 429/5xx no longer silently yields {}
//   1b. brace-depth JSON extraction — gpt-4o trailing commentary no longer breaks parse
//   1c. key normalization — "Speaker 0" / "0 " / "speaker_1" all map to bare label
//   1d. duplicate-name dedup — one name on >1 label keeps only the most-evidenced label
//   1e. junk-name filter — "Host", "Guest", "Unknown", etc. are dropped

import { TranscribedSegment } from './transcriber';
import { extractFirstJsonObject } from '@/lib/utils/json';
import { openai, openaiCall } from '@/lib/openai/client';

// Generic names the model uses when it has no signal — not useful as speaker names.
const JUNK_NAME_RE = /^(host|guest|unknown|speaker|narrator|interviewer|the\s+host|the\s+guest|n\/a|none|person|man|woman|male|female)$/i;

export async function identifySpeakers(
  segments: TranscribedSegment[],
  context?: { episodeTitle?: string; sourceName?: string }
): Promise<Record<string, string>> {
  // Collect first 25 + last 10 utterances per speaker label.
  const fromStart: Record<string, string[]> = {};
  const fromEnd:   Record<string, string[]> = {};

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
    const end   = (fromEnd[label] ?? []).filter(t => !start.includes(t));
    const all   = [...start, ...(end.length ? ['…', ...end] : [])];
    return `Speaker ${label}:\n${all.map(t => `- "${t}"`).join('\n')}`;
  }).join('\n\n');

  const contextLine = [
    context?.sourceName   && `Podcast: ${context.sourceName}`,
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
Use the bare numeric label as the key — NOT "Speaker 0", just "0".
Example: {"0": "Jason Calacanis", "1": "Chamath Palihapitiya", "2": "David Sacks", "3": null}`;

  try {
    const response = await openaiCall(() =>
      openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
      })
    );

    const rawText = response.choices[0]?.message?.content ?? '{}';

    // 1b: brace-depth extraction handles trailing commentary from gpt-4o
    const jsonText = extractFirstJsonObject(rawText) ?? '{}';
    const parsed = JSON.parse(jsonText) as Record<string, string | null>;

    // 1c: normalize keys — "Speaker 0", "speaker_1", "0 ", etc. → bare label
    const validLabels = new Set(labels);
    const normalized: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      // 1e: reject generic/junk names
      if (JUNK_NAME_RE.test(v.trim())) continue;
      const label = k.toLowerCase().replace(/^speaker[\s_]*/i, '').trim();
      if (validLabels.has(label)) normalized[label] = v.trim();
    }

    // 1d: if the same name is assigned to multiple labels, keep only the label
    // with the most utterances (strongest evidence) and drop the rest.
    const byName = new Map<string, string[]>();
    for (const [label, name] of Object.entries(normalized)) {
      const existing = byName.get(name) ?? [];
      existing.push(label);
      byName.set(name, existing);
    }
    for (const [name, labs] of byName) {
      if (labs.length <= 1) continue;
      const keep = labs.sort(
        (a, b) => (fromStart[b]?.length ?? 0) - (fromStart[a]?.length ?? 0)
      )[0];
      for (const l of labs) if (l !== keep) delete normalized[l];
      console.warn(`[identifySpeakers] duplicate name "${name}" on labels [${labs.join(', ')}] — kept label ${keep}`);
    }

    return normalized;
  } catch (err: any) {
    console.error('[identifySpeakers] failed after retries:', err?.message);
    return {};
  }
}
