-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('ticker', 'company', 'person', 'investor', 'executive', 'topic', 'product', 'sector', 'fund');

-- CreateEnum
CREATE TYPE "MentionType" AS ENUM ('direct', 'implied', 'contextual');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('youtube', 'spotify', 'apple_podcast', 'earnings_call', 'x_space', 'interview', 'conference');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('pending', 'processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "ChunkEntity" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "mentionType" "MentionType" NOT NULL DEFAULT 'direct',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChunkEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "ticker" TEXT,
    "description" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "publishedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "thumbnailUrl" TEXT,
    "transcriptStatus" "TranscriptStatus" NOT NULL DEFAULT 'pending',
    "rawTranscript" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feed" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedEntity" (
    "id" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Speaker" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "bio" TEXT,
    "imageUrl" TEXT,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Speaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptChunk" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "speakerId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "cleanedText" TEXT NOT NULL,
    "summary" TEXT,
    "startTimeSeconds" DOUBLE PRECISION NOT NULL,
    "endTimeSeconds" DOUBLE PRECISION NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector,
    "importanceScore" DOUBLE PRECISION,
    "noveltyScore" DOUBLE PRECISION,
    "convictionScore" DOUBLE PRECISION,
    "relevanceScore" DOUBLE PRECISION,
    "sentimentScore" DOUBLE PRECISION,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChunkEntity_chunkId_entityId_key" ON "ChunkEntity"("chunkId" ASC, "entityId" ASC);

-- CreateIndex
CREATE INDEX "ChunkEntity_chunkId_idx" ON "ChunkEntity"("chunkId" ASC);

-- CreateIndex
CREATE INDEX "ChunkEntity_confidence_idx" ON "ChunkEntity"("confidence" ASC);

-- CreateIndex
CREATE INDEX "ChunkEntity_entityId_idx" ON "ChunkEntity"("entityId" ASC);

-- CreateIndex
CREATE INDEX "Entity_entityType_idx" ON "Entity"("entityType" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Entity_normalizedName_entityType_key" ON "Entity"("normalizedName" ASC, "entityType" ASC);

-- CreateIndex
CREATE INDEX "Entity_ticker_idx" ON "Entity"("ticker" ASC);

-- CreateIndex
CREATE INDEX "Episode_publishedAt_idx" ON "Episode"("publishedAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Episode_sourceId_externalId_key" ON "Episode"("sourceId" ASC, "externalId" ASC);

-- CreateIndex
CREATE INDEX "Episode_sourceId_idx" ON "Episode"("sourceId" ASC);

-- CreateIndex
CREATE INDEX "Episode_transcriptStatus_idx" ON "Episode"("transcriptStatus" ASC);

-- CreateIndex
CREATE INDEX "Feed_userId_idx" ON "Feed"("userId" ASC);

-- CreateIndex
CREATE INDEX "FeedEntity_entityId_idx" ON "FeedEntity"("entityId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FeedEntity_feedId_entityId_key" ON "FeedEntity"("feedId" ASC, "entityId" ASC);

-- CreateIndex
CREATE INDEX "FeedEntity_feedId_idx" ON "FeedEntity"("feedId" ASC);

-- CreateIndex
CREATE INDEX "Source_platform_idx" ON "Source"("platform" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Source_slug_key" ON "Source"("slug" ASC);

-- CreateIndex
CREATE INDEX "Source_sourceType_idx" ON "Source"("sourceType" ASC);

-- CreateIndex
CREATE INDEX "Speaker_normalizedName_idx" ON "Speaker"("normalizedName" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Speaker_normalizedName_key" ON "Speaker"("normalizedName" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_chunkIndex_idx" ON "TranscriptChunk"("chunkIndex" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_convictionScore_idx" ON "TranscriptChunk"("convictionScore" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_createdAt_idx" ON "TranscriptChunk"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_episodeId_idx" ON "TranscriptChunk"("episodeId" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_importanceScore_idx" ON "TranscriptChunk"("importanceScore" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_noveltyScore_idx" ON "TranscriptChunk"("noveltyScore" ASC);

-- CreateIndex
CREATE INDEX "TranscriptChunk_speakerId_idx" ON "TranscriptChunk"("speakerId" ASC);

-- CreateIndex
CREATE INDEX "transcript_chunk_embedding_idx" ON "TranscriptChunk"("embedding" ASC);

-- AddForeignKey
ALTER TABLE "ChunkEntity" ADD CONSTRAINT "ChunkEntity_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "TranscriptChunk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChunkEntity" ADD CONSTRAINT "ChunkEntity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedEntity" ADD CONSTRAINT "FeedEntity_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedEntity" ADD CONSTRAINT "FeedEntity_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_speakerId_fkey" FOREIGN KEY ("speakerId") REFERENCES "Speaker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

