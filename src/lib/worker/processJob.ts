// lib/worker/processJob.ts
// Two-pass pipeline orchestration for a single ingestion job.
// Pass 1: Download audio → Transcribe (Deepgram) → Chunk → Embed → Extract Entities → Persist
// Pass 2: Score Novelty → Mark Complete

import { IngestionJob, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { fetchEpisodeMetadata } from '@/lib/ingestion/episodeMetadata';
import { downloadFromUrl } from '@/lib/ingestion/audioDownloader';
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
  const episodeUrl = (job as any).episodeUrl as string;
  console.log(`[Job ${job.id}] Starting ingestion of ${episodeUrl}`);

  try {
    // ───────────────────────────────────────────────────────────────────────
    // PASS 1: Persist chunks + embeddings + entities + conviction
    // ───────────────────────────────────────────────────────────────────────

    // 1. Resolve episode — use pre-populated episode if RSS monitor already created it,
    //    otherwise fall back to Podcast Index metadata lookup.
    const sourceSettings = await db.source.findUnique({
      where: { id: job.sourceId },
      select: { minDurationSeconds: true, maxDurationSeconds: true },
    });
    const minSecs = sourceSettings?.minDurationSeconds ?? 60;
    const maxSecs = sourceSettings?.maxDurationSeconds ?? null;

    let audioUrl: string;
    let episode: { id: string };

    const preExisting = job.episodeId
      ? await db.episode.findUnique({
          where: { id: job.episodeId },
          select: { id: true, title: true, durationSeconds: true },
        })
      : null;

    if (preExisting) {
      // Job came from RSS monitor — episode already created, episodeUrl IS the audio URL
      audioUrl = episodeUrl;

      // Duration check using RSS-provided duration
      if (preExisting.durationSeconds !== null) {
        if (preExisting.durationSeconds < minSecs) {
          await failJob(job.id, `Episode too short (${Math.round(preExisting.durationSeconds / 60)}m)`);
          await deleteEpisodeIfExists(preExisting.id);
          return;
        }
        if (maxSecs !== null && preExisting.durationSeconds > maxSecs) {
          await failJob(job.id, `Episode too long (${Math.round(preExisting.durationSeconds / 60)}m)`);
          await deleteEpisodeIfExists(preExisting.id);
          return;
        }
      }

      await db.episode.update({
        where: { id: preExisting.id },
        data: { transcriptStatus: TranscriptStatus.processing },
      });
      episode = preExisting;
    } else {
      // Job came from manual ingest form — resolve via Podcast Index
      console.log(`[Job ${job.id}] Fetching episode metadata...`);
      let metadata: Awaited<ReturnType<typeof fetchEpisodeMetadata>>;
      try {
        metadata = await fetchEpisodeMetadata(episodeUrl);
      } catch (err: any) {
        await failJob(job.id, `Could not resolve episode metadata: ${err.message}`);
        return;
      }

      if (!metadata.audioUrl) {
        await failJob(job.id, 'Episode has no audio URL');
        return;
      }

      const earlyDupCheck = await checkIsDuplicate(metadata.externalId, job.sourceId);
      if (earlyDupCheck.isDuplicate) {
        await failJob(job.id, `Duplicate episode: ${earlyDupCheck.reason}`);
        return;
      }

      if (metadata.durationSeconds !== null) {
        if (metadata.durationSeconds < minSecs) {
          await failJob(job.id, `Episode too short (${Math.round(metadata.durationSeconds / 60)}m)`);
          return;
        }
        if (maxSecs !== null && metadata.durationSeconds > maxSecs) {
          await failJob(job.id, `Episode too long (${Math.round(metadata.durationSeconds / 60)}m)`);
          return;
        }
      }

      episode = await db.episode.upsert({
        where: { sourceId_externalId: { sourceId: job.sourceId, externalId: metadata.externalId } },
        update: { title: metadata.title, transcriptStatus: TranscriptStatus.processing },
        create: {
          sourceId:         job.sourceId,
          externalId:       metadata.externalId,
          title:            metadata.title,
          description:      metadata.description || null,
          thumbnailUrl:     metadata.thumbnailUrl,
          publishedAt:      metadata.publishedAt,
          transcriptStatus: TranscriptStatus.processing,
        },
      });
      audioUrl = metadata.audioUrl;
    }

    await db.ingestionJob.update({ where: { id: job.id }, data: { episodeId: episode.id } });
    await updateJobProgress(job.id, 5, 0);

    // 2. Download audio directly from podcast CDN
    console.log(`[Job ${job.id}] Downloading audio from ${audioUrl}`);
    const audio = await downloadFromUrl(audioUrl, episode.id);
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

    // Post-transcription duration check — safety net when PI metadata had no duration
    if (durationSeconds < minSecs) {
      const mins = Math.round(durationSeconds / 60);
      await failJob(job.id, `Episode too short (${mins}m) — below minimum of ${Math.round(minSecs / 60)}m`);
      await deleteEpisodeIfExists(episode.id);
      return;
    }
    if (maxSecs !== null && durationSeconds > maxSecs) {
      const mins = Math.round(durationSeconds / 60);
      await failJob(job.id, `Episode too long (${mins}m) — above maximum of ${Math.round(maxSecs / 60)}m`);
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
    const episodeTitle = preExisting
      ? preExisting.title
      : (episode as any).title ?? '';
    const speakerNames = await identifySpeakers(segments, {
      episodeTitle,
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
