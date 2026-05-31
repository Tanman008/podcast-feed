// lib/worker/processJob.ts
// Two-pass pipeline orchestration for a single ingestion job
// Pass 1: Fetch → Chunk → Embed → Extract Entities → Persist
// Pass 2: Score Novelty → Mark Complete

import { IngestionJob, TranscriptStatus, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { fetchYouTubeMetadata, fetchTranscript, extractVideoId } from '@/lib/ingestion/youtube';
import { chunkTranscript } from '@/lib/ingestion/chunker';
import { embedChunks } from '@/lib/ingestion/embedder';
import { analyzeChunksBatch } from '@/lib/ingestion/entityExtractor';
import { checkIsDuplicate } from '@/lib/ingestion/deduplication';
import { scoreNoveltyBatch } from '@/lib/scoring/novelty';
import { completeJob, failJob, updateJobProgress } from './claim';

export async function processJob(job: IngestionJob): Promise<void> {
  console.log(`[Job ${job.id}] Starting ingestion of ${job.videoUrl}`);

  try {
    // Extract video ID from URL
    const videoId = extractVideoId(job.videoUrl);
    if (!videoId) {
      await failJob(job.id, 'Invalid YouTube URL');
      return;
    }

    // ───────────────────────────────────────────────────────────────────────
    // PASS 1: Persist chunks + embeddings + entities + conviction
    // ───────────────────────────────────────────────────────────────────────

    console.log(`[Job ${job.id}] Pass 1: Fetching transcript...`);

    // 1. Fetch YouTube metadata & transcript
    const transcript = await fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      await failJob(job.id, 'Transcript unavailable for this video');
      return;
    }

    const fullTranscriptText = transcript.map(s => s.text).join(' ');

    // Check for duplicates (Phase 1: videoId uniqueness, Phase 2: hash)
    const duplicate = await checkIsDuplicate(videoId, job.sourceId, fullTranscriptText);
    if (duplicate.isDuplicate) {
      await failJob(job.id, `Duplicate episode: ${duplicate.reason}`);
      return;
    }

    // Upsert episode with status = processing
    const episode = await db.episode.upsert({
      where: {
        sourceId_externalId: {
          sourceId: job.sourceId,
          externalId: videoId,
        },
      },
      update: {
        transcriptStatus: TranscriptStatus.processing,
        rawTranscript: fullTranscriptText,
      },
      create: {
        sourceId: job.sourceId,
        externalId: videoId,
        title: `Video ${videoId}`, // Placeholder
        transcriptStatus: TranscriptStatus.processing,
        rawTranscript: fullTranscriptText,
      },
    });

    await updateJobProgress(job.id, 5, 0);

    // 2. Run chunker
    console.log(`[Job ${job.id}] Chunking transcript...`);
    const chunks = await chunkTranscript(transcript);

    if (chunks.length === 0) {
      await failJob(job.id, 'No valid chunks generated from transcript');
      return;
    }

    await updateJobProgress(job.id, 10, 0, chunks.length);

    // 3. Batch embed all chunks (one OpenAI call)
    console.log(`[Job ${job.id}] Embedding ${chunks.length} chunks...`);
    const embeddings = await embedChunks(chunks);

    if (embeddings.length !== chunks.length) {
      throw new Error('Embedding count mismatch');
    }

    await updateJobProgress(job.id, 25, 0, chunks.length);

    // 4. For each chunk: entity extraction + conviction + speaker guess
    console.log(`[Job ${job.id}] Analyzing chunks (concurrency 8)...`);
    const analyses = await analyzeChunksBatch(chunks, {
      concurrency: 8,
    });

    await updateJobProgress(job.id, 40, 0, chunks.length);

    // 5. Persist all chunks + ChunkEntity links
    console.log(`[Job ${job.id}] Persisting chunks...`);

    let totalEntityCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      const analysis = analyses[i];

      // Find or create speaker if identified
      let speakerId: string | null = null;
      if (analysis.speakerGuess) {
        const normalizedName = analysis.speakerGuess
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .trim();

        const speaker = await db.speaker.upsert({
          where: { normalizedName },
          update: {},
          create: {
            name: analysis.speakerGuess,
            normalizedName,
          },
        });

        speakerId = speaker.id;
      }

      // Create chunk (embedding set separately via raw SQL — Prisma Unsupported type)
      const dbChunk = await db.transcriptChunk.create({
        data: {
          episodeId: episode.id,
          speakerId,
          chunkIndex: i,
          text: chunk.text,
          cleanedText: chunk.cleanedText,
          startTimeSeconds: chunk.startTimeSeconds,
          endTimeSeconds: chunk.endTimeSeconds,
          tokenCount: chunk.tokenCount,
          convictionScore: analysis.convictionScore,
          // noveltyScore set in Pass 2
        },
      });

      await db.$executeRaw`
        UPDATE "TranscriptChunk"
        SET embedding = ${JSON.stringify(embedding)}::vector
        WHERE id = ${dbChunk.id}
      `;

      totalEntityCount += analysis.entities.length;
      // Upsert entities and create ChunkEntity links
      for (const extractedEntity of analysis.entities) {
        const entity = await db.entity.upsert({
          where: {
            normalizedName_entityType: {
              normalizedName: extractedEntity.normalizedName,
              entityType: extractedEntity.entityType,
            },
          },
          update: {},
          create: {
            name: extractedEntity.name,
            normalizedName: extractedEntity.normalizedName,
            entityType: extractedEntity.entityType,
            ticker: extractedEntity.ticker || null,
          },
        });

        await db.chunkEntity.upsert({
          where: {
            chunkId_entityId: {
              chunkId: dbChunk.id,
              entityId: entity.id,
            },
          },
          update: {
            confidence: extractedEntity.confidence,
            mentionType: extractedEntity.mentionType,
          },
          create: {
            chunkId: dbChunk.id,
            entityId: entity.id,
            confidence: extractedEntity.confidence,
            mentionType: extractedEntity.mentionType,
          },
        });
      }

      // Update progress per chunk
      await updateJobProgress(job.id, 40 + (i / chunks.length) * 10, i + 1, chunks.length);
    }

    await updateJobProgress(job.id, 50, chunks.length, chunks.length);

    // ───────────────────────────────────────────────────────────────────────
    // PASS 2: Score novelty (now that chunks are persisted + entity links exist)
    // ───────────────────────────────────────────────────────────────────────

    console.log(`[Job ${job.id}] Pass 2: Scoring novelty...`);
    await scoreNoveltyBatch(episode.id);

    await updateJobProgress(job.id, 90, chunks.length, chunks.length);

    // Mark episode as completed
    await db.episode.update({
      where: { id: episode.id },
      data: {
        transcriptStatus: TranscriptStatus.completed,
      },
    });

    await completeJob(job.id, episode.id);

    console.log(
      `[Job ${job.id}] ✅ Complete: ${chunks.length} chunks, ` +
      `${totalEntityCount} entity links, novelty scored`
    );
  } catch (error: any) {
    console.error(`[Job ${job.id}] ❌ Error:`, error);
    const errorMessage = error?.message || 'Unknown error during ingestion';
    await failJob(job.id, errorMessage);
  }
}
