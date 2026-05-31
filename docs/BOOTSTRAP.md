# Bootstrap Sequence

Follow these steps in exact order to initialize the project from scratch.

---

## Prerequisites

- Node.js 18+
- Docker (for local Postgres) OR a Supabase project URL
- An OpenAI API key

---

## Step 1 — Install dependencies

```bash
npm install
```

Key packages this project requires:

```bash
npm install @prisma/client prisma
npm install openai
npm install youtube-transcript
npm install js-tiktoken
npm install @anthropic-ai/sdk
```

---

## Step 2 — Configure environment

Copy `.env.example` to `.env.local` and fill in values:

```bash
cp .env.example .env.local
```

Required values before any other step:

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/podcast_intel"
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Step 3 — Start local Postgres with pgvector

If using Docker:

```bash
docker run -d \
  --name podcast-intel-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=podcast_intel \
  -p 5432:5432 \
  ankane/pgvector
```

> Note: Use `ankane/pgvector` image, not plain `postgres`. It includes the pgvector extension.

If using Supabase: skip this step. pgvector is available by default.

---

## Step 4 — Enable pgvector extension

Connect to your database and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

With Docker you can run:

```bash
docker exec -it podcast-intel-db psql -U postgres -d podcast_intel -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

---

## Step 5 — Run Prisma migration

```bash
npx prisma migrate dev --name init
```

This creates all tables and indexes.

After migration, create the HNSW vector index manually (Prisma cannot manage this):

```bash
npx prisma db execute --stdin <<EOF
CREATE INDEX IF NOT EXISTS transcript_chunk_embedding_idx
ON "TranscriptChunk"
USING hnsw (embedding vector_cosine_ops);
EOF
```

---

## Step 6 — Seed the database

```bash
npx prisma db seed
```

This creates:
- 3 initial Source records (All-In, Acquired, Dwarkesh)
- 1 test Episode (for ingestion dev/testing)
- 8 seed ticker Entity records (NVDA, TSLA, META, etc.)

---

## Step 7 — Start the dev server

```bash
npm run dev
```

App runs at `http://localhost:3000`

---

## Step 8 — Test the ingestion pipeline

Use the seed episode or a known good video URL:

```bash
curl -X POST http://localhost:3000/api/ingest/youtube \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrl": "https://www.youtube.com/watch?v=TbKMBR4k5_k",
    "sourceId": "<all-in-source-id-from-seed>"
  }'
```

Get the sourceId by running:

```bash
npx prisma studio
```

Or query directly:

```bash
docker exec -it podcast-intel-db psql -U postgres -d podcast_intel \
  -c "SELECT id, name FROM \"Source\";"
```

---

## Known Good Test Videos (captions verified)

Use these video IDs for ingestion testing. All have reliable auto-generated captions.

| Video ID | Source | Notes |
|---|---|---|
| `TbKMBR4k5_k` | All-In Podcast | E166, heavy NVDA/AI discussion |
| `oFfVt3S51T4` | Acquired | NVIDIA episode, dense financial content |
| `UTRmWPnOEpg` | Dwarkesh Podcast | Jensen Huang interview |

---

## package.json additions required

Add to `package.json`:

```json
{
  "prisma": {
    "seed": "ts-node --compiler-options {\"module\":\"CommonJS\"} prisma/seed.ts"
  }
}
```

And install `ts-node` if not present:

```bash
npm install -D ts-node
```
