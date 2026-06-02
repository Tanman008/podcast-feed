// lib/worker/processJob.ts
// Two-pass pipeline orchestration for a single ingestion job.
// Pass 1: Download audio → Transcribe (Deepgram) → Chunk → Embed → Extract Entities → Persist
// Pass 2: Score Novelty → Mark Complete

import { IngestionJob, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { fetchYouTubeMetadata, extractVideoId } from '@/lib/ingestion/youtube';
import { downloadAudio, fetchVideoInfo } from '@/lib/ingestion/audioDownloader';
import { transcribeAudio } from '@/lib/ingestion/transcriber';
import { chunkTranscript } from '@/lib/ingestion/chunker';
import { embedChunks } from '@/lib/ingestion/embedder';
import { analyzeChunksBatch } from '@/lib/ingestion/entityExtractor';
import { identifySpeakers } from '@/lib/ingestion/speakerIdentifier';
import { checkIsDuplicate } from '@/lib/ingestion/deduplication';
import { scoreNoveltyBatch } from '@/lib/scoring/novelty';
import { getOrAssessSpeakerAuthority } from '@/lib/scoring/speakerAuthority';
import { completeJob, failJob, updateJobProgress } from './claim';
import { matchEpisodeAgainstAllInterests } from '@/lib/matching/engine';

async function deleteEpisodeIfExists(episodeId: string): Promise<void> {
  try {
    await db.chunkEntity.deleteMany({ where: { chunk: { episodeId } } });
    await db.transcriptChunk.deleteMany({ where: { episodeId } });
    await db.episode.delete({ where: { id: episodeId } });
  } catch {
    // Episode may not exist yet or already deleted — ignore
  }
}

export async function processJob(job: IngestionJob): Promise<void> {
  console.log(`[Job ${job.id}] Starting ingestion of ${job.videoUrl}`);

  try {
    const videoId = extractVideoId(job.videoUrl);
    if (!videoId) {
      await failJob(job.id, 'Invalid YouTube URL');
      return;
    }

    // Reject Shorts submitted via /shorts/ URL — check before spending money on download
    if (job.videoUrl.includes('/shorts/')) {
      await failJob(job.id, 'YouTube Shorts are not supported');
      return;
    }

    // ───────────────────────────────────────────────────────────────────────
    // PASS 1: Persist chunks + embeddings + entities + conviction
    // ───────────────────────────────────────────────────────────────────────

    // 1. Fail fast on duplicate before spending money on audio download
    const earlyDupCheck = await checkIsDuplicate(videoId, job.sourceId);
    if (earlyDupCheck.isDuplicate) {
      await failJob(job.id, `Duplicate episode: ${earlyDupCheck.reason}`);
      return;
    }

    // 2. Fetch title (oEmbed, free — no API key needed)
    console.log(`[Job ${job.id}] Fetching metadata...`);
    const metadata = await fetchYouTubeMetadata(videoId);

    // 3. Upsert episode immediately so job progress is visible in UI
    const episode = await db.episode.upsert({
      where: { sourceId_externalId: { sourceId: job.sourceId, externalId: videoId } },
      update: { title: metadata.title, transcriptStatus: TranscriptStatus.processing },
      create: {
        sourceId: job.sourceId,
        externalId: videoId,
        title: metadata.title,
        thumbnailUrl: metadata.thumbnailUrl,
        publishedAt: null,
        transcriptStatus: TranscriptStatus.processing,
      },
    });

    await db.ingestionJob.update({ where: { id: job.id }, data: { episodeId: episode.id } });
    await updateJobProgress(job.id, 5, 0);

    // 4a. Fetch source duration settings and pre-check video length before downloading
    const sourceSettings = await db.source.findUnique({
      where: { id: job.sourceId },
      select: { minDurationSeconds: true, maxDurationSeconds: true },
    });
    const minSecs = sourceSettings?.minDurationSeconds ?? 60;
    const maxSecs = sourceSettings?.maxDurationSeconds ?? null;

    console.log(`[Job ${job.id}] Pre-checking video duration and date...`);
    const { durationSeconds: preCheckSecs, uploadDate } = await fetchVideoInfo(videoId);
    if (uploadDate) {
      await db.episode.update({ where: { id: episode.id }, data: { publishedAt: uploadDate } });
    }

    if (preCheckSecs !== null) {
      if (preCheckSecs < minSecs) {
        await failJob(job.id, `Video too short (${Math.round(preCheckSecs / 60)}m) — below channel minimum of ${Math.round(minSecs / 60)}m`);
        await deleteEpisodeIfExists(episode.id);
        return;
      }
      if (maxSecs !== null && preCheckSecs > maxSecs) {
        await failJob(job.id, `Video too long (${Math.round(preCheckSecs / 60)}m) — above channel maximum of ${Math.round(maxSecs / 60)}m`);
        await deleteEpisodeIfExists(episode.id);
        return;
      }
    }

    // 4b. Download audio via yt-dlp
    console.log(`[Job ${job.id}] Downloading audio...`);
    const audio = await downloadAudio(videoId);
    await updateJobProgress(job.id, 15, 0);

    // 5. Transcribe + diarize via Deepgram
    console.log(`[Job ${job.id}] Transcribing with Deepgram...`);
    let transcription: Awaited<ReturnType<typeof transcribeAudio>>;
    try {
      transcription = await transcribeAudio(audio.path);
    } finally {
      audio.cleanup(); // always delete temp audio file
    }

    const { segments, durationSeconds } = transcription;

    if (segments.length === 0) {
      await failJob(job.id, 'No transcript segments returned by Deepgram');
      await deleteEpisodeIfExists(episode.id);
      return;
    }

    // Post-transcription duration check — safety net in case yt-dlp metadata was unavailable above
    if (durationSeconds < minSecs) {
      const mins = Math.round(durationSeconds / 60);
      await failJob(job.id, `Video too short (${mins}m) — below channel minimum of ${Math.round(minSecs / 60)}m`);
      await deleteEpisodeIfExists(episode.id);
      return;
    }
    if (maxSecs !== null && durationSeconds > maxSecs) {
      const mins = Math.round(durationSeconds / 60);
      await failJob(job.id, `Video too long (${mins}m) — above channel maximum of ${Math.round(maxSecs / 60)}m`);
      await deleteEpisodeIfExists(episode.id);
      return;
    }

    // Persist raw transcript text and duration on episode
    const rawTranscript = segments.map(s => s.text).join(' ');
    await db.episode.update({
      where: { id: episode.id },
      data: { rawTranscript, durationSeconds },
    });

    // Identify speaker names from transcript context (best-effort, non-blocking)
    console.log(`[Job ${job.id}] Identifying speakers...`);
    const source = await db.source.findUnique({ where: { id: job.sourceId }, select: { name: true } });
    const speakerNames = await identifySpeakers(segments, {
      episodeTitle: metadata.title,
      sourceName: source?.name ?? undefined,
    }).catch(() => ({} as Record<string, string>));

    // Assess speaker authority for each unique resolved name (cached per Speaker record)
    const uniqueSpeakerNames = [...new Set(Object.values(speakerNames))];
    const authorityScores: Record<string, number> = {};
    await Promise.all(
      uniqueSpeakerNames.map(async name => {
        authorityScores[name] = await getOrAssessSpeakerAuthority(name).catch(() => 0.5);
      })
    );

    // Delete any chunks from a previous failed run
    await db.transcriptChunk.deleteMany({ where: { episodeId: episode.id } });
    await updateJobProgress(job.id, 25, 0);

    // 6. Chunk (speaker-turn-aware)
    console.log(`[Job ${job.id}] Chunking transcript...`);
    const chunks = await chunkTranscript(segments);

    if (chunks.length === 0) {
      await failJob(job.id, 'No valid chunks generated from transcript');
      await deleteEpisodeIfExists(episode.id);
      return;
    }

    await updateJobProgress(job.id, 30, 0, chunks.length);

    // 7. Batch embed all chunks (one OpenAI call)
    console.log(`[Job ${job.id}] Embedding ${chunks.length} chunks...`);
    const embeddings = await embedChunks(chunks);

    if (embeddings.length !== chunks.length) {
      throw new Error('Embedding count mismatch');
    }

    await updateJobProgress(job.id, 45, 0, chunks.length);

    // 8. Entity extraction + conviction (GPT-4o-mini, concurrency 8)
    console.log(`[Job ${job.id}] Analyzing chunks (GPT-4o-mini, concurrency 8)...`);
    const analyses = await analyzeChunksBatch(chunks, { concurrency: 8 });

    await updateJobProgress(job.id, 60, 0, chunks.length);

    // 9. Persist chunks, embeddings, entities
    console.log(`[Job ${job.id}] Persisting chunks...`);
    let totalEntityCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const analysis = analyses[i];

      const dbChunk = await db.transcriptChunk.create({
        data: {
          episodeId: episode.id,
          speakerId: null,
          chunkIndex: i,
          text: chunk.text,
          cleanedText: chunk.cleanedText,
          keyQuote: analysis.keyQuote ?? null,
          keyPhrase: analysis.keyPhrase ?? null,
          startTimeSeconds: chunk.startTimeSeconds,
          endTimeSeconds: chunk.endTimeSeconds,
          tokenCount: chunk.tokenCount,
          importanceScore: analysis.claimSpecificityScore,
          convictionScore: analysis.forwardLookingScore,
          speakerLabel: chunk.speakerLabel ?? null,
          speakerName: chunk.speakerLabel ? (speakerNames[chunk.speakerLabel] ?? null) : null,
          relevanceScore: (() => {
            const name = chunk.speakerLabel ? (speakerNames[chunk.speakerLabel] ?? null) : null;
            return name ? (authorityScores[name] ?? null) : null;
          })(),
        },
      });

      await db.$executeRaw`
        UPDATE "TranscriptChunk"
        SET embedding = ${JSON.stringify(embedding)}::vector
        WHERE id = ${dbChunk.id}
      `;

      // Persist claims extracted in the combined LLM call
      for (const claim of analysis.claims) {
        await db.claim.create({
          data: {
            chunkId:            dbChunk.id,
            highlight:          claim.highlight,
            startSentenceIndex: claim.startSentenceIndex ?? 0,
            endSentenceIndex:   claim.endSentenceIndex   ?? 0,
            primarySubject:     claim.primarySubject     ?? null,
            mentionedEntities:  claim.mentionedEntities  ?? [],
            claimType:          claim.claimType,
            specificity:        claim.specificity,
            completeness:       claim.completeness,
            gloss:              claim.gloss ?? null,
            numbers:            claim.numbers ?? [],
          },
        });
      }

      totalEntityCount += analysis.entities.length;

      for (const extractedEntity of analysis.entities) {
        const entity = await db.entity.upsert({
          where: {
            normalizedName_entityType: {
              normalizedName: extractedEntity.normalizedName,
              entityType: extractedEntity.entityType,
            },
          },
          update: { ticker: extractedEntity.ticker || null },
          create: {
            name: extractedEntity.name,
            normalizedName: extractedEntity.normalizedName,
            entityType: extractedEntity.entityType,
            ticker: extractedEntity.ticker || null,
          },
        });

        await db.chunkEntity.upsert({
          where: { chunkId_entityId: { chunkId: dbChunk.id, entityId: entity.id } },
          update: { confidence: extractedEntity.confidence, mentionType: extractedEntity.mentionType },
          create: {
            chunkId: dbChunk.id,
            entityId: entity.id,
            confidence: extractedEntity.confidence,
            mentionType: extractedEntity.mentionType,
          },
        });
      }

      await updateJobProgress(job.id, 60 + (i / chunks.length) * 20, i + 1, chunks.length);
    }

    await updateJobProgress(job.id, 80, chunks.length, chunks.length);

    // ───────────────────────────────────────────────────────────────────────
    // PASS 2: Score novelty (chunks + entity links now exist)
    // ───────────────────────────────────────────────────────────────────────

    console.log(`[Job ${job.id}] Pass 2: Scoring novelty...`);
    await scoreNoveltyBatch(episode.id);

    await updateJobProgress(job.id, 95, chunks.length, chunks.length);

    await db.episode.update({
      where: { id: episode.id },
      data: { transcriptStatus: TranscriptStatus.completed },
    });

    await completeJob(job.id, episode.id);

    matchEpisodeAgainstAllInterests(episode.id).catch(err =>
      console.error(`[Job ${job.id}] Interest matching failed:`, err)
    );

    console.log(
      `[Job ${job.id}] ✅ Complete: ${chunks.length} chunks, ` +
      `${totalEntityCount} entity links, novelty scored`
    );
  } catch (error: any) {
    console.error(`[Job ${job.id}] ❌ Error:`, error);
    await failJob(job.id, error?.message || 'Unknown error during ingestion');
    const episodeId = (await db.ingestionJob.findUnique({ where: { id: job.id }, select: { episodeId: true } }))?.episodeId;
    if (episodeId) await deleteEpisodeIfExists(episodeId);
  }
}
