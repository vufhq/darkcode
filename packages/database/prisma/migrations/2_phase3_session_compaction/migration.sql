-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "compactionAt" TIMESTAMP(3),
ADD COLUMN     "compactionSummary" TEXT,
ADD COLUMN     "pinnedMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "workingMessages" JSONB NOT NULL DEFAULT '[]';
